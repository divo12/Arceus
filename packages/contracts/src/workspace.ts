/**
 * @module workspace
 * Workspace and asset storage schemas.
 *
 * Each company has a workspace — a local directory where agents write code.
 * Workspaces are bundled (tar.gz) and synced to cloud storage for persistence.
 *
 * Key types:
 * - WorkspaceInfo — workspace metadata with sync state and git ref
 * - AssetRecord — cloud storage object record
 * - ExportResult — signed URL for downloading a workspace bundle
 */
import { z } from "zod";

export const workspaceStatusSchema = z.enum(["active", "archived", "restoring"]);

export const workspaceInfoSchema = z.object({
  id: z.string(),
  companyId: z.string(),
  localPath: z.string().nullable(),
  status: workspaceStatusSchema,
  latestBundleKey: z.string().nullable(),
  latestBundleSha256: z.string().nullable(),
  latestBundleBytes: z.number().int().nonnegative().nullable(),
  currentSprintNumber: z.number().int().nonnegative(),
  currentGitRef: z.string().nullable(),
  lastSyncedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const workspaceFileManifestEntrySchema = z.object({
  path: z.string(),
  size: z.number().int().nonnegative(),
});

export const assetRecordSchema = z.object({
  id: z.string(),
  companyId: z.string(),
  provider: z.string(),
  objectKey: z.string(),
  contentType: z.string(),
  byteSize: z.number().int().nonnegative(),
  sha256: z.string(),
  originalFilename: z.string().nullable(),
  namespace: z.string(),
  createdByAgent: z.string().nullable(),
  createdAt: z.string(),
});

export const exportResultSchema = z.object({
  assetId: z.string().nullable(),
  objectKey: z.string(),
  signedUrl: z.string(),
  expiresAt: z.string(),
  byteSize: z.number().int().nonnegative(),
});

export type WorkspaceInfo = z.infer<typeof workspaceInfoSchema>;
export type WorkspaceFileManifestEntry = z.infer<typeof workspaceFileManifestEntrySchema>;
export type AssetRecord = z.infer<typeof assetRecordSchema>;
export type ExportResult = z.infer<typeof exportResultSchema>;
