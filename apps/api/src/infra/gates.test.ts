import { describe, expect, it } from "bun:test";
import { TryRunGate, OncePromise } from "./gates.js";

describe("TryRunGate", () => {
  it("concurrent callers — first wins, others get null", async () => {
    const gate = new TryRunGate();
    let observed = 0;
    const slow = () => new Promise<string>((resolve) => {
      setTimeout(() => { observed++; resolve("done"); }, 20);
    });

    const [a, b, c] = await Promise.all([
      gate.runExclusive(slow),
      gate.runExclusive(slow),
      gate.runExclusive(slow),
    ]);

    expect(observed).toBe(1);            // body ran exactly once
    expect([a, b, c].filter((x) => x === "done")).toHaveLength(1);
    expect([a, b, c].filter((x) => x === null)).toHaveLength(2);
    expect(gate.isInFlight).toBe(false); // released after work
  });

  it("releases flag even if body throws", async () => {
    const gate = new TryRunGate();
    await expect(
      gate.runExclusive(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(gate.isInFlight).toBe(false);

    // Subsequent caller can claim the gate cleanly.
    const result = await gate.runExclusive(() => Promise.resolve("ok"));
    expect(result).toBe("ok");
  });

  it("sequential callers each get their own run", async () => {
    const gate = new TryRunGate();
    const a = await gate.runExclusive(() => Promise.resolve("a"));
    const b = await gate.runExclusive(() => Promise.resolve("b"));
    expect(a).toBe("a");
    expect(b).toBe("b");
  });
});

describe("OncePromise", () => {
  it("concurrent callers share the same promise — body runs once", async () => {
    const once = new OncePromise<string>();
    let observed = 0;
    const slow = () => new Promise<string>((resolve) => {
      setTimeout(() => { observed++; resolve("started"); }, 20);
    });

    const [a, b, c] = await Promise.all([
      once.run(slow),
      once.run(slow),
      once.run(slow),
    ]);

    expect(observed).toBe(1);
    expect(a).toBe("started");
    expect(b).toBe("started");
    expect(c).toBe("started");
  });

  it("clears on resolve so next call starts fresh", async () => {
    const once = new OncePromise<number>();
    let n = 0;
    const factory = () => Promise.resolve(++n);

    expect(await once.run(factory)).toBe(1);
    expect(once.isInFlight).toBe(false);
    expect(await once.run(factory)).toBe(2);
  });

  it("clears on reject so next call can retry", async () => {
    const once = new OncePromise<string>();
    let attempt = 0;
    const factory = (): Promise<string> => {
      attempt++;
      if (attempt === 1) return Promise.reject(new Error("first try fails"));
      return Promise.resolve("second try ok");
    };

    await expect(once.run(factory)).rejects.toThrow("first try fails");
    expect(once.isInFlight).toBe(false);
    expect(await once.run(factory)).toBe("second try ok");
    expect(attempt).toBe(2);
  });
});
