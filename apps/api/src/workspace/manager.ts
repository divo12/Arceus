import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { CompanySnapshot, ExportResult, SprintSnapshot, WorkspaceFileManifestEntry, WorkspaceInfo } from "@arceus/contracts";
import { getDb, isDatabaseConfigured, sprintSnapshots as sprintSnapshotsTable, workspaces as workspacesTable } from "@arceus/db";
import * as companiesRepo from "@arceus/db/src/repos/companies.js";
import { friendlyToUuid } from "@arceus/db/src/repos/_uuid.js";
import { eq } from "drizzle-orm";
import { persistenceConfig } from "../config/index.js";
import { cloneWorkspaceFromBundle, commitAllChanges, createBundleFromWorkspace, diffWorkspaceRefs, ensureGitRepository, getHeadSha, tagWorkspace } from "./git-ops.js";
import { createSignedBucketUrl, downloadWorkspaceBundle, getAssetRecordByObjectKey, getLocalFileInfo, isStorageConfigured, uploadWorkspaceBundle } from "../persistence/supabase-storage.js";

type WorkspaceOperationResult = {
  workspace: WorkspaceInfo;
  warnings: string[];
};

type WorkspaceFileEntry = {
  path: string;
  modifiedAt: string;
};

type WorkspaceManifestEntry = WorkspaceFileManifestEntry;

const repoRoot = resolve(process.cwd(), "..", "..");
// In Docker /app is cwd, repoRoot resolves to "/" — use cwd-relative instead
const legacyProductDir = existsSync(resolve(repoRoot, "workspace")) || !process.cwd().startsWith("/app")
  ? resolve(repoRoot, "workspace")
  : resolve(process.cwd(), "workspace");
const legacyApiWorkspaceDir = resolve(repoRoot, "apps", "api", "workspace");
const fallbackWorkspaceState = new Map<string, WorkspaceInfo>();
const fallbackSprintSnapshots = new Map<string, SprintSnapshot[]>();

function buildWorkspaceId(companyId: string) {
  return `workspace_${companyId}`;
}

function getCompanyCachePath(companyId: string) {
  return resolve(persistenceConfig.workspace.root, companyId);
}

function toIsoString(value: Date | string | null | undefined) {
  if (!value) {
    return null;
  }

  return value instanceof Date ? value.toISOString() : value;
}

async function pathExists(path: string) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function ensureLegacyWorkspaceDir() {
  await mkdir(legacyProductDir, { recursive: true });
  await writeFile(resolve(legacyProductDir, ".gitkeep"), "", { flag: "a" });
}

async function listWorkspaceManifest(dir: string, base: string): Promise<WorkspaceManifestEntry[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const results: WorkspaceManifestEntry[] = [];

  for (const entry of entries) {
    const fullPath = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      if (WORKSPACE_IGNORE_DIRS.has(entry.name) || entry.name.startsWith(".")) {
        continue;
      }
      results.push(...await listWorkspaceManifest(fullPath, base));
      continue;
    }

    if (entry.name === ".gitkeep") {
      continue;
    }

    const info = await stat(fullPath);
    results.push({
      path: fullPath.replace(`${base}\\`, "").replace(/\\/g, "/"),
      size: info.size,
    });
  }

  return results.sort((left, right) => left.path.localeCompare(right.path));
}

