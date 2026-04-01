import { and, desc, eq, isNull, lt, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  memoryHabits,
  memoryOperations,
  memoryPatterns,
  memoryPrimingState,
  memoryUnits,
} from "@paperclipai/db";
import type { MemoryPrimingState } from "@paperclipai/shared";

export function memoryStoreService(db: Db) {
  function normalizePatternStatus(
    status: string | null | undefined,
  ): "active" | "deprecated" | "failed" {
    if (status === "failed") return "failed";
    if (status === "merged" || status === "pruned" || status === "archived" || status === "deprecated") {
      return "deprecated";
    }
    return "active";
  }

  function parseDate(value: Date | string | null | undefined): Date | null {
    if (!value) return null;
    if (value instanceof Date) return value;
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  async function writeMemory(input: {
    companyId: string;
    agentId: string;
    content: string;
    embedding: number[] | null;
    memoryType: "static" | "dynamic" | "working";
    container: string;
    confidence?: number;
    visibility?: "private" | "task_scoped" | "startup_shared" | "board_visible";
    sourceType?: string;
    sourceId?: string;
    previousVersionId?: string;
    expiresAt?: Date;
    metadata?: Record<string, unknown>;
  }) {
    return db
      .insert(memoryUnits)
      .values({
        companyId: input.companyId,
        agentId: input.agentId,
        content: input.content,
        embedding: input.embedding,
        memoryType: input.memoryType,
        container: input.container,
        confidence: input.confidence ?? 0.5,
        visibility: input.visibility ?? "private",
        sourceType: input.sourceType ?? null,
        sourceId: input.sourceId ?? null,
        previousVersionId: input.previousVersionId ?? null,
        expiresAt: input.expiresAt ?? null,
        metadata: input.metadata ?? {},
      })
      .returning()
      .then((rows) => rows[0]);
  }

  async function recall(input: {
    agentId: string;
    embedding: number[];
    topK?: number;
    container?: string;
    memoryTypes?: ("static" | "dynamic" | "working")[];
  }) {
    const { agentId, embedding, topK = 10, container, memoryTypes } = input;
    const embeddingVector = `[${embedding.join(",")}]`;
    const similarityExpr = sql<number>`1 - (${memoryUnits.embedding} <=> ${embeddingVector}::vector)`;
    const tierBoostExpr = sql<number>`
      CASE ${memoryUnits.memoryType}
        WHEN 'static' THEN 0.15
        WHEN 'dynamic' THEN 0.05
        ELSE 0
      END
    `;

    const conditions = [
      eq(memoryUnits.agentId, agentId),
      isNull(memoryUnits.deletedAt),
      sql`${memoryUnits.embedding} IS NOT NULL`,
    ];
    if (container) conditions.push(eq(memoryUnits.container, container));
    if (memoryTypes?.length) {
      conditions.push(sql`${memoryUnits.memoryType} = ANY(${memoryTypes})`);
    }

    return db
      .select({
        id: memoryUnits.id,
        companyId: memoryUnits.companyId,
        agentId: memoryUnits.agentId,
        content: memoryUnits.content,
        embedding: memoryUnits.embedding,
        memoryType: memoryUnits.memoryType,
        confidence: memoryUnits.confidence,
        relevanceScore: similarityExpr,
        container: memoryUnits.container,
        visibility: memoryUnits.visibility,
        metadata: memoryUnits.metadata,
        sourceType: memoryUnits.sourceType,
        sourceId: memoryUnits.sourceId,
        provenance: memoryUnits.provenance,
        version: memoryUnits.version,
        previousVersionId: memoryUnits.previousVersionId,
        promotionStatus: memoryUnits.promotionStatus,
        expiresAt: memoryUnits.expiresAt,
        deletedAt: memoryUnits.deletedAt,
        deleteReason: memoryUnits.deleteReason,
        createdAt: memoryUnits.createdAt,
        updatedAt: memoryUnits.updatedAt,
      })
      .from(memoryUnits)
      .where(and(...conditions))
      .orderBy(desc(sql`${similarityExpr} + ${tierBoostExpr}`))
      .limit(topK);
  }

  async function recallByDate(input: {
    agentId: string;
    topK?: number;
  }) {
    return db
      .select()
      .from(memoryUnits)
      .where(and(
        eq(memoryUnits.agentId, input.agentId),
        isNull(memoryUnits.deletedAt),
      ))
      .orderBy(desc(memoryUnits.createdAt))
      .limit(input.topK ?? 10);
  }

  async function getActiveHabits(agentId: string) {
    return db
      .select()
      .from(memoryHabits)
      .where(and(
        eq(memoryHabits.agentId, agentId),
        eq(memoryHabits.isActive, true),
      ))
      .orderBy(desc(memoryHabits.usageCount));
  }

  async function upsertHabit(input: {
    id?: string;
    companyId: string;
    agentId: string;
    triggerCondition: string;
    action: string;
    confidence: number;
    usageCount?: number;
    sourcePatternId?: string | null;
    isActive?: boolean;
    createdAt?: Date | string | null;
  }) {
    return db
      .insert(memoryHabits)
      .values({
        id: input.id,
        companyId: input.companyId,
        agentId: input.agentId,
        triggerCondition: input.triggerCondition,
        action: input.action,
        confidence: input.confidence,
        usageCount: input.usageCount ?? 0,
        sourcePatternId: input.sourcePatternId ?? null,
        isActive: input.isActive ?? true,
        createdAt: parseDate(input.createdAt) ?? new Date(),
      })
      .onConflictDoUpdate({
        target: [memoryHabits.id],
        set: {
          triggerCondition: input.triggerCondition,
          action: input.action,
          confidence: input.confidence,
          usageCount: input.usageCount ?? 0,
          sourcePatternId: input.sourcePatternId ?? null,
          isActive: input.isActive ?? true,
          updatedAt: new Date(),
        },
      })
      .returning()
      .then((rows) => rows[0]);
  }

  async function upsertPattern(input: {
    id?: string;
    companyId: string;
    agentId: string;
    description: string;
    strategy: string;
    embedding?: number[] | null;
    usageCount?: number;
    successRate?: number;
    status?: string | null;
    domain?: string | null;
    createdAt?: Date | string | null;
    updatedAt?: Date | string | null;
  }) {
    return db
      .insert(memoryPatterns)
      .values({
        id: input.id,
        companyId: input.companyId,
        agentId: input.agentId,
        description: input.description,
        strategy: input.strategy,
        embedding: input.embedding ?? null,
        usageCount: input.usageCount ?? 0,
        successRate: input.successRate ?? 0,
        status: normalizePatternStatus(input.status),
        domain: input.domain ?? null,
        createdAt: parseDate(input.createdAt) ?? new Date(),
        updatedAt: parseDate(input.updatedAt) ?? new Date(),
      })
      .onConflictDoUpdate({
        target: [memoryPatterns.id],
        set: {
          description: input.description,
          strategy: input.strategy,
          embedding: input.embedding ?? null,
          usageCount: input.usageCount ?? 0,
          successRate: input.successRate ?? 0,
          status: normalizePatternStatus(input.status),
          domain: input.domain ?? null,
          updatedAt: parseDate(input.updatedAt) ?? new Date(),
        },
      })
      .returning()
      .then((rows) => rows[0]);
  }

  async function getPrimingState(agentId: string) {
    return db
      .select()
      .from(memoryPrimingState)
      .where(eq(memoryPrimingState.agentId, agentId))
      .then((rows) => rows[0]?.payload ?? null);
  }

  async function updatePrimingState(
    agentId: string,
    companyId: string,
    state: MemoryPrimingState,
  ) {
    return db
      .insert(memoryPrimingState)
      .values({ agentId, companyId, payload: state })
      .onConflictDoUpdate({
        target: [memoryPrimingState.agentId],
        set: { payload: state, updatedAt: new Date() },
      })
      .returning()
      .then((rows) => rows[0]);
  }

  async function listMemories(filters: {
    agentId: string;
    memoryType?: "static" | "dynamic" | "working";
    container?: string;
    limit?: number;
    offset?: number;
  }) {
    const conditions = [
      eq(memoryUnits.agentId, filters.agentId),
      isNull(memoryUnits.deletedAt),
    ];
    if (filters.memoryType) conditions.push(eq(memoryUnits.memoryType, filters.memoryType));
    if (filters.container) conditions.push(eq(memoryUnits.container, filters.container));

    return db
      .select()
      .from(memoryUnits)
      .where(and(...conditions))
      .orderBy(desc(memoryUnits.createdAt))
      .limit(filters.limit ?? 50)
      .offset(filters.offset ?? 0);
  }

  async function countMemories(filters: {
    agentId: string;
    memoryType?: "static" | "dynamic" | "working";
    container?: string;
  }) {
    const conditions = [
      eq(memoryUnits.agentId, filters.agentId),
      isNull(memoryUnits.deletedAt),
    ];
    if (filters.memoryType) conditions.push(eq(memoryUnits.memoryType, filters.memoryType));
    if (filters.container) conditions.push(eq(memoryUnits.container, filters.container));

    const row = await db
      .select({ count: sql<number>`count(*)` })
      .from(memoryUnits)
      .where(and(...conditions))
      .then((rows) => rows[0]);

    return Number(row?.count ?? 0);
  }

  async function softDelete(memoryId: string, reason: string) {
    return db
      .update(memoryUnits)
      .set({
        deletedAt: new Date(),
        deleteReason: reason,
        updatedAt: new Date(),
      })
      .where(eq(memoryUnits.id, memoryId))
      .returning()
      .then((rows) => rows[0] ?? null);
  }

  async function getVersionHistory(memoryId: string) {
    const versions: Array<typeof memoryUnits.$inferSelect> = [];
    let currentId: string | null = memoryId;

    while (currentId) {
      const row: typeof memoryUnits.$inferSelect | null = await db
        .select()
        .from(memoryUnits)
        .where(eq(memoryUnits.id, currentId))
        .then((rows) => rows[0] ?? null);
      if (!row) break;
      versions.push(row);
      currentId = row.previousVersionId ?? null;
    }

    return versions.sort((left, right) => right.version - left.version);
  }

  async function logOperation(input: {
    companyId: string;
    agentId?: string;
    bindingId?: string;
    operationType: string;
    scope?: Record<string, unknown>;
    sourceRef?: Record<string, unknown>;
    resultCount?: number;
    latencyMs?: number;
    costCents?: number;
    inputTokens?: number;
    outputTokens?: number;
    embeddingTokens?: number;
    success: boolean;
    error?: string;
  }) {
    return db
      .insert(memoryOperations)
      .values({
        companyId: input.companyId,
        agentId: input.agentId ?? null,
        bindingId: input.bindingId ?? null,
        operationType: input.operationType,
        scope: input.scope,
        sourceRef: input.sourceRef,
        resultCount: input.resultCount,
        latencyMs: input.latencyMs,
        costCents: input.costCents,
        inputTokens: input.inputTokens,
        outputTokens: input.outputTokens,
        embeddingTokens: input.embeddingTokens,
        success: input.success,
        error: input.error,
      })
      .returning()
      .then((rows) => rows[0]);
  }

  async function listOperations(filters: {
    companyId: string;
    agentId?: string;
    limit?: number;
    offset?: number;
  }) {
    const conditions = [eq(memoryOperations.companyId, filters.companyId)];
    if (filters.agentId) conditions.push(eq(memoryOperations.agentId, filters.agentId));

    return db
      .select()
      .from(memoryOperations)
      .where(and(...conditions))
      .orderBy(desc(memoryOperations.createdAt))
      .limit(filters.limit ?? 50)
      .offset(filters.offset ?? 0);
  }

  async function deleteExpiredWorking() {
    return db
      .delete(memoryUnits)
      .where(and(
        eq(memoryUnits.memoryType, "working"),
        lt(memoryUnits.expiresAt, new Date()),
      ));
  }

  return {
    writeMemory,
    recall,
    recallByDate,
    getActiveHabits,
    upsertHabit,
    upsertPattern,
    getPrimingState,
    updatePrimingState,
    listMemories,
    countMemories,
    listOperations,
    softDelete,
    getVersionHistory,
    logOperation,
    deleteExpiredWorking,
  };
}
