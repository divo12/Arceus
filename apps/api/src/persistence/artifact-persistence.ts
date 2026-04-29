import { desc, eq } from "drizzle-orm";
import { artifacts as artifactsTable, getDb, isDatabaseConfigured } from "@arceus/db";
import * as companiesRepo from "@arceus/db/src/repos/companies.js";
import { friendlyToUuid } from "@arceus/db/src/repos/_uuid.js";
import { uploadArtifactPayload } from "./supabase-storage.js";
import { describePgError } from "../infra/pg-errors.js";

export interface PersistedRuntimeArtifact {
  id: string;
  agent: string;
  kind: "plan" | "code" | "output" | "specification" | "qa_report" | "handoff";
  title: string;
  content: string;
  createdAt: string;
  /** Optional sprint linkage — carried into the artifacts row when present. */
  sprintId?: string | null;
  /** Optional task linkage — carried into the artifacts row when present. */
  taskId?: string | null;
  /** Optional file references (e.g. tester-written test files) — defaults to []. */
  fileReferences?: unknown[];
}

/** Persist a runtime artifact to the DB and upload its content to Supabase storage. */
export async function persistRuntimeArtifact(companyId: string, artifact: PersistedRuntimeArtifact) {
  if (!companyId) {
    return;
  }

  if (isDatabaseConfigured()) {
    try {
      // Spec 31 Phase 7.B.6 — canonical artifacts table uses uuid PK +
      // uuid FKs. Friendly ids are hashed via uuidv5; the friendly id
      // is also stamped in `friendly_id` so the read side can return
      // it verbatim.
      await getDb()
        .insert(artifactsTable)
        .values({
          id: friendlyToUuid(artifact.id),
          companyId: companiesRepo.toDbId(companyId),
          sprintId: artifact.sprintId ? friendlyToUuid(artifact.sprintId) : null,
          taskId: artifact.taskId ? friendlyToUuid(artifact.taskId) : null,
          friendlyId: artifact.id,
          agentRole: artifact.agent,
          kind: artifact.kind,
          title: artifact.title,
          content: artifact.content,
          fileReferences: (artifact.fileReferences ?? []) as string[],
          createdAt: new Date(artifact.createdAt),
        })
        .onConflictDoUpdate({
          target: artifactsTable.id,
          set: {
            title: artifact.title,
            content: artifact.content,
          },
        });
    } catch (err) {
      // Best-effort persistence — log with SQLSTATE/detail so the root cause
      // is visible instead of Drizzle's generic "Failed query:" wrapper.
      console.warn(
        `[artifact-persistence] insert failed for ${artifact.id}: ${describePgError(err)}`,
      );
    }
  }

  try {
    await uploadArtifactPayload(companyId, artifact.id, artifact.content, artifact.title);
  } catch {
    // Artifact text storage is best-effort during the migration.
  }
}

/** List all persisted artifacts for a company, ordered by creation date descending. */
export async function listPersistedArtifacts(companyId: string): Promise<PersistedRuntimeArtifact[]> {
  if (!isDatabaseConfigured() || !companyId) {
    return [];
  }

  try {
    const dbCompanyId = companiesRepo.toDbId(companyId);
    const rows = await getDb()
      .select()
      .from(artifactsTable)
      .where(eq(artifactsTable.companyId, dbCompanyId))
      .orderBy(desc(artifactsTable.createdAt));
    return rows.map((row) => ({
      // Spec 31 Phase 7.B.6 — return the friendly id when stamped;
      // fall back to the uuid for legacy rows.
      id: row.friendlyId ?? row.id,
      // agentRole became nullable in canonical (system-scoped artifacts);
      // the contract requires a string.
      agent: row.agentRole ?? "",
      kind: row.kind as PersistedRuntimeArtifact["kind"],
      title: row.title,
      // content became nullable too — old writers used `summary` instead.
      content: row.content ?? row.summary ?? "",
      createdAt: row.createdAt.toISOString(),
      sprintId: row.sprintId ?? null,
      taskId: row.taskId ?? null,
      fileReferences: Array.isArray(row.fileReferences) ? row.fileReferences : [],
    }));
  } catch {
    return [];
  }
}

/** Retrieve a single persisted artifact by ID. */
export async function getPersistedArtifactById(companyId: string, id: string): Promise<PersistedRuntimeArtifact | null> {
  const artifacts = await listPersistedArtifacts(companyId);
  return artifacts.find((artifact) => artifact.id === id) ?? null;
}

/** Delete all persisted artifacts for a company. */
export async function deletePersistedArtifacts(companyId: string) {
  if (!isDatabaseConfigured() || !companyId) {
    return;
  }

  await getDb()
    .delete(artifactsTable)
    .where(eq(artifactsTable.companyId, companiesRepo.toDbId(companyId)));
}
