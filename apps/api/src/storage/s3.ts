import { createHmac, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { Readable } from "node:stream";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { createId } from "@paralleldrive/cuid2";
import { config } from "dotenv-mono";
import { normalizeApiServerUrl } from "../utils/openapi-spec";

config();

const DEFAULT_MAX_IMAGE_UPLOAD_BYTES = 10 * 1024 * 1024;
const DEFAULT_PRESIGN_TTL_SECONDS = 300;
const DEFAULT_LOCAL_UPLOAD_DIR = "data/uploads";
const LOCAL_OBJECT_KEY_PREFIX = "local";
const S3_CONFIG_SIGNAL_ENV_NAMES = [
  "S3_ENDPOINT",
  "S3_BUCKET",
  "S3_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY",
  "S3_REGION",
  "S3_PUBLIC_BASE_URL",
  "S3_KEY_PREFIX",
  "S3_FORCE_PATH_STYLE",
] as const;

const allowedImageMimeTypes = new Set([
  "image/apng",
  "image/avif",
  "image/gif",
  "image/heic",
  "image/heif",
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
]);

export function isImageContentType(contentType: string) {
  return allowedImageMimeTypes.has(contentType.toLowerCase());
}

type UploadSurface = "description" | "comment";

type StorageConfig = {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  publicBaseUrl?: string;
  keyPrefix: string;
  forcePathStyle: boolean;
  maxImageUploadBytes: number;
  presignTtlSeconds: number;
};

type LocalStorageConfig = {
  rootDir: string;
  presignTtlSeconds: number;
};

type TaskImageUploadContext = {
  workspaceId: string;
  projectId: string;
  taskId: string;
  surface: UploadSurface;
  filename: string;
  contentType: string;
  size: number;
};

type TaskImageUploadUrl = {
  key: string;
  uploadUrl: string;
  headers: Record<string, string>;
  storage: "s3" | "local";
};

type TaskImageKeyContext = Omit<
  TaskImageUploadContext,
  "filename" | "contentType" | "size"
>;

type LocalUploadTokenPayload = {
  key: string;
  expiresAt: number;
  contentType: string;
  size: number;
};

type LocalUploadTokenInput = LocalUploadTokenPayload & {
  signature: string;
};

type AssetObject = {
  body: unknown;
  contentType: string | undefined;
  contentLength: number | undefined;
  etag: string | undefined;
  lastModified: Date | undefined;
};

let clientCache:
  | {
      cacheKey: string;
      client: S3Client;
    }
  | undefined;

function env(name: string) {
  return process.env[name]?.trim() || "";
}

function hasS3ConfigSignal() {
  return S3_CONFIG_SIGNAL_ENV_NAMES.some((name) => Boolean(env(name)));
}

function isS3StorageConfigured() {
  return Boolean(env("S3_ENDPOINT") && env("S3_BUCKET"));
}

export function parseBoolean(value: string | undefined, fallback: boolean) {
  if (value === undefined || value.trim() === "") return fallback;
  return value.trim().toLowerCase() === "true";
}

export function parsePositiveInt(value: string | undefined, fallback: number) {
  const parsed = Number.parseInt(value?.trim() || "", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

/**
 * Resolves static S3 credentials from the access key pair.
 *
 * Returns the explicit credentials only when BOTH the access key id and secret
 * are provided. When neither is set, returns `undefined` so the AWS SDK falls
 * back to its default credential provider chain (EC2 instance profile, ECS task
 * role, EKS IRSA, environment variables, or shared config) — enabling
 * IAM-role-based access without static keys.
 *
 * Throws when exactly one of the two is set, since that is almost always a
 * misconfiguration rather than an intentional fallback.
 */
export function resolveS3Credentials(
  accessKeyId: string,
  secretAccessKey: string,
): { accessKeyId: string; secretAccessKey: string } | undefined {
  const hasAccessKeyId = Boolean(accessKeyId);
  const hasSecretAccessKey = Boolean(secretAccessKey);

  if (hasAccessKeyId !== hasSecretAccessKey) {
    throw new Error(
      "Incomplete S3 credentials. Set both S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY, or neither to use the default AWS credential provider chain (IAM role / IRSA / environment).",
    );
  }

  if (hasAccessKeyId && hasSecretAccessKey) {
    return { accessKeyId, secretAccessKey };
  }

  return undefined;
}

function getStorageConfig(): StorageConfig {
  const endpoint = env("S3_ENDPOINT");
  const bucket = env("S3_BUCKET");
  const accessKeyId = env("S3_ACCESS_KEY_ID");
  const secretAccessKey = env("S3_SECRET_ACCESS_KEY");

  if (!endpoint || !bucket) {
    throw new Error(
      "S3 uploads are not configured. Set S3_ENDPOINT and S3_BUCKET (and either both S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY, or neither to use the default AWS credential provider chain / IAM role).",
    );
  }

  // Validate the access key pair early so misconfiguration surfaces here rather
  // than as an opaque signing error later.
  resolveS3Credentials(accessKeyId, secretAccessKey);

  return {
    endpoint,
    region: env("S3_REGION") || "us-east-1",
    bucket,
    accessKeyId,
    secretAccessKey,
    publicBaseUrl: env("S3_PUBLIC_BASE_URL") || undefined,
    keyPrefix: env("S3_KEY_PREFIX"),
    forcePathStyle: parseBoolean(process.env.S3_FORCE_PATH_STYLE, true),
    maxImageUploadBytes: parsePositiveInt(
      process.env.S3_MAX_IMAGE_UPLOAD_BYTES,
      DEFAULT_MAX_IMAGE_UPLOAD_BYTES,
    ),
    presignTtlSeconds: parsePositiveInt(
      process.env.S3_PRESIGN_TTL_SECONDS,
      DEFAULT_PRESIGN_TTL_SECONDS,
    ),
  };
}

function getLocalStorageConfig(): LocalStorageConfig {
  return {
    rootDir: resolve(env("LOCAL_UPLOAD_DIR") || DEFAULT_LOCAL_UPLOAD_DIR),
    presignTtlSeconds: parsePositiveInt(
      process.env.S3_PRESIGN_TTL_SECONDS,
      DEFAULT_PRESIGN_TTL_SECONDS,
    ),
  };
}

function getMaxImageUploadBytes() {
  return parsePositiveInt(
    process.env.S3_MAX_IMAGE_UPLOAD_BYTES,
    DEFAULT_MAX_IMAGE_UPLOAD_BYTES,
  );
}

function getClient(config: StorageConfig) {
  const cacheKey = JSON.stringify({
    endpoint: config.endpoint,
    region: config.region,
    accessKeyId: config.accessKeyId,
    bucket: config.bucket,
    forcePathStyle: config.forcePathStyle,
  });

  if (clientCache?.cacheKey === cacheKey) {
    return clientCache.client;
  }

  const clientConfig: S3ClientConfig = {
    endpoint: config.endpoint,
    region: config.region,
    forcePathStyle: config.forcePathStyle,
    // Avoid auto-injecting checksum params for presigned PUT URLs. Some
    // S3-compatible providers (e.g. Garage/R2) reject mismatched hoisted CRCs.
    requestChecksumCalculation: "WHEN_REQUIRED",
  };

  const credentials = resolveS3Credentials(
    config.accessKeyId,
    config.secretAccessKey,
  );

  // Only pin explicit credentials when both keys are provided. Otherwise leave
  // `credentials` unset so the AWS SDK resolves them from its default provider
  // chain (EC2 instance profile, ECS task role, EKS IRSA, env, shared config),
  // which is how IAM-role-based access works.
  if (credentials) {
    clientConfig.credentials = credentials;
  }

  const client = new S3Client(clientConfig);
  clientCache = { cacheKey, client };
  return client;
}

export function sanitizePathSegment(value: string) {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/-{2,}/g, "-")
      .replace(/^-+|-+$/g, "") || "file"
  );
}

export function getFileExtension(filename: string) {
  const normalized = filename.trim();
  const extension = normalized.includes(".")
    ? normalized.split(".").pop() || ""
    : "";

  return sanitizePathSegment(extension).slice(0, 12);
}

export function buildObjectKeyPrefix(context: TaskImageKeyContext) {
  const surfaceFolder =
    context.surface === "comment" ? "comments" : "descriptions";

  return [
    "workspace",
    sanitizePathSegment(context.workspaceId),
    "project",
    sanitizePathSegment(context.projectId),
    "task",
    sanitizePathSegment(context.taskId),
    surfaceFolder,
  ].join("/");
}

export function buildObjectKey(context: TaskImageUploadContext) {
  const extension = getFileExtension(context.filename);
  const objectKeyPrefix = buildObjectKeyPrefix(context);
  const timestamp = Date.now();
  const randomId = createId();

  const baseName = sanitizePathSegment(
    context.filename.replace(/\.[^/.]+$/, "") || "image",
  ).slice(0, 64);

  const fileName = extension
    ? `${baseName}-${timestamp}-${randomId}.${extension}`
    : `${baseName}-${timestamp}-${randomId}`;

  return `${objectKeyPrefix}/${fileName}`;
}

function buildLocalObjectKey(rawKey: string) {
  return `${LOCAL_OBJECT_KEY_PREFIX}/${rawKey}`;
}

function isLocalObjectKey(key: string) {
  const normalized = key.trim().replace(/^\/+/, "");
  return normalized.startsWith(`${LOCAL_OBJECT_KEY_PREFIX}/`);
}

export function applyKeyPrefix(prefix: string, key: string) {
  if (!prefix) return key;
  const trimmed = prefix.replace(/\/+$/, "");
  return `${trimmed}/${key}`;
}

export function validateTaskAssetUploadInput(
  contentType: string,
  size: number,
) {
  const maxImageUploadBytes = getMaxImageUploadBytes();

  if (!contentType.trim()) {
    throw new Error("A valid content type is required.");
  }

  if (size <= 0) {
    throw new Error("Upload size must be greater than zero.");
  }

  if (size > maxImageUploadBytes) {
    throw new Error(
      `Upload exceeds the maximum upload size of ${Math.floor(maxImageUploadBytes / (1024 * 1024))}MB.`,
    );
  }
}

function getLocalUploadSigningSecret() {
  const secret = env("LOCAL_UPLOAD_SECRET") || env("AUTH_SECRET");

  if (!secret) {
    throw new Error(
      "Local uploads require AUTH_SECRET or LOCAL_UPLOAD_SECRET to sign upload URLs.",
    );
  }

  return secret;
}

function getLocalUploadSignaturePayload(payload: LocalUploadTokenPayload) {
  return [
    payload.key,
    payload.expiresAt.toString(),
    payload.contentType,
    payload.size.toString(),
  ].join("\n");
}

export function signLocalUploadToken(payload: LocalUploadTokenPayload) {
  return createHmac("sha256", getLocalUploadSigningSecret())
    .update(getLocalUploadSignaturePayload(payload))
    .digest("hex");
}

function timingSafeHexEqual(left: string, right: string) {
  try {
    const leftBuffer = Buffer.from(left, "hex");
    const rightBuffer = Buffer.from(right, "hex");

    if (leftBuffer.length !== rightBuffer.length) {
      return false;
    }

    return timingSafeEqual(leftBuffer, rightBuffer);
  } catch {
    return false;
  }
}

function createLocalUploadUrl(payload: LocalUploadTokenPayload) {
  const signature = signLocalUploadToken(payload);
  const apiBaseUrl = normalizeApiServerUrl(
    env("KANEO_API_URL") ||
      (env("KANEO_CLIENT_URL") ? `${env("KANEO_CLIENT_URL")}/api` : ""),
  );
  const params = new URLSearchParams({
    key: payload.key,
    expires: payload.expiresAt.toString(),
    contentType: payload.contentType,
    size: payload.size.toString(),
    signature,
  });

  return `${apiBaseUrl}/task/image-upload-local/object?${params.toString()}`;
}

export function assertLocalUploadToken(input: LocalUploadTokenInput) {
  if (!Number.isFinite(input.expiresAt) || input.expiresAt <= 0) {
    throw new Error("Invalid local upload expiration.");
  }

  if (input.expiresAt < Math.floor(Date.now() / 1000)) {
    throw new Error("Local upload URL has expired.");
  }

  const expectedSignature = signLocalUploadToken({
    key: input.key,
    expiresAt: input.expiresAt,
    contentType: input.contentType,
    size: input.size,
  });

  if (!timingSafeHexEqual(expectedSignature, input.signature)) {
    throw new Error("Invalid local upload signature.");
  }
}

function resolveLocalObjectPath(key: string) {
  const normalizedKey = key.trim().replace(/^\/+/, "");

  if (
    !isLocalObjectKey(normalizedKey) ||
    normalizedKey.includes("\\") ||
    normalizedKey.split("/").some((segment) => segment === "..")
  ) {
    throw new Error("Invalid local storage key.");
  }

  const { rootDir } = getLocalStorageConfig();
  const filePath = resolve(rootDir, normalizedKey);
  const relativePath = relative(rootDir, filePath);

  if (
    !relativePath ||
    relativePath.startsWith("..") ||
    isAbsolute(relativePath)
  ) {
    throw new Error("Invalid local storage key.");
  }

  return filePath;
}

export async function writeLocalObject({
  key,
  body,
  contentType,
  size,
}: {
  key: string;
  body: Buffer;
  contentType: string;
  size: number;
}) {
  validateTaskAssetUploadInput(contentType, size);

  if (body.byteLength !== size) {
    throw new Error("Upload size does not match the signed upload request.");
  }

  const filePath = resolveLocalObjectPath(key);
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, body);
}

