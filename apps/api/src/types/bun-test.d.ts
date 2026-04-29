/**
 * Minimal ambient declaration for `bun:test` so tsc accepts the
 * imports in `*.test.ts` files. We don't pull in `@types/bun` /
 * `bun-types` because they globally shadow `ReadableStreamDefaultReader`
 * (and other lib types) in a way that breaks `agents/chat.ts` and
 * other SSE-reading code paths.
 *
 * Only the surface our tests use is typed; expand as needed.
 */
declare module "bun:test" {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type AnyFn = (...args: any[]) => any;

  export interface BunMockFn<F extends AnyFn = AnyFn> {
    (...args: Parameters<F>): ReturnType<F>;
    mock: {
      calls: Parameters<F>[];
      results: { type: "return" | "throw"; value: unknown }[];
    };
  }

  /** Bun's mock factory: returns a callable spy with `.mock.calls`. */
  export function mock<F extends AnyFn>(impl?: F): BunMockFn<F>;
  export namespace mock {
    function module(specifier: string, factory: () => Record<string, unknown>): void;
  }

  export function describe(name: string, fn: () => void): void;
  export function it(name: string, fn: () => void | Promise<void>): void;

  interface Matchers {
    toBe(expected: unknown): void;
    toEqual(expected: unknown): void;
    toBeNull(): void;
    toBeDefined(): void;
    toBeUndefined(): void;
    toBeLessThan(expected: number): void;
    toBeGreaterThan(expected: number): void;
    toMatch(pattern: string | RegExp): void;
    toHaveBeenCalled(): void;
    toHaveBeenCalledTimes(n: number): void;
    toHaveLength(n: number): void;
    not: Omit<Matchers, "not">;
  }

  /** Surface for `expect(asyncFn()).rejects.toThrow(/pattern/)`. */
  interface AsyncMatchers {
    toThrow(pattern?: string | RegExp): Promise<void>;
  }

  type ExpectResult = Matchers & {
    rejects: AsyncMatchers;
    resolves: Matchers;
  };

  export function expect(actual: unknown): ExpectResult;
}
