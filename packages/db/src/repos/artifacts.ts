import { and, desc, eq } from "drizzle-orm";
import type { Artifact as ContractArtifact } from "@arceus/contracts";
import { artifacts } from "../schema/artifacts.js";
import type { DbClient } from "./_helpers.js";
import { friendlyToUuid } from "./_uuid.js";

export type Artifact = typeof artifacts.$inferSelect;
export type NewArtifact = typeof artifacts.$inferInsert;

// ── ID boundary: friendly strings ↔ uuid (Phase 4C) ──────────────
export const toDbId = friendlyToUuid;

export const fromDbId = (uuid: string, friendlyHint?: string | null): string =>
  friendlyHint ?? uuid;

export async function createArtifact(db: DbClient, data: NewArtifact): Promise<Artifact> {
  const [row] = await db.insert(artifacts).values(data).returning();
  return row;
}

export async function findArtifactById(db: DbClient, id: string): Promise<Artifact | null> {
  const [row] = await db.select().from(artifacts).where(eq(artifacts.id, toDbId(id))).limit(1);
  return row ?? null;
}

export async function listArtifactsByTask(db: DbClient, taskId: string): Promise<Artifact[]> {
  return db
    .select()
    .from(artifacts)
    .where(eq(artifacts.taskId, toDbId(taskId)))
    .orderBy(desc(artifacts.createdAt));
}

export async function listArtifactsBySprint(db: DbClient, sprintId: string): Promise<Artifact[]> {
  return db
    .select()
    .from(artifacts)
    .where(eq(artifacts.sprintId, toDbId(sprintId)))
    .orderBy(desc(artifacts.createdAt));
}

export async function listArtifactsByCompany(
  db: DbClient,
  companyId: string,
  limit = 50,
): Promise<Artifact[]> {
  return db
    .select()
    .from(artifacts)
    .where(eq(artifacts.companyId, toDbId(companyId)))
    .orderBy(desc(artifacts.createdAt))
    .limit(limit);
}

export async function listArtifactsByKind(
  db: DbClient,
  companyId: string,
  kind: string,
): Promise<Artifact[]> {
  return db
    .select()
    .from(artifacts)
    .where(and(eq(artifacts.companyId, toDbId(companyId)), eq(artifacts.kind, kind)))
    .orderBy(desc(artifacts.createdAt));
}

// ── Hydration: DB row ↔ contracts.Artifact (Phase 4C) ────────────

/** Pure transform from DB row to contracts.Artifact. */
export function rowToArtifact(row: Artifact): ContractArtifact {
  return {
    id: fromDbId(row.id, row.friendlyId),
    companyId: row.companyId,
    sprintId: row.sprintId,
    taskId: row.taskId,
    agentId: row.agentId,
    kind: row.kind as ContractArtifact["kind"],
    title: row.title,
    summary: row.summary ?? row.content ?? "",
    location: row.location,
    contentType: row.contentType,
    metadata: (row.metadata ?? {}),
    createdAt: row.createdAt.toISOString(),
  };
}

/** Build the insert payload from a contracts.Artifact. */
export function artifactToInsert(artifact: ContractArtifact): NewArtifact {
  return {
    id: toDbId(artifact.id),
    friendlyId: artifact.id,
    companyId: toDbId(artifact.companyId),
    sprintId: artifact.sprintId ? toDbId(artifact.sprintId) : null,
    taskId: artifact.taskId ? toDbId(artifact.taskId) : null,
    agentId: artifact.agentId ? toDbId(artifact.agentId) : null,
    kind: artifact.kind,
    title: artifact.title,
    summary: artifact.summary,
    location: artifact.location,
    contentType: artifact.contentType,
    metadata: artifact.metadata,
  };
}

/** Insert-or-replace for the dual-write path. */
export async function upsertArtifact(db: DbClient, artifact: ContractArtifact): Promise<Artifact> {
  const { id, ...updateFields } = artifactToInsert(artifact);
  const [row] = await db
    .insert(artifacts)
    .values({ id, ...updateFields })
    .onConflictDoUpdate({ target: artifacts.id, set: updateFields })
    .returning();
  return row;
}

export async function findByIdHydrated(db: DbClient, id: string): Promise<ContractArtifact | null> {
  const row = await findArtifactById(db, id);
  return row ? rowToArtifact(row) : null;
}
