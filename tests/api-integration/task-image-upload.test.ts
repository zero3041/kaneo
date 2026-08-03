import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import db, { schema } from "../../apps/api/src/database";
import { createApp } from "../../apps/api/src/index";
import { signLocalUploadToken } from "../../apps/api/src/storage/s3";
import { mockAnonymousSession, mockAuthenticatedSession } from "./helpers/auth";
import { resetTestDatabase } from "./helpers/database";
import {
  createProjectFixture,
  createWorkspaceMember,
} from "./helpers/fixtures";

const s3ConfigKeys = [
  "S3_ENDPOINT",
  "S3_BUCKET",
  "S3_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY",
  "S3_REGION",
  "S3_PUBLIC_BASE_URL",
  "S3_KEY_PREFIX",
  "S3_FORCE_PATH_STYLE",
] as const;

function clearS3Config() {
  for (const key of s3ConfigKeys) {
    delete process.env[key];
  }
}

function createSignedLocalUploadUrl({
  key,
  contentType = "image/png",
  size = 5,
  expiresAt = Math.floor(Date.now() / 1000) + 300,
}: {
  key: string;
  contentType?: string;
  size?: number;
  expiresAt?: number;
}) {
  const params = new URLSearchParams({
    key,
    expires: expiresAt.toString(),
    contentType,
    size: size.toString(),
    signature: signLocalUploadToken({
      key,
      expiresAt,
      contentType,
      size,
    }),
  });

  return `/api/task/image-upload-local/object?${params.toString()}`;
}

