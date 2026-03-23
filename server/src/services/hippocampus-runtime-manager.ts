import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type ExtractResult,
  type HabitItem,
  type HealthResult,
  type HippocampusRuntimeDiagnostics,
  HippocampusTimeoutError,
  HippocampusUnavailableError,
  type MemoryItem,
  type MemoryListItem,
  type MemorySummary,
  type PromotionItem,
} from "./hippocampus-contract.js";
import {
  createHippocampusRpcRequest,
  type HippocampusJsonRpcResponse,
  isHippocampusRpcResponse,
  parseHippocampusRpcMessage,
  serializeHippocampusRpcMessage,
  type HippocampusRpcMethodMap,
  type HippocampusRpcMethodName,
} from "./hippocampus-protocol.js";

type RuntimeStatus = HippocampusRuntimeDiagnostics["status"];
type RpcMethodMap = HippocampusRpcMethodMap;
type RpcMethodName = HippocampusRpcMethodName;
type RpcMethodParams<M extends RpcMethodName> = RpcMethodMap[M]["params"];
type RpcMethodResult<M extends RpcMethodName> = RpcMethodMap[M]["result"];

interface PendingRequest<TResult> {
  reject: (reason?: unknown) => void;
  resolve: (value: TResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface HippocampusRuntimeManagerOptions {
  command: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  startupTimeoutMs?: number;
  requestTimeoutMs?: number;
  shutdownDrainMs?: number;
  sigtermGraceMs?: number;
  autoRestart?: boolean;
  restartBackoffMs?: number[];
  minBackoffMs?: number;
  maxBackoffMs?: number;
  maxConsecutiveCrashes?: number;
  crashWindowMs?: number;
}

const DEFAULT_STARTUP_TIMEOUT_MS = 15_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_SHUTDOWN_DRAIN_MS = 10_000;
const DEFAULT_SIGTERM_GRACE_MS = 5_000;
const DEFAULT_RESTART_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000];
const DEFAULT_MAX_CONSECUTIVE_CRASHES = 5;
const DEFAULT_CRASH_WINDOW_MS = 10 * 60 * 1_000;
const MAX_STDERR_EXCERPT_CHARS = 8_000;

export function appendRuntimeStderrExcerpt(current: string, chunk: string): string {
  const next = current ? `${current}\n${chunk}` : chunk;
  return next.length <= MAX_STDERR_EXCERPT_CHARS
    ? next
    : next.slice(-MAX_STDERR_EXCERPT_CHARS);
}

export function formatRuntimeFailureMessage(message: string, stderrExcerpt: string): string {
  const excerpt = stderrExcerpt.trim();
  if (!excerpt) return message;
  if (message.includes(excerpt)) return message;
  return `${message}\n\nRuntime stderr:\n${excerpt}`;
}

export function resolveDefaultHippocampusRuntimeOptions(
  pythonBin: string,
  startupTimeoutMs: number,
  requestTimeoutMs: number,
): HippocampusRuntimeManagerOptions {
  const serverDir = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(serverDir, "../../..");
  const runtimeCwd = resolve(repoRoot, "services/hippocampus-runtime/python");
  const runtimeSrc = resolve(runtimeCwd, "src");
  const currentPythonPath = process.env.PYTHONPATH;

  return {
    command: pythonBin,
    args: ["-m", "arceus.core.hippocampus.stdio_rpc"],
    cwd: runtimeCwd,
    env: {
      ...process.env,
      PYTHONPATH: currentPythonPath
        ? `${runtimeSrc}${process.platform === "win32" ? ";" : ":"}${currentPythonPath}`
        : runtimeSrc,
    },
    startupTimeoutMs,
    requestTimeoutMs,
  };
}

export class HippocampusRuntimeManager {
  private readonly options: Required<Omit<
    HippocampusRuntimeManagerOptions,
    "cwd" | "env" | "minBackoffMs" | "maxBackoffMs"
  >> & Pick<HippocampusRuntimeManagerOptions, "cwd" | "env">;

  private child: ChildProcessWithoutNullStreams | null = null;
  private stdoutInterface: ReadlineInterface | null = null;
  private stderrInterface: ReadlineInterface | null = null;
  private status: RuntimeStatus = "stopped";
  private nextRequestId = 1;
  private readonly pending = new Map<number, PendingRequest<unknown>>();
  private intentionalStop = false;
  private stderrExcerpt = "";
  private startPromise: Promise<void> | null = null;
  private restartPromise: Promise<void> | null = null;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private exitPromise: Promise<void> | null = null;
  private resolveExitPromise: (() => void) | null = null;
  private consecutiveCrashes = 0;
  private totalCrashes = 0;
  private lastCrashAt: number | null = null;
  private nextRestartAt: number | null = null;

