import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";

type EmbeddedPostgresInstance = {
  initialise(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
};

type EmbeddedPostgresCtor = new (opts: {
  databaseDir: string;
  user: string;
  password: string;
  port: number;
  persistent: boolean;
  initdbFlags?: string[];
  onLog?: (message: unknown) => void;
  onError?: (message: unknown) => void;
}) => EmbeddedPostgresInstance;

function resolveRuntimePythonBin(): string {
  return process.env.PAPERCLIP_HIPPOCAMPUS_PYTHON_BIN?.trim()
    || path.resolve(process.cwd(), "services/hippocampus-runtime/python/.venv/bin/python");
}

async function getEmbeddedPostgresCtor(): Promise<EmbeddedPostgresCtor> {
  const mod = await import("embedded-postgres");
  return mod.default as EmbeddedPostgresCtor;
}

async function getAvailablePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to allocate test port")));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) reject(error);
        else resolve(port);
      });
    });
  });
}

async function startTempDatabase() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-hippocampus-smoke-db-"));
  const port = await getAvailablePort();
  const EmbeddedPostgres = await getEmbeddedPostgresCtor();
  const instance = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: "paperclip",
    password: "paperclip",
    port,
    persistent: true,
    initdbFlags: ["--encoding=UTF8", "--locale=C"],
    onLog: () => {},
    onError: () => {},
  });
  await instance.initialise();
  await instance.start();

  const { applyPendingMigrations, ensurePostgresDatabase } = await import("@paperclipai/db");
  const adminConnectionString = `postgres://paperclip:paperclip@127.0.0.1:${port}/postgres`;
  await ensurePostgresDatabase(adminConnectionString, "paperclip");
  const connectionString = `postgres://paperclip:paperclip@127.0.0.1:${port}/paperclip`;
  await applyPendingMigrations(connectionString);
  return { connectionString, dataDir, instance };
}

function restoreEnv(snapshot: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(snapshot)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

describe("embedded hippocampus server smoke", () => {
  const tempDirs: string[] = [];

  afterAll(() => {
    for (const dir of tempDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it(
    "starts with the embedded runtime and serves memory APIs",
    async () => {
      const runtimePythonBin = resolveRuntimePythonBin();
      expect(fs.existsSync(runtimePythonBin)).toBe(true);

      const envKeys = [
        "DATABASE_URL",
        "HEARTBEAT_SCHEDULER_ENABLED",
        "HOST",
        "PAPERCLIP_DB_BACKUP_ENABLED",
        "PAPERCLIP_HIPPOCAMPUS_MODE",
        "PAPERCLIP_HIPPOCAMPUS_PYTHON_BIN",
        "PAPERCLIP_MIGRATION_AUTO_APPLY",
        "PAPERCLIP_MIGRATION_PROMPT",
        "PAPERCLIP_UI_DEV_MIDDLEWARE",
        "PORT",
        "SERVE_UI",
        "ARCEUS_HIPPOCAMPUS_PROFILE",
        "ARCEUS_HIPPOCAMPUS_TEST_DIR",
        "ARCEUS_HIPPOCAMPUS_TEST_EMBEDDING_DIMENSIONS",
      ] as const;
      const envSnapshot = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));

      const startedDb = await startTempDatabase();
      tempDirs.push(startedDb.dataDir);
      const runtimeDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-hippocampus-smoke-runtime-"));
      tempDirs.push(runtimeDataDir);

      const apiPort = await getAvailablePort();

      process.env.DATABASE_URL = startedDb.connectionString;
      process.env.HOST = "127.0.0.1";
      process.env.PORT = String(apiPort);
      process.env.SERVE_UI = "false";
      process.env.PAPERCLIP_UI_DEV_MIDDLEWARE = "false";
      process.env.HEARTBEAT_SCHEDULER_ENABLED = "false";
      process.env.PAPERCLIP_DB_BACKUP_ENABLED = "false";
      process.env.PAPERCLIP_MIGRATION_PROMPT = "never";
      process.env.PAPERCLIP_MIGRATION_AUTO_APPLY = "true";
      process.env.PAPERCLIP_HIPPOCAMPUS_MODE = "embedded";
      process.env.PAPERCLIP_HIPPOCAMPUS_PYTHON_BIN = runtimePythonBin;
      process.env.ARCEUS_HIPPOCAMPUS_PROFILE = "test_fakes";
      process.env.ARCEUS_HIPPOCAMPUS_TEST_DIR = runtimeDataDir;
      process.env.ARCEUS_HIPPOCAMPUS_TEST_EMBEDDING_DIMENSIONS = "32";

      const { startServer, stopHippocampusRuntimeForConfig } = await import("../index.js");

      let startedServer:
        | Awaited<ReturnType<typeof startServer>>
        | null = null;
      try {
        startedServer = await startServer();

        const health = await request(startedServer.server).get("/api/memory/health");
        expect(health.status).toBe(200);
        expect(health.body).toMatchObject({
          status: "ok",
          agents_loaded: 0,
          diagnostics: {
            mode: "embedded",
            status: "running",
          },
        });
        expect(health.body.diagnostics?.pid).toEqual(expect.any(Number));

        const remember = await request(startedServer.server)
          .post("/api/agents/agent-smoke/memory/remember")
          .send({
            content: "JWT auth is enabled for the Paperclip control plane",
            container: "startup:paperclip",
            memory_type: "dynamic",
          });
        expect(remember.status).toBe(200);
        expect(remember.body).toMatchObject({
          content: "JWT auth is enabled for the Paperclip control plane",
          memory_type: "dynamic",
        });

        const recall = await request(startedServer.server)
          .post("/api/agents/agent-smoke/memory/recall")
          .send({
            query: "JWT auth",
            container: "startup:paperclip",
            top_k: 5,
          });
        expect(recall.status).toBe(200);
        expect(recall.body.items).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              content: "JWT auth is enabled for the Paperclip control plane",
            }),
          ]),
        );

        const healthAfter = await request(startedServer.server).get("/api/memory/health");
        expect(healthAfter.status).toBe(200);
        expect(healthAfter.body).toMatchObject({
          status: "ok",
          agents_loaded: 1,
          diagnostics: {
            mode: "embedded",
            status: "running",
          },
        });
        expect(healthAfter.body.diagnostics?.pid).toEqual(expect.any(Number));
      } finally {
        if (startedServer) {
          await new Promise<void>((resolve, reject) => {
            startedServer.server.close((error) => {
              if (error) reject(error);
              else resolve();
            });
          });
        }
        await stopHippocampusRuntimeForConfig({ hippocampusMode: "embedded" });
        await startedDb.instance.stop();
        restoreEnv(envSnapshot);
      }
    },
    60_000,
  );
});