export async function createTaskImageUploadUrl(
  context: TaskImageUploadContext,
): Promise<TaskImageUploadUrl> {
  const rawKey = buildObjectKey(context);

  if (!hasS3ConfigSignal()) {
    const config = getLocalStorageConfig();
    const key = buildLocalObjectKey(rawKey);
    const expiresAt = Math.floor(Date.now() / 1000) + config.presignTtlSeconds;

    return {
      key,
      uploadUrl: createLocalUploadUrl({
        key,
        expiresAt,
        contentType: context.contentType,
        size: context.size,
      }),
      headers: {
        "Content-Type": context.contentType,
      },
      storage: "local",
    };
  }

  const config = getStorageConfig();
  const client = getClient(config);
  const key = applyKeyPrefix(config.keyPrefix, rawKey);

  const command = new PutObjectCommand({
    Bucket: config.bucket,
    Key: key,
    ContentType: context.contentType,
  });

  const uploadUrl = await getSignedUrl(client, command, {
    expiresIn: config.presignTtlSeconds,
  });

  return {
    key,
    uploadUrl,
    headers: {
      "Content-Type": context.contentType,
    },
    storage: "s3",
  };
}

export function assertStorageConfigured() {
  return getStorageConfig();
}

export function assertTaskImageKeyMatchesContext(
  key: string,
  context: TaskImageKeyContext,
) {
  if (isLocalObjectKey(key)) {
    const objectPrefix = buildObjectKeyPrefix(context);
    return key.startsWith(`${buildLocalObjectKey(objectPrefix)}/`);
  }

  if (!isS3StorageConfigured()) {
    return false;
  }

  const config = getStorageConfig();
  const objectPrefix = buildObjectKeyPrefix(context);
  const fullPrefix = `${applyKeyPrefix(config.keyPrefix, objectPrefix)}/`;
  return key.startsWith(fullPrefix);
}

