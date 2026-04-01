import { getRedisClient } from "./redis.js";

export function workingMemoryService() {
  const redis = getRedisClient();

  function wmKey(agentId: string, key: string) {
    return `arceus:${agentId}:wm:${key}`;
  }

  return {
    async get(agentId: string, key: string): Promise<string | null> {
      return redis.get(wmKey(agentId, key));
    },

    async set(agentId: string, key: string, value: string, ttlSeconds: number): Promise<void> {
      await redis.set(wmKey(agentId, key), value, "EX", ttlSeconds);
    },

    async loadConversationBuffer(agentId: string): Promise<string[]> {
      return redis.lrange(wmKey(agentId, "conv_buffer"), 0, -1);
    },

    async appendConversationBuffer(agentId: string, entry: string, ttlSeconds: number): Promise<void> {
      const key = wmKey(agentId, "conv_buffer");
      await redis.rpush(key, entry);
      await redis.expire(key, ttlSeconds);
    },

    async cacheEmbedding(agentId: string, embedding: number[], ttlSeconds = 3600): Promise<void> {
      await redis.set(wmKey(agentId, "last_embedding"), JSON.stringify(embedding), "EX", ttlSeconds);
    },

    async getCachedEmbedding(agentId: string): Promise<number[] | null> {
      const raw = await redis.get(wmKey(agentId, "last_embedding"));
      return raw ? JSON.parse(raw) as number[] : null;
    },

    async clearAgent(agentId: string): Promise<void> {
      const pattern = wmKey(agentId, "*");
      const keys: string[] = [];
      let cursor = "0";
      do {
        const [nextCursor, batch] = await redis.scan(cursor, "MATCH", pattern, "COUNT", 100);
        cursor = nextCursor;
        keys.push(...batch);
      } while (cursor !== "0");
      if (keys.length > 0) await redis.del(...keys);
    },
  };
}
