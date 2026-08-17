import { Client as MinioClient } from "minio";
import { logError } from "@/lib/observability";

/** Instagram's `media_url`/`thumbnail_url` are short-lived, signed CDN URLs that expire (typically
 * within hours to a couple of days). To keep report thumbnails from silently breaking after sync,
 * we download each post's display image once and store our own permanent copy in MinIO, serving it
 * back through /api/media/[...key] instead of the raw Meta URL. */

function getConfig() {
  return {
    endPoint: process.env.MINIO_ENDPOINT || "localhost",
    port: Number(process.env.MINIO_PORT) || 9000,
    useSSL: process.env.MINIO_USE_SSL === "true",
    accessKey: process.env.MINIO_ACCESS_KEY || "",
    secretKey: process.env.MINIO_SECRET_KEY || "",
    bucket: process.env.MINIO_BUCKET || "kaan-reports",
  };
}

let client: MinioClient | null = null;
let bucketEnsured = false;

function getClient(): MinioClient | null {
  const config = getConfig();
  if (!config.accessKey || !config.secretKey) return null;
  if (!client) {
    client = new MinioClient({
      endPoint: config.endPoint,
      port: config.port,
      useSSL: config.useSSL,
      accessKey: config.accessKey,
      secretKey: config.secretKey,
    });
  }
  return client;
}

async function ensureBucket(minio: MinioClient, bucket: string) {
  if (bucketEnsured) return;
  const exists = await minio.bucketExists(bucket).catch(() => false);
  if (!exists) await minio.makeBucket(bucket);
  bucketEnsured = true;
}

/** The storage key used for a given post's persisted display image. */
export function mediaThumbnailKey(connectionId: string, externalPostId: string) {
  return `posts/${connectionId}/${externalPostId}.jpg`;
}

/** Public-facing URL our own UI/report should use to display a persisted thumbnail. */
export function mediaThumbnailUrl(key: string | null | undefined): string | null {
  return key ? `/api/media/${key}` : null;
}

/** Downloads `sourceUrl` and stores it permanently under `key`. Best-effort: any failure (network,
 * expired URL, MinIO unavailable/unconfigured) is logged and results in `null`, so callers can keep
 * falling back to the raw Meta URL rather than failing the whole sync. */
export async function persistMediaThumbnail(sourceUrl: string, key: string): Promise<string | null> {
  const minio = getClient();
  if (!minio) return null;
  const { bucket } = getConfig();
  try {
    const response = await fetch(sourceUrl);
    if (!response.ok) return null;
    const contentType = response.headers.get("content-type") ?? "image/jpeg";
    const buffer = Buffer.from(await response.arrayBuffer());
    await ensureBucket(minio, bucket);
    await minio.putObject(bucket, key, buffer, buffer.length, { "Content-Type": contentType });
    return key;
  } catch (error) {
    logError("media.thumbnail.persist_failed", error, { key });
    return null;
  }
}

/** Streams a previously persisted thumbnail back out, for the /api/media/[...key] route. */
export async function readMediaThumbnail(key: string): Promise<{ stream: NodeJS.ReadableStream; contentType: string } | null> {
  const minio = getClient();
  if (!minio) return null;
  const { bucket } = getConfig();
  try {
    const stat = await minio.statObject(bucket, key);
    const stream = await minio.getObject(bucket, key);
    const contentType = (stat.metaData?.["content-type"] as string | undefined) ?? "image/jpeg";
    return { stream, contentType };
  } catch {
    return null;
  }
}
