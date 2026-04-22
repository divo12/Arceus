/**
 * Resilience utilities: retry with exponential backoff + circuit breaker.
 *
 * Applied to all external integrations: Azure OpenAI, Supabase, OpenCode.
 */

/* ------------------------------------------------------------------ */
/*  Retry                                                              */
/* ------------------------------------------------------------------ */

export interface RetryOptions {
  /** Maximum number of attempts (including the first). Default: 3 */
  maxRetries: number;
  /** Initial delay in ms before the first retry. Default: 1000 */
  delay: number;
  /** Multiplicative backoff factor. Default: 2 */
  backoff: number;
  /** Optional predicate — return false to skip retrying a specific error. */
  shouldRetry?: (error: unknown) => boolean;
  /** Called before each retry with attempt index (1-based) and the error. */
  onRetry?: (attempt: number, error: unknown) => void;
}

const DEFAULT_RETRY: RetryOptions = {
  maxRetries: 3,
  delay: 1000,
  backoff: 2,
};

/** Execute `fn` with exponential backoff retries and jitter. */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: Partial<RetryOptions> = {},
): Promise<T> {
  const { maxRetries, delay, backoff, shouldRetry, onRetry } = {
    ...DEFAULT_RETRY,
    ...opts,
  };

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      if (attempt === maxRetries) break;
      if (shouldRetry && !shouldRetry(error)) break;

      onRetry?.(attempt, error);

      const jitter = Math.random() * 0.3 + 0.85; // 0.85–1.15
      const wait = delay * Math.pow(backoff, attempt - 1) * jitter;
      await new Promise((r) => setTimeout(r, wait));
    }
  }

  throw lastError;
}

/* ------------------------------------------------------------------ */
/*  Circuit Breaker                                                    */
/* ------------------------------------------------------------------ */

type CircuitState = "closed" | "open" | "half_open";

export interface CircuitBreakerOptions {
  /** Consecutive failures before opening. Default: 5 */
  failureThreshold: number;
  /** How long (ms) to stay open before allowing a probe. Default: 30 000 */
  cooldownMs: number;
  /** Name for logging. */
  name: string;
  /** Called on state transitions. */
  onStateChange?: (from: CircuitState, to: CircuitState, name: string) => void;
}

export class CircuitBreaker {
  private state: CircuitState = "closed";
  private consecutiveFailures = 0;
  private lastFailureAt = 0;
  private readonly opts: CircuitBreakerOptions;

  constructor(opts: Partial<CircuitBreakerOptions> & { name: string }) {
    this.opts = {
      failureThreshold: 5,
      cooldownMs: 30_000,
      ...opts,
    };
  }

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === "open") {
      if (Date.now() - this.lastFailureAt >= this.opts.cooldownMs) {
        this.transition("half_open");
      } else {
        throw new CircuitOpenError(this.opts.name, this.opts.cooldownMs - (Date.now() - this.lastFailureAt));
      }
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  /** Current breaker state for health checks. */
  getState(): { state: CircuitState; consecutiveFailures: number; name: string } {
    return {
      state: this.state,
      consecutiveFailures: this.consecutiveFailures,
      name: this.opts.name,
    };
  }

  /** Manually reset (e.g. after a config fix). */
  reset(): void {
    this.consecutiveFailures = 0;
    this.transition("closed");
  }

  private onSuccess(): void {
    this.consecutiveFailures = 0;
    if (this.state === "half_open") {
      this.transition("closed");
    }
  }

  private onFailure(): void {
    this.consecutiveFailures++;
    this.lastFailureAt = Date.now();

    if (this.state === "half_open") {
      this.transition("open");
    } else if (this.consecutiveFailures >= this.opts.failureThreshold) {
      this.transition("open");
    }
  }

  private transition(to: CircuitState): void {
    if (this.state === to) return;
    const from = this.state;
    this.state = to;
    this.opts.onStateChange?.(from, to, this.opts.name);
  }
}

export class CircuitOpenError extends Error {
  constructor(
    public readonly breakerName: string,
    public readonly retryAfterMs: number,
  ) {
    super(`Circuit breaker "${breakerName}" is open. Retry after ${Math.ceil(retryAfterMs / 1000)}s.`);
    this.name = "CircuitOpenError";
  }
}

/* ------------------------------------------------------------------ */
/*  Combined: resilient call = circuit breaker + retry                 */
/* ------------------------------------------------------------------ */

export interface ResilientCallOptions extends Partial<RetryOptions> {
  breaker: CircuitBreaker;
}

/**
 * Runs `fn` through a circuit breaker with automatic retries.
 * Retries happen *inside* the breaker — each attempt counts toward
 * the breaker's failure threshold independently.
 */
export async function resilientCall<T>(
  fn: () => Promise<T>,
  opts: ResilientCallOptions,
): Promise<T> {
  return opts.breaker.execute(() => withRetry(fn, opts));
}

/* ------------------------------------------------------------------ */
/*  Pre-built breakers for each integration                            */
/* ------------------------------------------------------------------ */

/** Log circuit breaker state transitions to console at appropriate severity. */
function logStateChange(from: CircuitState, to: CircuitState, name: string) {
  const level = to === "open" ? "error" : to === "closed" ? "info" : "warn";
  const msg = `[circuit-breaker] ${name}: ${from} → ${to}`;
  if (level === "error") console.error(msg);
  else if (level === "warn") console.warn(msg);
  else console.log(msg);
}

export const breakers = {
  azureOpenAI: new CircuitBreaker({
    name: "azure-openai",
    failureThreshold: 3,
    cooldownMs: 30_000,
    onStateChange: logStateChange,
  }),
  supabase: new CircuitBreaker({
    name: "supabase",
    failureThreshold: 5,
    cooldownMs: 20_000,
    onStateChange: logStateChange,
  }),
  opencode: new CircuitBreaker({
    name: "opencode",
    failureThreshold: 3,
    cooldownMs: 15_000,
    onStateChange: logStateChange,
  }),
} as const;

/** Snapshot of all breakers for the /api/health endpoint. */
export function getBreakersHealth() {
  return Object.values(breakers).map((b) => b.getState());
}

/* ------------------------------------------------------------------ */
/*  Helpers for classifying retryable errors                           */
/* ------------------------------------------------------------------ */

/** HTTP status codes worth retrying (server-side transient). */
/** Return true for HTTP status codes that indicate transient server errors. */
export function isRetryableHttpStatus(status: number): boolean {
  return status === 429 || status === 502 || status === 503 || status === 504;
}

/** Classify fetch errors and HTTP error responses. */
/** Classify whether a fetch/HTTP error is transient and worth retrying. */
export function isRetryableError(error: unknown): boolean {
  if (error instanceof CircuitOpenError) return false;

  if (error instanceof TypeError) {
    // fetch network errors: "fetch failed", "network error", etc.
    return true;
  }

  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    // Timeout, connection reset, DNS
    // Exclude prompt-level timeouts — retrying a slow LLM call is pointless.
    if (msg.includes("prompt timed out")) return false;
    if (msg.includes("timeout") || msg.includes("econnreset") || msg.includes("enotfound")) {
      return true;
    }
    // Stale OpenCode session: "Item with id '...' not found"
    if (msg.includes("item with id") && msg.includes("not found")) {
      return true;
    }
    // Azure OpenAI rate limit or transient server error
    const statusMatch = msg.match(/error (\d{3})/);
    if (statusMatch) {
      return isRetryableHttpStatus(Number(statusMatch[1]));
    }
  }

  return false;
}
