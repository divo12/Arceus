import { desc, eq } from "drizzle-orm";
import { artifactsTable, getDb, isDatabaseConfigured } from "@arceus/db";
import { uploadArtifactPayload } from "./supabase-storage.js";
import { describePgError } from "../infra/pg-errors.js";

export type PersistedRuntimeArtifact = {
  id: string;
  agent: string;
  kind: "plan" | "code" | "output" | "specification" | "qa_report";
  title: string;
  content: string;
  createdAt: string;
  /** Optional sprint linkage — carried into the artifacts row when present. */
  sprintId?: string | null;
  /** Optional task linkage — carried into the artifacts row when present. */
  taskId?: string | null;
  /** Optional file references (e.g. tester-written test files) — defaults to []. */
  fileReferences?: unknown[];
};

/** Persist a runtime artifact to the DB and upload its content to Supabase storage. */
export async function persistRuntimeArtifact(companyId: string, artifact: PersistedRuntimeArtifact) {
  if (!companyId || companyId === "company_pending") {
    return;
  }

  if (isDatabaseConfigured()) {
    try {
      await getDb()
        .insert(artifactsTable)
        .values({
          id: artifact.id,
          companyId,
          sprintId: artifact.sprintId ?? null,
          taskId: artifact.taskId ?? null,
          agentRole: artifact.agent,
          kind: artifact.kind,
          title: artifact.title,
          content: artifact.content,
          fileReferences: artifact.fileReferences ?? [],
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
  if (!isDatabaseConfigured() || !companyId || companyId === "company_pending") {
    return [];
  }

  try {
    const rows = await getDb().select().from(artifactsTable).where(eq(artifactsTable.companyId, companyId)).orderBy(desc(artifactsTable.createdAt));
    return rows.map((row) => ({
      id: row.id,
      agent: row.agentRole,
      kind: row.kind as PersistedRuntimeArtifact["kind"],
      title: row.title,
      content: row.content,
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
  if (!isDatabaseConfigured() || !companyId || companyId === "company_pending") {
    return;
  }

  await getDb().delete(artifactsTable).where(eq(artifactsTable.companyId, companyId));
}