async function getLocalObject(key: string): Promise<AssetObject> {
  const filePath = resolveLocalObjectPath(key);
  const fileStat = await stat(filePath);

  return {
    body: Readable.toWeb(createReadStream(filePath)),
    contentType: undefined,
    contentLength: fileStat.size,
    etag: `W/"${fileStat.size}-${Math.floor(fileStat.mtimeMs)}"`,
    lastModified: fileStat.mtime,
  };
}

export async function getPrivateObject(key: string): Promise<AssetObject> {
  if (isLocalObjectKey(key)) {
    return getLocalObject(key);
  }

  const config = getStorageConfig();
  const client = getClient(config);
  const response = await client.send(
    new GetObjectCommand({
      Bucket: config.bucket,
      Key: key,
    }),
  );

  if (!response.Body) {
    throw new Error("Storage object body is missing.");
  }

  const body =
    "transformToWebStream" in response.Body
      ? response.Body.transformToWebStream()
      : Readable.toWeb(response.Body as Readable);

  return {
    body,
    contentType: response.ContentType,
    contentLength: response.ContentLength,
    etag: response.ETag,
    lastModified: response.LastModified,
  };
}

export async function deleteS3Object(key: string): Promise<void> {
  if (isLocalObjectKey(key)) {
    try {
      await unlink(resolveLocalObjectPath(key));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
    return;
  }

  const config = getStorageConfig();
  const client = getClient(config);
  await client.send(
    new DeleteObjectCommand({
      Bucket: config.bucket,
      Key: key,
    }),
  );
}
