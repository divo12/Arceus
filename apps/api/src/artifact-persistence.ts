import { desc, eq } from "drizzle-orm";
import { artifactsTable, getDb, isDatabaseConfigured } from "@arceus/db";
import { uploadArtifactPayload } from "./supabase-storage";

export type PersistedRuntimeArtifact = {
  id: string;
  agent: string;
  kind: "plan" | "code" | "output" | "specification";
  title: string;
  content: string;
  createdAt: string;
};

export async function persistRuntimeArtifact(companyId: string, artifact: PersistedRuntimeArtifact) {
  if (!companyId || companyId === "company_pending") {
    return;
  }

  if (isDatabaseConfigured()) {
    await getDb()
      .insert(artifactsTable)
      .values({
        id: artifact.id,
        companyId,
        sprintId: null,
        taskId: null,
        agentRole: artifact.agent,
        kind: artifact.kind,
        title: artifact.title,
        content: artifact.content,
        fileReferences: [],
        createdAt: new Date(artifact.createdAt),
      })
      .onConflictDoUpdate({
        target: artifactsTable.id,
        set: {
          title: artifact.title,
          content: artifact.content,
        },
      });
  }

  try {
    await uploadArtifactPayload(companyId, artifact.id, artifact.content, artifact.title);
  } catch {
    // Artifact text storage is best-effort during the migration.
  }
}

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
    }));
  } catch {
    return [];
  }
}

export async function getPersistedArtifactById(companyId: string, id: string): Promise<PersistedRuntimeArtifact | null> {
  const artifacts = await listPersistedArtifacts(companyId);
  return artifacts.find((artifact) => artifact.id === id) ?? null;
}

export async function deletePersistedArtifacts(companyId: string) {
  if (!isDatabaseConfigured() || !companyId || companyId === "company_pending") {
    return;
  }

  await getDb().delete(artifactsTable).where(eq(artifactsTable.companyId, companyId));
}