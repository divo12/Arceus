import type { DatabaseAdapter, DatabaseHealth, EntityName, EntityRecordMap } from "./types";

function cloneRecord<T>(value: T): T {
  return structuredClone(value);
}

export class NoopDatabaseAdapter implements DatabaseAdapter {
  readonly kind = "noop" as const;

  private readonly store = new Map<EntityName, Map<string, unknown>>();

  async list<K extends EntityName>(entity: K): Promise<Array<EntityRecordMap[K]>> {
    return Array.from(this.getEntityStore(entity).values()).map((record) => cloneRecord(record as EntityRecordMap[K]));
  }

  async getById<K extends EntityName>(entity: K, id: string): Promise<EntityRecordMap[K] | null> {
    const record = this.getEntityStore(entity).get(id);
    return record ? cloneRecord(record as EntityRecordMap[K]) : null;
  }

  async upsert<K extends EntityName>(entity: K, record: EntityRecordMap[K] & { id: string }): Promise<EntityRecordMap[K]> {
    this.getEntityStore(entity).set(record.id, cloneRecord(record));
    return cloneRecord(record);
  }

  async delete<K extends EntityName>(entity: K, id: string): Promise<boolean> {
    return this.getEntityStore(entity).delete(id);
  }

  async healthCheck(): Promise<DatabaseHealth> {
    return {
      ok: true,
      kind: this.kind,
      details: "In-memory adapter active. Replace with PostgreSQL/Drizzle in Spec 04."
    };
  }

  private getEntityStore(entity: EntityName) {
    let bucket = this.store.get(entity);
    if (!bucket) {
      bucket = new Map<string, unknown>();
      this.store.set(entity, bucket);
    }
    return bucket;
  }
}

export function createNoopDatabaseAdapter() {
  return new NoopDatabaseAdapter();
}