  constructor(options: HippocampusRuntimeManagerOptions) {
    const restartBackoffMs = options.restartBackoffMs
      ?? (
        options.minBackoffMs !== undefined || options.maxBackoffMs !== undefined
          ? [options.minBackoffMs ?? DEFAULT_RESTART_BACKOFF_MS[0], options.maxBackoffMs ?? options.minBackoffMs ?? DEFAULT_RESTART_BACKOFF_MS[0]]
          : DEFAULT_RESTART_BACKOFF_MS
      );
    this.options = {
      command: options.command,
      args: options.args,
      cwd: options.cwd,
      env: options.env,
      startupTimeoutMs: options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS,
      requestTimeoutMs: options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      shutdownDrainMs: options.shutdownDrainMs ?? DEFAULT_SHUTDOWN_DRAIN_MS,
      sigtermGraceMs: options.sigtermGraceMs ?? DEFAULT_SIGTERM_GRACE_MS,
      autoRestart: options.autoRestart ?? true,
      restartBackoffMs,
      maxConsecutiveCrashes: options.maxConsecutiveCrashes ?? DEFAULT_MAX_CONSECUTIVE_CRASHES,
      crashWindowMs: options.crashWindowMs ?? DEFAULT_CRASH_WINDOW_MS,
    };
  }

  diagnostics(): HippocampusRuntimeDiagnostics {
    return {
      mode: "embedded",
      status: this.status,
      pid: this.child?.pid ?? null,
      pendingRequests: this.pending.size,
      consecutiveCrashes: this.consecutiveCrashes,
      totalCrashes: this.totalCrashes,
      lastCrashAt: this.lastCrashAt,
      nextRestartAt: this.nextRestartAt,
      stderrExcerpt: this.stderrExcerpt,
    };
  }