function buildWorkspaceInfo(companyId: string, overrides: Partial<WorkspaceInfo> = {}): WorkspaceInfo {
  const now = new Date().toISOString();

  return {
    id: buildWorkspaceId(companyId),
    companyId,
    localPath: legacyProductDir,
    status: "active",
    latestBundleKey: null,
    latestBundleSha256: null,
    latestBundleBytes: null,
    currentSprintNumber: 0,
    currentGitRef: null,
    lastSyncedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function mapWorkspaceRecord(
  record: typeof workspacesTable.$inferSelect,
  friendlyCompanyId: string,
): WorkspaceInfo {
  // Spec 31 Phase 7.B.6 — canonical PK / company_id are uuids, but the
  // contract / consumers think in friendly ids. Surface the friendly
  // workspace id (always derivable from the friendly companyId) and
  // the friendly companyId (passed in by the caller from
  // getActiveCompanyId()).
  return {
    id: buildWorkspaceId(friendlyCompanyId),
    companyId: friendlyCompanyId,
    localPath: record.localPath,
    status: record.status as WorkspaceInfo["status"],
    latestBundleKey: record.latestBundleKey,
    latestBundleSha256: record.latestBundleSha256,
    latestBundleBytes: record.latestBundleBytes,
    currentSprintNumber: record.currentSprintNumber,
    currentGitRef: record.currentGitRef,
    lastSyncedAt: toIsoString(record.lastSyncedAt),
    createdAt: toIsoString(record.createdAt) ?? new Date().toISOString(),
    updatedAt: toIsoString(record.updatedAt) ?? new Date().toISOString(),
  };
}

function mapSprintSnapshotRecord(
  record: typeof sprintSnapshotsTable.$inferSelect,
  friendlyCompanyId: string,
): SprintSnapshot {
  // Spec 31 Phase 7.B.7 — surface the friendly snapshot id /
  // companyId; the canonical row stores uuid forms.
  return {
    id: `snapshot_${friendlyCompanyId}_${record.sprintNumber}`,
    companyId: friendlyCompanyId,
    sprintNumber: record.sprintNumber,
    gitTag: record.gitTag,
    bundleKey: record.bundleKey,
    bundleSha256: record.bundleSha256,
    bundleBytes: record.bundleBytes,
    snapshotData: record.snapshotData as unknown as CompanySnapshot,
    // The canonical schema's typed jsonb (`{path; sha256; bytes}`) and the
    // contract's `WorkspaceFileManifestEntry` (`{path; size}`) both
    // round-trip through the same physical jsonb column; cast through
    // unknown.
    fileManifest: record.fileManifest as unknown as WorkspaceManifestEntry[],
    status: record.status as SprintSnapshot["status"],
    createdAt: toIsoString(record.createdAt) ?? new Date().toISOString(),
  };
}

async function persistWorkspaceInfo(workspace: WorkspaceInfo) {
  fallbackWorkspaceState.set(workspace.companyId, workspace);

  if (!isDatabaseConfigured()) {
    return workspace;
  }

  // Spec 31 Phase 7.B.6 — canonical schema uses uuid PK / company FK.
  // Friendly ids (`workspace_company_<uuid>`, `company_<uuid>`) are
  // hashed via uuidv5 to land on stable canonical rows.
  const dbId = friendlyToUuid(workspace.id);
  const dbCompanyId = companiesRepo.toDbId(workspace.companyId);

  await getDb()
    .insert(workspacesTable)
    .values({
      id: dbId,
      companyId: dbCompanyId,
      localPath: workspace.localPath,
      status: workspace.status,
      latestBundleKey: workspace.latestBundleKey,
      latestBundleSha256: workspace.latestBundleSha256,
      latestBundleBytes: workspace.latestBundleBytes,
      currentSprintNumber: workspace.currentSprintNumber,
      currentGitRef: workspace.currentGitRef,
      lastSyncedAt: workspace.lastSyncedAt ? new Date(workspace.lastSyncedAt) : null,
      createdAt: new Date(workspace.createdAt),
      updatedAt: new Date(workspace.updatedAt),
    })
    .onConflictDoUpdate({
      target: workspacesTable.id,
      set: {
        companyId: dbCompanyId,
        localPath: workspace.localPath,
        status: workspace.status,
        latestBundleKey: workspace.latestBundleKey,
        latestBundleSha256: workspace.latestBundleSha256,
        latestBundleBytes: workspace.latestBundleBytes,
        currentSprintNumber: workspace.currentSprintNumber,
        currentGitRef: workspace.currentGitRef,
        lastSyncedAt: workspace.lastSyncedAt ? new Date(workspace.lastSyncedAt) : null,
        updatedAt: new Date(workspace.updatedAt),
      },
    });

  return workspace;
}

async function persistWorkspaceInfoSafely(workspace: WorkspaceInfo, warnings: string[]) {
  try {
    return await persistWorkspaceInfo(workspace);
  } catch (error) {
    warnings.push(`workspace metadata persistence failed: ${error instanceof Error ? error.message : "Unknown database error"}`);
    return workspace;
  }
}

async function loadWorkspaceInfo(companyId: string) {
  if (!isDatabaseConfigured()) {
    return fallbackWorkspaceState.get(companyId) ?? null;
  }

  try {
    // Spec 31 Phase 7.B.6 — query by company_id (uuid FK, unique index)
    // instead of fetching all rows and filtering by friendly id. Same
    // O(1) lookup, but goes through the canonical PK/index path.
    const dbCompanyId = companiesRepo.toDbId(companyId);
    const [record] = await getDb()
      .select()
      .from(workspacesTable)
      .where(eq(workspacesTable.companyId, dbCompanyId))
      .limit(1);
    return record ? mapWorkspaceRecord(record, companyId) : fallbackWorkspaceState.get(companyId) ?? null;
  } catch {
    return fallbackWorkspaceState.get(companyId) ?? null;
  }
}

const WORKSPACE_IGNORE_DIRS = new Set([
  "node_modules", ".git", ".next", "dist", ".turbo", ".cache",
  ".vite", "coverage", "__pycache__", ".svelte-kit", ".output",
  "build", ".parcel-cache", ".nuxt",
]);

async function listWorkspaceFiles(dir: string, base: string): Promise<WorkspaceFileEntry[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const results: WorkspaceFileEntry[] = [];

  for (const entry of entries) {
    const fullPath = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      if (WORKSPACE_IGNORE_DIRS.has(entry.name) || entry.name.startsWith(".")) {
        continue;
      }
      results.push(...await listWorkspaceFiles(fullPath, base));
      continue;
    }

    if (entry.name === ".gitkeep") {
      continue;
    }

    const info = await stat(fullPath);
    results.push({
      path: fullPath.replace(`${base}\\`, "").replace(/\\/g, "/"),
      modifiedAt: info.mtime.toISOString(),
    });
  }

  return results.sort((left, right) => right.modifiedAt.localeCompare(left.modifiedAt));
}

/**
 * Manages the product workspace lifecycle — provisioning, git commit/sync,
 * sprint snapshots, bundle export, and archive/cleanup.
 */
export class WorkspaceManager {
  /** Return the legacy workspace directory path. */
  getLegacyProductDir() {
    return legacyProductDir;
  }

  /** Resolve the local filesystem path for a company's workspace. */
  getLocalPath(_companyId: string) {
    return legacyProductDir;
  }

  /** Alias for `get()` — retrieve workspace metadata for a company. */
  async getWorkspaceInfo(companyId: string) {
    return this.get(companyId);
  }

  /** Load persisted workspace info, falling back to in-memory state. */
  async get(companyId: string) {
    const persisted = await loadWorkspaceInfo(companyId);
    if (persisted) {
      return persisted;
    }

    if (await pathExists(legacyProductDir)) {
      return buildWorkspaceInfo(companyId, { localPath: legacyProductDir });
    }

    return null;
  }

  /** Create and initialise the workspace directory and git repo for a company. */
  async provision(companyId: string): Promise<WorkspaceOperationResult> {
    const warnings: string[] = [];
    await ensureLegacyWorkspaceDir();
    await mkdir(persistenceConfig.workspace.root, { recursive: true });
    await mkdir(getCompanyCachePath(companyId), { recursive: true });
    await ensureGitRepository(legacyProductDir);

    const existing = await this.get(companyId);
    const workspace = buildWorkspaceInfo(companyId, {
      ...existing,
      localPath: legacyProductDir,
      status: "active",
      createdAt: existing?.createdAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    return {
      workspace: await persistWorkspaceInfoSafely(workspace, warnings),
      warnings,
    };
  }

  /** Ensure the workspace exists locally, restoring from a bundle if needed. */
  async ensureLocal(companyId: string) {
    const warnings: string[] = [];
    const existing = (await this.get(companyId)) ?? buildWorkspaceInfo(companyId);

    await ensureLegacyWorkspaceDir();
    await mkdir(getCompanyCachePath(companyId), { recursive: true });

    if (!(await pathExists(resolve(legacyProductDir, ".git"))) && existing.latestBundleKey && isStorageConfigured()) {
      const bundlePath = resolve(getCompanyCachePath(companyId), "latest.bundle");
      try {
        await downloadWorkspaceBundle(existing.latestBundleKey, bundlePath);
        await cloneWorkspaceFromBundle(bundlePath, legacyProductDir);
      } catch (error) {
        warnings.push(`workspace restore failed: ${error instanceof Error ? error.message : "Unknown restore error"}`);
      }
    }

    await ensureGitRepository(legacyProductDir);
    await persistWorkspaceInfoSafely(buildWorkspaceInfo(companyId, {
      ...existing,
      localPath: legacyProductDir,
      status: "active",
      updatedAt: new Date().toISOString(),
    }), warnings);

    return legacyProductDir;
  }

  /** Commit all workspace changes and upload the bundle to remote storage. */
  async commitAndSync(companyId: string, taskId: string, agentRole: string, message: string) {
    const warnings: string[] = [];
    const localPath = await this.ensureLocal(companyId);
    const commitSha = await commitAllChanges(localPath, `[${taskId}] ${message} (${agentRole})`);
    const bundlePath = await createBundleFromWorkspace(localPath, resolve(getCompanyCachePath(companyId), "latest.bundle"));
    const existing = (await this.get(companyId)) ?? buildWorkspaceInfo(companyId);

    let latestBundleKey = existing.latestBundleKey;
    let latestBundleSha256 = existing.latestBundleSha256;
    let latestBundleBytes = existing.latestBundleBytes;
    let lastSyncedAt = existing.lastSyncedAt;

    if (isStorageConfigured()) {
      try {
        const upload = await uploadWorkspaceBundle(companyId, bundlePath, `${companyId}/bundles/latest.bundle`);
        latestBundleKey = upload.objectKey;
        latestBundleSha256 = upload.sha256;
        latestBundleBytes = upload.byteSize;
        lastSyncedAt = new Date().toISOString();
      } catch (error) {
        warnings.push(`workspace sync failed: ${error instanceof Error ? error.message : "Unknown sync error"}`);
      }
    } else {
      const info = await getLocalFileInfo(bundlePath);
      latestBundleKey = `${companyId}/bundles/latest.bundle`;
      latestBundleSha256 = info.sha256;
      latestBundleBytes = info.byteSize;
    }

    await persistWorkspaceInfoSafely(buildWorkspaceInfo(companyId, {
      ...existing,
      localPath,
      status: "active",
      latestBundleKey,
      latestBundleSha256,
      latestBundleBytes,
      currentGitRef: commitSha,
      lastSyncedAt,
      updatedAt: new Date().toISOString(),
    }), warnings);

    return {
      commitSha,
      warnings,
    };
  }

  /** List all sprint snapshots for a company, newest first. */
  async listSprintSnapshots(companyId: string) {
    if (!isDatabaseConfigured()) {
      return fallbackSprintSnapshots.get(companyId) ?? [];
    }

    try {
      // Spec 31 Phase 7.B.7 — query by indexed company_id uuid FK.
      const dbCompanyId = companiesRepo.toDbId(companyId);
      const rows = await getDb()
        .select()
        .from(sprintSnapshotsTable)
        .where(eq(sprintSnapshotsTable.companyId, dbCompanyId));
      return rows
        .sort((left, right) => right.sprintNumber - left.sprintNumber)
        .map((row) => mapSprintSnapshotRecord(row, companyId));
    } catch {
      return fallbackSprintSnapshots.get(companyId) ?? [];
    }
  }

  /** Tag the current workspace state as a sprint snapshot and persist the bundle. */
  async tagSprint(companyId: string, sprintNumber: number, snapshot: CompanySnapshot) {
    const warnings: string[] = [];
    const localPath = await this.ensureLocal(companyId);
    const tagName = await tagWorkspace(localPath, `sprint-${sprintNumber}`);
    const bundlePath = await createBundleFromWorkspace(localPath, resolve(getCompanyCachePath(companyId), `${tagName}.bundle`));
    const manifest = await listWorkspaceManifest(localPath, localPath);

    let bundleKey: string | null = `${companyId}/bundles/${tagName}.bundle`;
    let bundleSha256: string | null;
    let bundleBytes: number | null;

    if (isStorageConfigured()) {
      try {
        const upload = await uploadWorkspaceBundle(companyId, bundlePath, `${companyId}/bundles/${tagName}.bundle`);
        bundleKey = upload.objectKey;
        bundleSha256 = upload.sha256;
        bundleBytes = upload.byteSize;
      } catch (error) {
        warnings.push(`sprint bundle upload failed: ${error instanceof Error ? error.message : "Unknown sprint upload error"}`);
        const info = await getLocalFileInfo(bundlePath);
        bundleSha256 = info.sha256;
        bundleBytes = info.byteSize;
      }
    } else {
      const info = await getLocalFileInfo(bundlePath);
      bundleSha256 = info.sha256;
      bundleBytes = info.byteSize;
    }

    if (isDatabaseConfigured()) {
      // Spec 31 Phase 7.B.7 — canonical sprint_snapshots uses uuid PK
      // / FK; map the friendly snapshot id (`snapshot_<companyId>_<n>`)
      // and friendly companyId to deterministic uuids.
      const dbId = friendlyToUuid(`snapshot_${companyId}_${sprintNumber}`);
      const dbCompanyId = companiesRepo.toDbId(companyId);
      await getDb()
        .insert(sprintSnapshotsTable)
        .values({
          id: dbId,
          companyId: dbCompanyId,
          sprintNumber,
          gitTag: tagName,
          bundleKey,
          bundleSha256,
          bundleBytes,
          // Cast through Record<string, unknown> — the schema is
          // declared untyped to avoid an @arceus/contracts circular
          // dep in @arceus/db. The runtime payload is a CompanySnapshot.
          snapshotData: snapshot as unknown as Record<string, unknown>,
          // The canonical schema's jsonb is typed `{ path; sha256; bytes }`;
          // the workspace's listWorkspaceManifest helper produces
          // `{ path; size }` (contract `WorkspaceFileManifestEntry`).
          // The DB column is plain jsonb — cast through unknown so
          // both shapes can land without changing either type.
          fileManifest: manifest as unknown as Array<{ path: string; sha256: string; bytes: number }>,
          status: "active",
          createdAt: new Date(),
        })
        .onConflictDoUpdate({
          target: sprintSnapshotsTable.id,
          set: {
            gitTag: tagName,
            bundleKey,
            bundleSha256,
            bundleBytes,
            snapshotData: snapshot as unknown as Record<string, unknown>,
            fileManifest: manifest as unknown as Array<{ path: string; sha256: string; bytes: number }>,
            status: "active",
          },
        });
    }

    const nextSnapshot: SprintSnapshot = {
      id: `snapshot_${companyId}_${sprintNumber}`,
      companyId,
      sprintNumber,
      gitTag: tagName,
      bundleKey,
      bundleSha256,
      bundleBytes,
      snapshotData: snapshot,
      fileManifest: manifest,
      status: "active",
      createdAt: new Date().toISOString(),
    };
    const currentSnapshots = fallbackSprintSnapshots.get(companyId) ?? [];
    fallbackSprintSnapshots.set(
      companyId,
      [nextSnapshot, ...currentSnapshots.filter((entry) => entry.id !== nextSnapshot.id)]
    );

    const existing = (await this.get(companyId)) ?? buildWorkspaceInfo(companyId);
    await persistWorkspaceInfoSafely(buildWorkspaceInfo(companyId, {
      ...existing,
      localPath,
      status: "active",
      latestBundleKey: bundleKey,
      latestBundleSha256: bundleSha256,
      latestBundleBytes: bundleBytes,
      currentSprintNumber: sprintNumber,
      currentGitRef: await getHeadSha(localPath),
      lastSyncedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }), warnings);

    return {
      gitTag: tagName,
      warnings,
    };
  }

  /** Return a git diff stat between two sprint tags. */
  async getDiff(companyId: string, fromSprint: number, toSprint: number) {
    const localPath = await this.ensureLocal(companyId);
    return diffWorkspaceRefs(localPath, `sprint-${fromSprint}`, `sprint-${toSprint}`);
  }

  /** Generate a signed download URL for the latest workspace bundle. */
  async exportTarball(companyId: string): Promise<ExportResult> {
    const workspace = (await this.get(companyId)) ?? buildWorkspaceInfo(companyId);
    if (!workspace.latestBundleKey) {
      throw new Error("Workspace export is unavailable until the first bundle sync completes.");
    }

    const signedUrl = await createSignedBucketUrl(persistenceConfig.storage.workspaceBucket, workspace.latestBundleKey);
    const asset = await getAssetRecordByObjectKey(companyId, workspace.latestBundleKey);
    return {
      assetId: asset?.id ?? null,
      objectKey: workspace.latestBundleKey,
      signedUrl,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      byteSize: workspace.latestBundleBytes ?? 0,
    };
  }

  /** Archive a workspace by cleaning up local files and marking it inactive. */
  async archive(companyId: string): Promise<WorkspaceOperationResult> {
    const warnings: string[] = [];
    const existing = (await this.get(companyId)) ?? buildWorkspaceInfo(companyId);
    const cleanupTargets = [legacyProductDir, legacyApiWorkspaceDir, getCompanyCachePath(companyId)];

    for (const target of cleanupTargets) {
      if (!(await pathExists(target))) {
        continue;
      }

      try {
        if (target === legacyProductDir) {
          const entries = await readdir(target, { withFileTypes: true });
          await Promise.all(
            entries
              .filter((entry) => entry.name !== ".gitkeep")
              .map((entry) => rm(resolve(target, entry.name), { recursive: true, force: true }))
          );
          await writeFile(resolve(target, ".gitkeep"), "", { flag: "a" });
        } else {
          await rm(target, { recursive: true, force: true });
        }
      } catch (error) {
        warnings.push(`${target}: ${error instanceof Error ? error.message : "Unknown filesystem error"}`);
      }
    }

    const workspace = buildWorkspaceInfo(companyId, {
      ...existing,
      localPath: null,
      status: "archived",
      updatedAt: new Date().toISOString(),
    });

    return {
      workspace: await persistWorkspaceInfoSafely(workspace, warnings),
      warnings,
    };
  }

  /** List all non-ignored files in the workspace with modification timestamps. */
  async listFiles(companyId: string) {
    const workspace = await this.get(companyId);

    if (workspace?.status === "archived" || !workspace?.localPath) {
      return {
        root: workspace?.localPath ?? legacyProductDir,
        workspace,
        files: [],
      };
    }

    const root = workspace.localPath;

    if (!(await pathExists(root))) {
      return {
        root,
        workspace,
        files: [],
      };
    }

    return {
      root,
      workspace,
      files: await listWorkspaceFiles(root, root),
    };
  }
}

export const workspaceManager = new WorkspaceManager();