describe("API integration: task image upload finalize", () => {
  beforeEach(async () => {
    await resetTestDatabase();

    process.env.S3_ENDPOINT = "https://storage.example.test";
    process.env.S3_BUCKET = "test-bucket";
    process.env.S3_ACCESS_KEY_ID = "test-access-key";
    process.env.S3_SECRET_ACCESS_KEY = "test-secret-key";
    delete process.env.S3_KEY_PREFIX;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns a URL using KANEO_API_URL", async () => {
    process.env.KANEO_API_URL = "http://kaneo.test:1337";

    const member = await createWorkspaceMember();
    const { project, columns } = await createProjectFixture({
      workspaceId: member.workspace.id,
    });

    const [task] = await db
      .insert(schema.taskTable)
      .values({
        projectId: project.id,
        userId: member.user.id,
        title: "URL test task",
        status: "to-do",
        columnId: columns.todo.id,
        priority: "medium",
        number: 1,
        position: 1,
      })
      .returning();

    mockAuthenticatedSession(member.user);
    const { app } = createApp();

    const key = `workspace/${member.workspace.id}/project/${project.id}/task/${task.id}/descriptions/test-image.png`;

    const response = await app.request(
      `/api/task/image-upload/${task.id}/finalize`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          key,
          filename: "test-image.png",
          contentType: "image/png",
          size: 12345,
          surface: "description",
        }),
      },
    );

    expect(response.status).toBe(200);
    const payload = (await response.json()) as { id: string; url: string };
    expect(payload).toHaveProperty("id");
    expect(payload).toHaveProperty("url");
    expect(payload.url).toBe(`http://kaneo.test:1337/api/asset/${payload.id}`);
    expect(payload.url).not.toContain("localhost");
  });

  it("updates the URL when KANEO_API_URL changes", async () => {
    process.env.KANEO_API_URL = "https://proxy.kaneo.internal";

    const member = await createWorkspaceMember();
    const { project, columns } = await createProjectFixture({
      workspaceId: member.workspace.id,
    });

    const [task] = await db
      .insert(schema.taskTable)
      .values({
        projectId: project.id,
        userId: member.user.id,
        title: "Proxy test",
        status: "to-do",
        columnId: columns.todo.id,
        priority: "medium",
        number: 1,
        position: 1,
      })
      .returning();

    mockAuthenticatedSession(member.user);
    const { app } = createApp();

    const key = `workspace/${member.workspace.id}/project/${project.id}/task/${task.id}/descriptions/proxy-image.png`;

    const response = await app.request(
      `/api/task/image-upload/${task.id}/finalize`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          key,
          filename: "proxy-image.png",
          contentType: "image/png",
          size: 99999,
          surface: "description",
        }),
      },
    );

    expect(response.status).toBe(200);
    const payload = (await response.json()) as { id: string; url: string };
    expect(payload.url).toBe(
      `https://proxy.kaneo.internal/api/asset/${payload.id}`,
    );
    expect(payload.url).not.toContain("localhost");
  });

  it("falls back to deriving URL from the request when KANEO_API_URL is not set", async () => {
    delete process.env.KANEO_API_URL;

    const member = await createWorkspaceMember();
    const { project, columns } = await createProjectFixture({
      workspaceId: member.workspace.id,
    });

    const [task] = await db
      .insert(schema.taskTable)
      .values({
        projectId: project.id,
        userId: member.user.id,
        title: "Fallback test",
        status: "to-do",
        columnId: columns.todo.id,
        priority: "medium",
        number: 1,
        position: 1,
      })
      .returning();

    mockAuthenticatedSession(member.user);
    const { app } = createApp();

    const key = `workspace/${member.workspace.id}/project/${project.id}/task/${task.id}/descriptions/fallback-image.png`;

    const response = await app.request(
      `https://app.kaneo.test/api/task/image-upload/${task.id}/finalize`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          key,
          filename: "fallback-image.png",
          contentType: "image/png",
          size: 12345,
          surface: "description",
        }),
      },
    );

    expect(response.status).toBe(200);
    const payload = (await response.json()) as { id: string; url: string };
    expect(payload.url).toBe(`https://app.kaneo.test/api/asset/${payload.id}`);
    expect(payload.url).not.toContain("localhost");
  });

  it("persists a new asset record with correct metadata", async () => {
    process.env.KANEO_API_URL = "http://localhost:1337";

    const member = await createWorkspaceMember();
    const { project, columns } = await createProjectFixture({
      workspaceId: member.workspace.id,
    });

    const [task] = await db
      .insert(schema.taskTable)
      .values({
        projectId: project.id,
        userId: member.user.id,
        title: "Persist test",
        status: "to-do",
        columnId: columns.todo.id,
        priority: "medium",
        number: 1,
        position: 1,
      })
      .returning();

    mockAuthenticatedSession(member.user);
    const { app } = createApp();

    const key = `workspace/${member.workspace.id}/project/${project.id}/task/${task.id}/descriptions/persist-asset.png`;

    const response = await app.request(
      `/api/task/image-upload/${task.id}/finalize`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          key,
          filename: "persist-asset.png",
          contentType: "image/png",
          size: 45678,
          surface: "description",
        }),
      },
    );

    expect(response.status).toBe(200);
    const payload = (await response.json()) as { id: string; url: string };

    const asset = await db.query.assetTable.findFirst({
      where: (t, { eq }) => eq(t.id, payload.id),
    });

    expect(asset).toBeDefined();
    expect(asset?.id).toBe(payload.id);
    expect(asset?.objectKey).toBe(key);
    expect(asset?.filename).toBe("persist-asset.png");
    expect(asset?.mimeType).toBe("image/png");
    expect(asset?.size).toBe(45678);
    expect(asset?.kind).toBe("image");
    expect(asset?.surface).toBe("description");
    expect(asset?.workspaceId).toBe(member.workspace.id);
    expect(asset?.projectId).toBe(project.id);
    expect(asset?.taskId).toBe(task.id);
    expect(asset?.createdBy).toBe(member.user.id);
  });

  it("creates attachment records for non-image content types", async () => {
    process.env.KANEO_API_URL = "http://localhost:1337";

    const member = await createWorkspaceMember();
    const { project, columns } = await createProjectFixture({
      workspaceId: member.workspace.id,
    });

    const [task] = await db
      .insert(schema.taskTable)
      .values({
        projectId: project.id,
        userId: member.user.id,
        title: "Attachment test",
        status: "to-do",
        columnId: columns.todo.id,
        priority: "medium",
        number: 1,
        position: 1,
      })
      .returning();

    mockAuthenticatedSession(member.user);
    const { app } = createApp();

    const key = `workspace/${member.workspace.id}/project/${project.id}/task/${task.id}/descriptions/report.pdf`;

    const response = await app.request(
      `/api/task/image-upload/${task.id}/finalize`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          key,
          filename: "report.pdf",
          contentType: "application/pdf",
          size: 102400,
          surface: "description",
        }),
      },
    );

    expect(response.status).toBe(200);
    const payload = (await response.json()) as { id: string; url: string };

    const asset = await db.query.assetTable.findFirst({
      where: (t, { eq }) => eq(t.id, payload.id),
    });
    expect(asset?.kind).toBe("attachment");
  });

  it("rejects key that does not match the task context", async () => {
    process.env.KANEO_API_URL = "http://localhost:1337";

    const member = await createWorkspaceMember();
    const { project, columns } = await createProjectFixture({
      workspaceId: member.workspace.id,
    });

    const [task] = await db
      .insert(schema.taskTable)
      .values({
        projectId: project.id,
        userId: member.user.id,
        title: "Bad key test",
        status: "to-do",
        columnId: columns.todo.id,
        priority: "medium",
        number: 1,
        position: 1,
      })
      .returning();

    mockAuthenticatedSession(member.user);
    const { app } = createApp();

    const response = await app.request(
      `/api/task/image-upload/${task.id}/finalize`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          key: "totally/wrong/path/image.png",
          filename: "test.png",
          contentType: "image/png",
          size: 100,
          surface: "description",
        }),
      },
    );

    expect(response.status).toBe(400);
    const text = await response.text();
    expect(text).toBe("Image upload key does not match the task context.");
  });

  it("rejects unauthenticated requests", async () => {
    process.env.KANEO_API_URL = "http://localhost:1337";

    const member = await createWorkspaceMember();
    const { project, columns } = await createProjectFixture({
      workspaceId: member.workspace.id,
    });

    const [task] = await db
      .insert(schema.taskTable)
      .values({
        projectId: project.id,
        userId: member.user.id,
        title: "Auth test",
        status: "to-do",
        columnId: columns.todo.id,
        priority: "medium",
        number: 1,
        position: 1,
      })
      .returning();

    mockAnonymousSession();
    const { app } = createApp();

    const response = await app.request(
      `/api/task/image-upload/${task.id}/finalize`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          key: "some/key.png",
          filename: "test.png",
          contentType: "image/png",
          size: 100,
          surface: "description",
        }),
      },
    );

    expect(response.status).toBe(401);
  });

  it("rejects requests from users outside the workspace", async () => {
    process.env.KANEO_API_URL = "http://localhost:1337";

    const member = await createWorkspaceMember();
    const outsiderId = `user-${randomUUID()}`;

    const [outsider] = await db
      .insert(schema.userTable)
      .values({
        id: outsiderId,
        email: `${outsiderId}@example.com`,
        emailVerified: true,
        name: "Outsider",
      })
      .returning();

    const { project, columns } = await createProjectFixture({
      workspaceId: member.workspace.id,
    });

    const [task] = await db
      .insert(schema.taskTable)
      .values({
        projectId: project.id,
        userId: member.user.id,
        title: "RBAC test",
        status: "to-do",
        columnId: columns.todo.id,
        priority: "medium",
        number: 1,
        position: 1,
      })
      .returning();

    mockAuthenticatedSession(outsider);
    const { app } = createApp();

    const response = await app.request(
      `/api/task/image-upload/${task.id}/finalize`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          key: `workspace/${member.workspace.id}/project/${project.id}/task/${task.id}/descriptions/rbac-test.png`,
          filename: "rbac-test.png",
          contentType: "image/png",
          size: 100,
          surface: "description",
        }),
      },
    );

    expect(response.status).toBe(403);
    await expect(response.text()).resolves.toBe(
      "You don't have access to this workspace",
    );
  });
});