  async start(): Promise<void> {
    if (this.status === "running") return;
    if (this.startPromise) return this.startPromise;
    if (this.restartPromise) return this.restartPromise;

    this.startPromise = this.startInternal().finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  private async startInternal(): Promise<void> {
    this.clearRestartTimer();
    this.intentionalStop = false;
    this.stderrExcerpt = "";
    this.status = "starting";

    const child = spawn(this.options.command, this.options.args, {
      cwd: this.options.cwd,
      env: this.options.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    this.exitPromise = new Promise<void>((resolve) => {
      this.resolveExitPromise = resolve;
    });

    this.stdoutInterface = createInterface({ input: child.stdout });
    this.stderrInterface = createInterface({ input: child.stderr });
    this.stdoutInterface.on("line", (line) => {
      void this.handleStdoutLine(line);
    });
    this.stderrInterface.on("line", (line) => {
        this.stderrExcerpt = appendRuntimeStderrExcerpt(this.stderrExcerpt, line);
    });

    child.on("error", (error) => {
      this.rejectAllPending(new HippocampusUnavailableError(error.message));
    });
    child.on("exit", (code, signal) => {
      void this.handleExit(code, signal);
    });

    try {
      await this.call("health", {}, this.options.startupTimeoutMs, true);
      this.status = "running";
      this.consecutiveCrashes = 0;
      this.nextRestartAt = null;
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.clearRestartTimer();
    this.restartPromise = null;
    this.intentionalStop = true;

    const child = this.child;
    if (!child) {
      this.status = "stopped";
      return;
    }

    this.status = "stopping";
    try {
      await this.call("shutdown", {}, this.options.shutdownDrainMs, true);
    } catch {
      // Ignore shutdown RPC failure and continue to process termination.
    }

    const exitedDuringDrain = await this.waitForExit(this.options.shutdownDrainMs);
    if (!exitedDuringDrain && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      const exitedAfterSigterm = await this.waitForExit(this.options.sigtermGraceMs);
      if (!exitedAfterSigterm && child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await this.waitForExit(1_000);
      }
    }
  }

  async call<M extends RpcMethodName>(
    method: M,
    params: RpcMethodParams<M>,
    timeoutMs = this.options.requestTimeoutMs,
    allowWhileStarting = false,
  ): Promise<RpcMethodResult<M>> {
    if (!allowWhileStarting) {
      await this.ensureReady();
    }

    const child = this.child;
    if (!child?.stdin.writable) {
      throw new HippocampusUnavailableError(
          formatRuntimeFailureMessage(
            "Hippocampus runtime process is not writable",
            this.stderrExcerpt,
          ),
      );
    }

    const id = this.nextRequestId++;
    const request = createHippocampusRpcRequest(id, method, params);

    return new Promise<RpcMethodResult<M>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new HippocampusTimeoutError(`Hippocampus ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });
      child.stdin.write(serializeHippocampusRpcMessage(request), (error) => {
        if (!error) return;
        clearTimeout(timer);
        this.pending.delete(id);
        reject(
          new HippocampusUnavailableError(
            formatRuntimeFailureMessage(
              `Failed to write Hippocampus request ${method}: ${error.message}`,
              this.stderrExcerpt,
            ),
          ),
        );
      });
    });
  }

  private async ensureReady(): Promise<void> {
    if (this.status === "running") return;
    if (this.startPromise) return this.startPromise;
    if (this.restartPromise) return this.restartPromise;
    if (this.status === "stopped" || this.status === "crashed") {
      return this.start();
    }
    if (this.status === "starting") {
      if (this.startPromise) return this.startPromise;
      return;
    }
    throw new HippocampusUnavailableError(
      formatRuntimeFailureMessage(
        `Hippocampus runtime is ${this.status}`,
        this.stderrExcerpt,
      ),
    );
  }

  private async handleStdoutLine(line: string): Promise<void> {
    if (!line.trim()) return;

    let message: HippocampusJsonRpcResponse<unknown>;
    try {
      message = parseHippocampusRpcMessage(line) as HippocampusJsonRpcResponse<unknown>;
    } catch {
      return;
    }

    if (!isHippocampusRpcResponse(message)) {
      return;
    }

    const pendingId = typeof message.id === "number" ? message.id : null;
    const pending = pendingId !== null ? this.pending.get(pendingId) : undefined;
    if (pendingId === null || !pending) return;

    clearTimeout(pending.timer);
    this.pending.delete(pendingId);

    if ("error" in message && message.error) {
      const errorMessage = message.error.message || "Unknown Hippocampus RPC error";
      pending.reject(
        new HippocampusUnavailableError(
          formatRuntimeFailureMessage(errorMessage, this.stderrExcerpt),
        ),
      );
      return;
    }

    pending.resolve(message.result);
  }

  private async handleExit(code: number | null, signal: NodeJS.Signals | null): Promise<void> {
    this.stdoutInterface?.removeAllListeners();
    this.stdoutInterface?.close();
    this.stdoutInterface = null;
    this.stderrInterface?.removeAllListeners();
    this.stderrInterface?.close();
    this.stderrInterface = null;
    this.child = null;

    this.resolveExitPromise?.();
    this.resolveExitPromise = null;
    this.exitPromise = null;

    const exitMessage = formatRuntimeFailureMessage(
      `Hippocampus runtime exited (code=${code}, signal=${signal})`,
      this.stderrExcerpt,
    );
    this.rejectAllPending(new HippocampusUnavailableError(exitMessage));

    if (this.intentionalStop) {
      this.status = "stopped";
      this.nextRestartAt = null;
      return;
    }

    this.totalCrashes += 1;
    const now = Date.now();
    if (this.lastCrashAt && now - this.lastCrashAt <= this.options.crashWindowMs) {
      this.consecutiveCrashes += 1;
    } else {
      this.consecutiveCrashes = 1;
    }
    this.lastCrashAt = now;
    this.status = "crashed";

    if (
      !this.options.autoRestart
      || this.consecutiveCrashes > this.options.maxConsecutiveCrashes
    ) {
      return;
    }

    const backoffIndex = Math.min(
      this.consecutiveCrashes - 1,
      this.options.restartBackoffMs.length - 1,
    );
    const delay = this.options.restartBackoffMs[backoffIndex];
    this.status = "backoff";
    this.nextRestartAt = now + delay;
    this.restartPromise = new Promise<void>((resolve, reject) => {
      this.restartTimer = setTimeout(() => {
        this.restartTimer = null;
        this.startInternal()
          .then(resolve)
          .catch(reject)
          .finally(() => {
            this.restartPromise = null;
          });
      }, delay);
    });
  }

  private clearRestartTimer(): void {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    this.nextRestartAt = null;
  }

  private rejectAllPending(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }

  private async waitForExit(timeoutMs: number): Promise<boolean> {
    const exitPromise = this.exitPromise;
    if (!exitPromise) return true;

    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      void exitPromise.then(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }
}
