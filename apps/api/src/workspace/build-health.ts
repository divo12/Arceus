/**
 * In-memory build-health cache shared by workspace_get_build_health and
 * workspace_verify_baseline. Producers (verify-baseline, future CI hooks)
 * call recordX(); readers call getHealth().
 */

type CategoryStatus = "ok" | "fail" | "unknown";

interface CategoryHealth {
  status: CategoryStatus;
  errorsFirstN: string[];
  since: string | null;
}

interface BuildHealth {
  typecheck: CategoryHealth;
  build: CategoryHealth;
  test: CategoryHealth;
  preview: CategoryHealth;
}

const empty = (): CategoryHealth => ({ status: "unknown", errorsFirstN: [], since: null });

const cache: BuildHealth = {
  typecheck: empty(),
  build: empty(),
  test: empty(),
  preview: empty(),
};

const MAX_ERRORS = 3;

const record = (category: keyof BuildHealth, ok: boolean, errors: string[]): void => {
  cache[category] = {
    status: ok ? "ok" : "fail",
    errorsFirstN: errors.slice(0, MAX_ERRORS),
    since: new Date().toISOString(),
  };
};

export const recordTypecheck = (ok: boolean, errors: string[] = []): void => { record("typecheck", ok, errors); };
export const recordPreview = (ok: boolean, errors: string[] = []): void => { record("preview", ok, errors); };

export const getHealth = (): BuildHealth => ({
  typecheck: { ...cache.typecheck },
  build: { ...cache.build },
  test: { ...cache.test },
  preview: { ...cache.preview },
});

