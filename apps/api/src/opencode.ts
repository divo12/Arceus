import { resolve } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { createOpencodeClient, type Session } from "@opencode-ai/sdk";
import { ensureDeployment, runtimeConfig } from "./config/index";
import { resilientCall, breakers, isRetryableError } from "./resilience";

type OpencodeInstance = {
  server: { url: string; close(): void };
  client: ReturnType<typeof createOpencodeClient>;
};

let opencodePromise: Promise<OpencodeInstance> | null = null;
let ceoSessionPromise: Promise<Session> | null = null;
const workspaceRoot = process.cwd();

function ensureAzureRuntimeEnvironment() {
  process.env.AZURE_RESOURCE_NAME = runtimeConfig.azureResourceName;
  process.env.AZURE_OPENAI_ENDPOINT = runtimeConfig.azureEndpoint;
  process.env.AZURE_OPENAI_API_KEY = runtimeConfig.azureApiKey;
  process.env.AZURE_OPENAI_API_VERSION = runtimeConfig.azureApiVersion;
}

async function detectExistingOpencodeServer(url: string) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2000);

  try {
    const response = await fetch(`${url}/event`, {
      signal: controller.signal,
      headers: {
        Accept: "text/event-stream"
      }
    });

    if (!response.ok) {
      return false;
    }

    await response.body?.cancel();
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

async function connectOpencodeClient(url: string, close: () => void): Promise<OpencodeInstance> {
  const client = createOpencodeClient({ baseUrl: url });

  await client.auth.set({
    path: { id: "azure" },
    body: { type: "api", key: runtimeConfig.azureApiKey }
  });

  return {
    server: { url, close },
    client
  };
}

function reservePort(hostname: string, port: number) {
  return new Promise<number>((resolve, reject) => {
    const server = createServer();

    server.once("error", (error) => {
      reject(error);
    });

    server.listen({ host: hostname, port }, () => {
      const address = server.address();

      if (!address || typeof address === "string") {
        server.close(() => {
          reject(new Error("Unable to determine a port for the OpenCode server."));
        });
        return;
      }

      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(address.port);
      });
    });
  });
}

async function pickLaunchPort(hostname: string, preferredPort: number) {
  try {
    return await reservePort(hostname, preferredPort);
  } catch (error) {
    const knownError = error as NodeJS.ErrnoException;
    if (preferredPort !== 0 && knownError.code === "EADDRINUSE") {
      return reservePort(hostname, 0);
    }
    throw error;
  }
}

function isPortConflictError(error: unknown, port: number) {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes(`Failed to start server on port ${port}`) || message.includes("EADDRINUSE");
}

async function launchOpencodeServer(hostname: string, preferredPort: number, config: Record<string, unknown>) {
  const attemptedPorts = new Set<number>();
  let launchPort = await pickLaunchPort(hostname, preferredPort);
  let lastError: unknown = null;

  while (!attemptedPorts.has(launchPort)) {
    attemptedPorts.add(launchPort);

    try {
      if (launchPort !== preferredPort) {
        console.warn(`OpenCode port ${preferredPort} is unavailable; using port ${launchPort} instead.`);
      }

      return await spawnOpencodeServer(hostname, launchPort, config);
    } catch (error) {
      lastError = error;
      if (!isPortConflictError(error, launchPort)) {
        throw error;
      }
      launchPort = await pickLaunchPort(hostname, 0);
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`Unable to start OpenCode after trying ports ${Array.from(attemptedPorts).join(", ")}.`);
}

function spawnOpencodeServer(hostname: string, port: number, config: Record<string, unknown>): Promise<{ url: string; proc: ChildProcess }> {
  const args = ["serve", `--hostname=${hostname}`, `--port=${port}`];

  const proc = spawn("opencode", args, {
    shell: true,
    cwd: workspaceRoot,
    env: {
      ...process.env,
      OPENCODE_CONFIG_CONTENT: JSON.stringify(config)
    }
  });

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Timeout waiting for OpenCode server to start after 15000ms"));
    }, 15000);

    let output = "";

    proc.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      const lines = output.split("\n");
      for (const line of lines) {
        if (line.startsWith("opencode server listening")) {
          const match = line.match(/on\s+(https?:\/\/[^\s]+)/);
          if (match) {
            clearTimeout(timeout);
            resolve({ url: match[1], proc });
            return;
          }
        }
      }
    });

    proc.stderr?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });

    proc.on("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`OpenCode server exited with code ${code}\n${output}`));
    });

    proc.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

export async function getOpencode() {
  ensureAzureRuntimeEnvironment();

  if (!opencodePromise) {
    const attempt = (async () => {
      const existingUrl = `http://${runtimeConfig.opencodeHost}:${runtimeConfig.opencodePort}`;

      if (await detectExistingOpencodeServer(existingUrl)) {
        return connectOpencodeClient(existingUrl, () => {});
      }

      const { url, proc } = await launchOpencodeServer(
        runtimeConfig.opencodeHost,
        runtimeConfig.opencodePort,
        { share: "disabled" }
      );

      return connectOpencodeClient(url, () => {
        proc.kill();
      });
    })();

    opencodePromise = attempt;

    attempt.catch(() => {
      // Clear cached promise so next call retries
      if (opencodePromise === attempt) {
        opencodePromise = null;
      }
    });
  }

  return opencodePromise;
}

export async function postOpencodeJson<T>(path: string, body: unknown): Promise<T> {
  return resilientCall(
    async () => {
      const opencode = await getOpencode();
      const response = await fetch(`${opencode.server.url}${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(body)
      });

      if (!response.ok) {
        throw new Error(`OpenCode request failed for ${path}: ${response.status} ${response.statusText}`);
      }

      if (response.status === 204) {
        return undefined as T;
      }

      return (await response.json()) as T;
    },
    { breaker: breakers.opencode, shouldRetry: isRetryableError },
  );
}

export async function openOpencodeEventStream() {
  return resilientCall(
    async () => {
      const opencode = await getOpencode();
      const response = await fetch(`${opencode.server.url}/event`);

      if (!response.ok || !response.body) {
        throw new Error(`Unable to open OpenCode event stream: ${response.status} ${response.statusText}`);
      }

      return response.body.getReader();
    },
    { breaker: breakers.opencode, shouldRetry: isRetryableError },
  );
}

export async function getCeoSession() {
  if (!ceoSessionPromise) {
    const attempt = (async () => {
      const opencode = await getOpencode();
      ensureDeployment("ceoDeployment");

      const sessionResponse = await opencode.client.session.create({
        body: { title: "Arceus CEO" }
      });

      if (!sessionResponse.data) {
        throw new Error("OpenCode did not return a CEO session.");
      }

      return sessionResponse.data;
    })();

    ceoSessionPromise = attempt;

    attempt.catch(() => {
      if (ceoSessionPromise === attempt) {
        ceoSessionPromise = null;
      }
    });
  }

  return ceoSessionPromise;
}
