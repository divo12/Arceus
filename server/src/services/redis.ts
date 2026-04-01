import { Redis as RedisCtor } from "ioredis";

type RedisClient = InstanceType<typeof RedisCtor>;

let client: RedisClient | null = null;

export function getRedisClient(): RedisClient {
  if (!client) {
    const url = process.env.REDIS_URL;
    if (!url) {
      throw new Error("REDIS_URL is required — Redis is compulsory infrastructure");
    }
    client = new RedisCtor(url, {
      maxRetriesPerRequest: 3,
    });
  }
  return client;
}

export async function closeRedis(): Promise<void> {
  if (!client) return;
  await client.quit();
  client = null;
}