describe("API integration: local task image upload endpoint", () => {
  let uploadDir: string;

  beforeEach(async () => {
    clearS3Config();
    uploadDir = await mkdtemp(join(tmpdir(), "kaneo-local-upload-"));
    process.env.AUTH_SECRET = "test-secret-with-at-least-32-chars";
    process.env.LOCAL_UPLOAD_DIR = uploadDir;
  });

  afterEach(async () => {
    await rm(uploadDir, { recursive: true, force: true });
    delete process.env.LOCAL_UPLOAD_DIR;
  });

  it("stores a signed local upload without an authenticated session", async () => {
    mockAnonymousSession();
    const { app } = createApp();
    const key =
      "local/workspace/workspace-1/project/project-1/task/task-1/descriptions/image.png";
    const response = await app.request(createSignedLocalUploadUrl({ key }), {
      method: "PUT",
      headers: { "content-type": "image/png" },
      body: "hello",
    });

    expect(response.status).toBe(204);
    await expect(readFile(join(uploadDir, key), "utf8")).resolves.toBe("hello");
  });

  it("rejects local uploads with a content type header mismatch", async () => {
    const { app } = createApp();
    const key =
      "local/workspace/workspace-1/project/project-1/task/task-1/descriptions/image.png";
    const response = await app.request(createSignedLocalUploadUrl({ key }), {
      method: "PUT",
      headers: { "content-type": "image/jpeg" },
      body: "hello",
    });

    expect(response.status).toBe(400);
    await expect(response.text()).resolves.toContain(
      "Upload content type does not match",
    );
  });

  it("rejects local uploads larger than the signed size", async () => {
    const { app } = createApp();
    const key =
      "local/workspace/workspace-1/project/project-1/task/task-1/descriptions/image.png";
    const response = await app.request(createSignedLocalUploadUrl({ key }), {
      method: "PUT",
      headers: { "content-type": "image/png" },
      body: "hello!",
    });

    expect(response.status).toBe(400);
    await expect(response.text()).resolves.toContain("Upload size exceeds");
  });

  it("rejects expired local upload URLs", async () => {
    const { app } = createApp();
    const key =
      "local/workspace/workspace-1/project/project-1/task/task-1/descriptions/image.png";
    const response = await app.request(
      createSignedLocalUploadUrl({
        key,
        expiresAt: Math.floor(Date.now() / 1000) - 1,
      }),
      {
        method: "PUT",
        headers: { "content-type": "image/png" },
        body: "hello",
      },
    );

    expect(response.status).toBe(403);
    await expect(response.text()).resolves.toContain("expired");
  });
});
