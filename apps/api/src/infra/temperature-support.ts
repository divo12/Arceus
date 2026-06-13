/**
 * Pure helper: does an Azure deployment's model accept a custom `temperature`?
 *
 * Some Azure models (small/reasoning variants like gpt-5-nano, the o-series)
 * reject ANY non-default temperature with a deterministic HTTP 400
 * ("Only the default (1) value is supported"). Because 400 is non-retryable
 * AND counts as a failure on the SHARED `azure-openai` circuit breaker,
 * sending an unsupported temperature doesn't just fail one call — after the
 * breaker's threshold it OPENS and blocks EVERY direct LLM caller (verifier,
 * scoring, strategy, …) for the cooldown window.
 *
 * Root cause found live 2026-06-13: `gpt-5-nano` (the memory deployment)
 * 400'd on `temperature: 0.1` from the memory extractor, repeatedly tripping
 * the breaker and taking down the code-review verifier. A direct probe
 * verified gpt-5.2 (ceo/worker) DOES support custom temperature — so we strip
 * temperature ONLY for locked deployments, never globally.
 *
 * Kept config-free (no runtimeConfig import) so it's unit-testable without
 * the Azure env vars present. The caller passes the locked-CSV from config.
 */
export function deploymentSupportsTemperature(deployment: string, lockedCsv?: string): boolean {
  const d = deployment.trim().toLowerCase();
  if (!d) return true;

  const locked = (lockedCsv ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (locked.includes(d)) return false;

  // Built-in defaults so PROD is safe even when the env override is unset.
  if (d.includes("nano")) return false; // gpt-5-nano (verified) + future *-nano
  if (/(^|[-/])o[134](-|$)/.test(d)) return false; // o1 / o3 / o4 reasoning models
  return true;
}
