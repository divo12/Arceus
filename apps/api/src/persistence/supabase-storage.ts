import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { and, eq } from "drizzle-orm";
import { getDatabaseConnectionConfig, getDb, getSupabaseClient, isDatabaseConfigured, isSupabaseConfigured, assets as assetsTable } from "@arceus/db";
import * as companiesRepo from "@arceus/db/src/repos/companies.js";
import * as agentsRepo from "@arceus/db/src/repos/agents.js";
import { friendlyToUuid } from "@arceus/db/src/repos/_uuid.js";
import { persistenceConfig } from "../config/index.js";
import { resilientCall, breakers, isRetryableError } from "../infra/resilience.js";

interface UploadResult {
  assetId: string | null;
  objectKey: string;
  sha256: string;
  byteSize: number;
}

async function sha256ForBuffer(buffer: Buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function buildAssetId(companyId: string, namespace: string, objectKey: string) {
  const digest = createHash("sha256").update(`${companyId}:${namespace}:${objectKey}`).digest("hex");
  return `asset_${namespace}_${digest.slice(0, 24)}`;
}

async function upsertAssetRecord(params: {
  assetId: string;
  companyId: string;
  objectKey: string;
  contentType: string;
  byteSize: number;
  sha256: string;
  originalFilename: string | null;
  namespace: string;
  /**
   * Friendly agent id (e.g. `agent_developer_<uuid>`) or null. The
   * canonical schema renames this field from the legacy free-text
   * `created_by_agent` to a uuid FK `created_by_agent_id`.
   */
  createdByAgent: string | null;
}) {
  if (!isDatabaseConfigured()) {
    return null;
  }

  // Spec 31 Phase 7.B.6 — canonical PK / FKs are uuids. Friendly ids
  // map deterministically via uuidv5; the friendly form remains the
  // public identifier returned to callers.
  const dbId = friendlyToUuid(params.assetId);
  const dbCompanyId = companiesRepo.toDbId(params.companyId);
  const dbCreatedByAgentId = params.createdByAgent
    ? agentsRepo.toDbId(params.createdByAgent)
    : null;

  await getDb()
    .insert(assetsTable)
    .values({
      id: dbId,
      companyId: dbCompanyId,
      provider: "supabase",
      objectKey: params.objectKey,
      contentType: params.contentType,
      byteSize: params.byteSize,
      sha256: params.sha256,
      originalFilename: params.originalFilename,
      namespace: params.namespace,
      createdByAgentId: dbCreatedByAgentId,
      createdAt: new Date(),
    })
    .onConflictDoUpdate({
      target: assetsTable.id,
      set: {
        objectKey: params.objectKey,
        contentType: params.contentType,
        byteSize: params.byteSize,
        sha256: params.sha256,
        originalFilename: params.originalFilename,
        namespace: params.namespace,
        createdByAgentId: dbCreatedByAgentId,
      },
    });

  return params.assetId;
}

/** Whether Supabase storage is configured and available. */
export function isStorageConfigured() {
  return isSupabaseConfigured();
}

/** Health-check the Supabase REST and Storage endpoints. */
export async function getSupabaseEndpointHealth() {
  const config = getDatabaseConnectionConfig();
  if (!config) {
    return {
      configured: false,
      rest: { ok: false, statusCode: null, details: "Supabase not configured." },
      storage: { ok: false, statusCode: null, details: "Supabase not configured." },
    };
  }

  const headers = {
    apikey: config.supabaseServiceRoleKey,
    Authorization: `Bearer ${config.supabaseServiceRoleKey}`,
  };

  const checks = await Promise.allSettled([
    fetch(`${config.supabaseUrl.replace(/\/$/, "")}/rest/v1/`, { headers }),
    fetch(`${config.supabaseUrl.replace(/\/$/, "")}/storage/v1/bucket`, { headers }),
  ]);

  const [restResult, storageResult] = checks;

  return {
    configured: true,
    rest: restResult.status === "fulfilled"
      ? {
          ok: restResult.value.ok,
          statusCode: restResult.value.status,
          details: restResult.value.ok ? "REST endpoint reachable." : restResult.value.statusText,
        }
      : {
          ok: false,
          statusCode: null,
          details: restResult.reason instanceof Error ? restResult.reason.message : "REST endpoint failed.",
        },
    storage: storageResult.status === "fulfilled"
      ? {
          ok: storageResult.value.ok,
          statusCode: storageResult.value.status,
          details: storageResult.value.ok ? "Storage endpoint reachable." : storageResult.value.statusText,
        }
      : {
          ok: false,
          statusCode: null,
          details: storageResult.reason instanceof Error ? storageResult.reason.message : "Storage endpoint failed.",
        },
  };
}

/** Upload a local file to a Supabase storage bucket. */
async function uploadFileToBucket(bucket: string, objectKey: string, localFilePath: string, contentType: string) {
  if (!isSupabaseConfigured()) {
    throw new Error("Supabase storage is not configured.");
  }

  const buffer = await readFile(localFilePath);

  return resilientCall(
    async () => {
      const { error } = await getSupabaseClient().storage.from(bucket).upload(objectKey, buffer, {
        upsert: true,
        contentType,
      });

      if (error) {
        throw new Error(`Supabase upload failed for ${objectKey}: ${error.message}`);
      }

      return {
        assetId: null,
        objectKey,
        sha256: await sha256ForBuffer(buffer),
        byteSize: buffer.byteLength,
      } satisfies UploadResult;
    },
    { breaker: breakers.supabase, shouldRetry: isRetryableError },
  );
}

/** Download a file from a Supabase storage bucket to a local path. */
async function downloadFileFromBucket(bucket: string, objectKey: string, localFilePath: string) {
  if (!isSupabaseConfigured()) {
    throw new Error("Supabase storage is not configured.");
  }

  return resilientCall(
    async () => {
      const { data, error } = await getSupabaseClient().storage.from(bucket).download(objectKey);
      if (error || !data) {
        throw new Error(`Supabase download failed for ${objectKey}: ${error?.message ?? "Object missing"}`);
      }

      const buffer = Buffer.from(await data.arrayBuffer());
      await mkdir(dirname(localFilePath), { recursive: true });
      await writeFile(localFilePath, buffer);

      return {
        assetId: null,
        objectKey,
        sha256: await sha256ForBuffer(buffer),
        byteSize: buffer.byteLength,
      } satisfies UploadResult;
    },
    { breaker: breakers.supabase, shouldRetry: isRetryableError },
  );
}

/** Upload a workspace bundle to Supabase and record it as an asset. */
export async function uploadWorkspaceBundle(companyId: string, localFilePath: string, objectKey = `${companyId}/bundles/latest.bundle`) {
  const upload = await uploadFileToBucket(persistenceConfig.storage.workspaceBucket, objectKey, localFilePath, "application/octet-stream");
  const assetId = await upsertAssetRecord({
    assetId: buildAssetId(companyId, "workspace", objectKey),
    companyId,
    objectKey,
    contentType: "application/octet-stream",
    byteSize: upload.byteSize,
    sha256: upload.sha256,
    originalFilename: objectKey.split("/").pop() ?? "workspace.bundle",
    namespace: "workspace_bundles",
    createdByAgent: null,
  });

  return {
    ...upload,
    assetId,
  } satisfies UploadResult;
}

/** Download a workspace bundle from Supabase storage to a local path. */
export async function downloadWorkspaceBundle(objectKey: string, localFilePath: string) {
  return downloadFileFromBucket(persistenceConfig.storage.workspaceBucket, objectKey, localFilePath);
}

/** Upload artifact text content to Supabase and track it in the assets table. */
export async function uploadArtifactPayload(companyId: string, artifactId: string, content: string, title: string) {
  if (!isSupabaseConfigured()) {
    return null;
  }

  const objectKey = `${companyId}/artifacts/${artifactId}.txt`;
  const buffer = Buffer.from(content, "utf8");

  return resilientCall(
    async () => {
      const { error } = await getSupabaseClient().storage.from(persistenceConfig.storage.assetsBucket).upload(objectKey, buffer, {
        upsert: true,
        contentType: "text/plain; charset=utf-8",
      });

      if (error) {
        throw new Error(`Supabase artifact upload failed for ${objectKey}: ${error.message}`);
      }

      const sha256 = await sha256ForBuffer(buffer);
      const assetId = await upsertAssetRecord({
        assetId: `asset_${artifactId}`,
        companyId,
        objectKey,
        contentType: "text/plain; charset=utf-8",
        byteSize: buffer.byteLength,
        sha256,
        originalFilename: `${title}.txt`,
        namespace: "artifacts",
        createdByAgent: null,
      });

      return {
        assetId,
        objectKey,
        sha256,
        byteSize: buffer.byteLength,
      } satisfies UploadResult;
    },
    { breaker: breakers.supabase, shouldRetry: isRetryableError },
  );
}

/** Look up an asset record by company ID and object key. */
export async function getAssetRecordByObjectKey(companyId: string, objectKey: string) {
  if (!isDatabaseConfigured()) {
    return null;
  }

  // Spec 31 Phase 7.B.6 — company_id is a uuid FK on the canonical
  // assets table; map the friendly id before the equality check.
  const dbCompanyId = companiesRepo.toDbId(companyId);
  const rows = await getDb()
    .select()
    .from(assetsTable)
    .where(and(eq(assetsTable.companyId, dbCompanyId), eq(assetsTable.objectKey, objectKey)))
    .limit(1);

  return rows[0] ?? null;
}

/** Create a time-limited signed URL for a Supabase storage object. */
export async function createSignedBucketUrl(bucket: string, objectKey: string, expiresInSeconds = 3600) {
  if (!isSupabaseConfigured()) {
    throw new Error("Supabase storage is not configured.");
  }

  return resilientCall(
    async () => {
      const { data, error } = await getSupabaseClient().storage.from(bucket).createSignedUrl(objectKey, expiresInSeconds);
      if (error || !data) {
        throw new Error(`Supabase signed URL failed for ${objectKey}: ${error?.message ?? "Unknown error"}`);
      }

      return data.signedUrl;
    },
    { breaker: breakers.supabase, shouldRetry: isRetryableError },
  );
}

/** Get byte size and SHA-256 hash of a local file. */
export async function getLocalFileInfo(path: string) {
  const info = await stat(path);
  const buffer = await readFile(path);
  return {
    byteSize: info.size,
    sha256: await sha256ForBuffer(buffer),
  };
}