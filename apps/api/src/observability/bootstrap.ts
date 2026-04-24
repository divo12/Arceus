/**
 * Spec 32 Phase 2 — OpenTelemetry bootstrap for the Arceus API.
 *
 * Must be imported BEFORE any module that calls `trace.getTracer(...)` — the
 * SDK has to install its global tracer provider first or spans get silently
 * dropped. Convention: `import "./observability/bootstrap.js";` is the very
 * first import in `apps/api/src/server.ts`.
 *
 * Wires:
 *   - OTLP HTTP exporter pointed at Langfuse Cloud (us.cloud.langfuse.com).
 *   - Authorization header: Basic base64("public:secret") per Langfuse OTLP docs.
 *   - Service name: arceus-api (resource attribute).
 *
 * Behaviour:
 *   - Disabled if LANGFUSE_PUBLIC_KEY or LANGFUSE_SECRET_KEY is missing.
 *     A warning logs once at startup; the process keeps running. The OTEL sink
 *     can still be installed; spans just go to the no-op global provider.
 */
import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { Resource } from "@opentelemetry/resources";
import {
  SEMRESATTRS_SERVICE_NAME,
  SEMRESATTRS_SERVICE_VERSION,
} from "@opentelemetry/semantic-conventions";

let started = false;
let sdk: NodeSDK | null = null;

export interface ObservabilityBootstrapOptions {
  serviceName?: string;
  serviceVersion?: string;
  /** Override the Langfuse OTLP endpoint. Defaults to LANGFUSE_BASE_URL env. */
  endpointUrl?: string;
  /** Override the public key. Defaults to LANGFUSE_PUBLIC_KEY env. */
  publicKey?: string;
  /** Override the secret key. Defaults to LANGFUSE_SECRET_KEY env. */
  secretKey?: string;
}

function langfuseOtlpUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/$/, "");
  return `${trimmed}/api/public/otel/v1/traces`;
}

function basicAuthHeader(publicKey: string, secretKey: string): string {
  return `Basic ${Buffer.from(`${publicKey}:${secretKey}`).toString("base64")}`;
}

/**
 * Initialise OpenTelemetry. Idempotent: subsequent calls are no-ops.
 * Returns true if the SDK started, false if it was disabled (missing creds).
 */
export function startObservability(options: ObservabilityBootstrapOptions = {}): boolean {
  if (started) return true;

  const baseUrl = options.endpointUrl ?? process.env.LANGFUSE_BASE_URL;
  const publicKey = options.publicKey ?? process.env.LANGFUSE_PUBLIC_KEY;
  const secretKey = options.secretKey ?? process.env.LANGFUSE_SECRET_KEY;

  if (!baseUrl || !publicKey || !secretKey) {
    // eslint-disable-next-line no-console
    console.warn(
      "[observability] LANGFUSE_BASE_URL / LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY missing — OTEL exporter disabled. Spans will be dropped.",
    );
    return false;
  }

  const exporter = new OTLPTraceExporter({
    url: langfuseOtlpUrl(baseUrl),
    headers: {
      Authorization: basicAuthHeader(publicKey, secretKey),
    },
  });

  sdk = new NodeSDK({
    resource: new Resource({
      [SEMRESATTRS_SERVICE_NAME]: options.serviceName ?? "arceus-api",
      [SEMRESATTRS_SERVICE_VERSION]: options.serviceVersion ?? "0.1.0",
    }),
    traceExporter: exporter,
  });

  sdk.start();
  started = true;

  // eslint-disable-next-line no-console
  console.info(`[observability] OTEL exporter started → ${langfuseOtlpUrl(baseUrl)}`);

  // Best-effort flush on shutdown so we don't lose the last batch.
  const shutdown = async () => {
    try {
      await sdk?.shutdown();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[observability] shutdown error:", err);
    }
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);

  return true;
}

/** For tests — restart bootstrap state cleanly. */
export async function _resetObservability(): Promise<void> {
  if (sdk) {
    await sdk.shutdown();
    sdk = null;
  }
  started = false;
}
