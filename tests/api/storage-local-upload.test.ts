import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertLocalUploadToken,
  assertTaskImageKeyMatchesContext,
  createTaskImageUploadUrl,
  deleteS3Object,
  getPrivateObject,
  writeLocalObject,
} from "../../apps/api/src/storage/s3";

const originalEnv = { ...process.env };
let uploadDir: string;

beforeEach(async () => {
  uploadDir = await mkdtemp(join(tmpdir(), "kaneo-local-upload-"));
  process.env = {
    ...originalEnv,
    AUTH_SECRET: "test-auth-secret-with-at-least-32-characters",
    KANEO_API_URL: "http://localhost:1337",
    LOCAL_UPLOAD_DIR: uploadDir,
    S3_ENDPOINT: "",
    S3_BUCKET: "",
    S3_ACCESS_KEY_ID: "",
    S3_SECRET_ACCESS_KEY: "",
  };
});

afterEach(async () => {
  process.env = { ...originalEnv };
  await rm(uploadDir, { recursive: true, force: true });
});

describe("local task asset uploads", () => {
  it("creates a signed local upload URL when S3 is not configured", async () => {
    const upload = await createTaskImageUploadUrl({
      workspaceId: "workspace-1",
      projectId: "project-1",
      taskId: "task-1",
      surface: "description",
      filename: "diagram.png",
      contentType: "image/png",
      size: 5,
    });

    const url = new URL(upload.uploadUrl);

    expect(upload.storage).toBe("local");
    expect(upload.key).toMatch(
      /^local\/workspace\/workspace-1\/project\/project-1\/task\/task-1\/descriptions\/diagram-/,
    );
    expect(`${url.origin}${url.pathname}`).toBe(
      "http://localhost:1337/api/task/image-upload-local/object",
    );
    expect(url.searchParams.get("key")).toBe(upload.key);

    assertLocalUploadToken({
      key: upload.key,
      expiresAt: Number(url.searchParams.get("expires")),
      contentType: url.searchParams.get("contentType") || "",
      size: Number(url.searchParams.get("size")),
      signature: url.searchParams.get("signature") || "",
    });

    expect(
      assertTaskImageKeyMatchesContext(upload.key, {
        workspaceId: "workspace-1",
        projectId: "project-1",
        taskId: "task-1",
        surface: "description",
      }),
    ).toBe(true);
  });

  it("does not fall back to local storage when partial S3 config is present", async () => {
    process.env.S3_KEY_PREFIX = "uploads";

    await expect(
      createTaskImageUploadUrl({
        workspaceId: "workspace-1",
        projectId: "project-1",
        taskId: "task-1",
        surface: "description",
        filename: "diagram.png",
        contentType: "image/png",
        size: 5,
      }),
    ).rejects.toThrow("S3 uploads are not configured");
  });

  it("stores, reads, and deletes a local object", async () => {
    const key =
      "local/workspace/workspace-1/project/project-1/task/task-1/descriptions/file.txt";

    await writeLocalObject({
      key,
      body: Buffer.from("hello"),
      contentType: "text/plain",
      size: 5,
    });

    const object = await getPrivateObject(key);

    expect(object.contentLength).toBe(5);
    expect(await new Response(object.body as BodyInit).text()).toBe("hello");

    await deleteS3Object(key);
    await expect(getPrivateObject(key)).rejects.toThrow();
  });

  it("rejects path traversal keys for local writes", async () => {
    await expect(
      writeLocalObject({
        key: "local/../outside.txt",
        body: Buffer.from("x"),
        contentType: "text/plain",
        size: 1,
      }),
    ).rejects.toThrow("Invalid local storage key.");
  });
});
