import { desc, eq } from "drizzle-orm";
import type { CompanySnapshot, EventEnvelope } from "@arceus/contracts";
import { companyStatesTable, getDb, isDatabaseConfigured } from "@arceus/db";

type PersistedCompanyState = {
  snapshot: CompanySnapshot;
  events: EventEnvelope[];
  updatedAt: string;
};

let pendingPersist: PersistedCompanyState | null = null;
let persistQueue: Promise<void> = Promise.resolve();
let lastPersistError: Error | null = null;

function clonePersistedState(snapshot: CompanySnapshot, events: EventEnvelope[]): PersistedCompanyState {
  return {
    snapshot: structuredClone(snapshot),
    events: structuredClone(events),
    updatedAt: new Date().toISOString(),
  };
}

async function writePersistedCompanyState(state: PersistedCompanyState) {
  try {
    await getDb()
      .insert(companyStatesTable)
      .values({
        companyId: state.snapshot.company.id,
        snapshotData: state.snapshot,
        eventLog: state.events,
        updatedAt: new Date(state.updatedAt),
      })
      .onConflictDoUpdate({
        target: companyStatesTable.companyId,
        set: {
          snapshotData: state.snapshot,
          eventLog: state.events,
          updatedAt: new Date(state.updatedAt),
        },
      });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[PERSIST] writePersistedCompanyState FAILED for ${state.snapshot.company.id}: ${msg}`);
    throw err;
  }
}

async function drainPersistQueue() {
  while (pendingPersist) {
    const next = pendingPersist;
    pendingPersist = null;
    await writePersistedCompanyState(next);
  }
}

export async function loadPersistedCompanyState(companyId?: string): Promise<PersistedCompanyState | null> {
  if (!isDatabaseConfigured()) {
    return null;
  }

  try {
    if (companyId) {
      const rows = await getDb().select().from(companyStatesTable).where(eq(companyStatesTable.companyId, companyId)).limit(1);
      const row = rows[0];
      return row
        ? {
            snapshot: row.snapshotData as CompanySnapshot,
            events: row.eventLog as EventEnvelope[],
            updatedAt: row.updatedAt.toISOString(),
          }
        : null;
    }

    const rows = await getDb().select().from(companyStatesTable).orderBy(desc(companyStatesTable.updatedAt)).limit(1);
    const row = rows[0];
    return row
      ? {
          snapshot: row.snapshotData as CompanySnapshot,
          events: row.eventLog as EventEnvelope[],
          updatedAt: row.updatedAt.toISOString(),
        }
      : null;
  } catch {
    return null;
  }
}

export function schedulePersistedCompanyState(snapshot: CompanySnapshot, events: EventEnvelope[]) {
  if (!isDatabaseConfigured() || snapshot.company.id === "company_pending") {
    return Promise.resolve();
  }

  pendingPersist = clonePersistedState(snapshot, events);
  persistQueue = persistQueue.then(
    async () => {
      await drainPersistQueue();
      lastPersistError = null;
    },
    async () => {
      await drainPersistQueue();
      lastPersistError = null;
    }
  ).catch((error) => {
    lastPersistError = error instanceof Error ? error : new Error("Company state persistence failed.");
    throw lastPersistError;
  });

  return persistQueue;
}

export async function flushPersistedCompanyState() {
  if (!isDatabaseConfigured()) {
    return;
  }

  await persistQueue.catch(() => undefined);
  if (pendingPersist) {
    await schedulePersistedCompanyState(pendingPersist.snapshot, pendingPersist.events).catch(() => undefined);
  }
  await persistQueue.catch(() => undefined);

  if (lastPersistError) {
    console.error(`[PERSIST] flushPersistedCompanyState ignoring error (in-memory state is authoritative): ${lastPersistError.message}`);
    lastPersistError = null;
  }
}

export async function deletePersistedCompanyState(companyId: string) {
  if (!isDatabaseConfigured()) {
    return;
  }

  pendingPersist = null;
  await persistQueue.catch(() => undefined);
  lastPersistError = null;
  await getDb().delete(companyStatesTable).where(eq(companyStatesTable.companyId, companyId));
}