import { describe, expect, it } from "bun:test";
import { deploymentSupportsTemperature } from "./temperature-support.js";

describe("deploymentSupportsTemperature", () => {
  it("strips temperature for gpt-5-nano (verified live to 400 on temperature≠1)", () => {
    expect(deploymentSupportsTemperature("gpt-5-nano")).toBe(false);
    expect(deploymentSupportsTemperature("GPT-5-NANO")).toBe(false);
  });

  it("keeps temperature for gpt-5.2 (verified live to accept custom temperature)", () => {
    expect(deploymentSupportsTemperature("gpt-5.2")).toBe(true);
  });

  it("keeps temperature for mainstream chat models", () => {
    expect(deploymentSupportsTemperature("gpt-4o")).toBe(true);
    expect(deploymentSupportsTemperature("gpt-4o-mini")).toBe(true);
    expect(deploymentSupportsTemperature("gpt-4.1")).toBe(true);
  });

  it("strips temperature for o-series reasoning models", () => {
    expect(deploymentSupportsTemperature("o1")).toBe(false);
    expect(deploymentSupportsTemperature("o3-mini")).toBe(false);
    expect(deploymentSupportsTemperature("o4-preview")).toBe(false);
  });

  it("respects the env-driven locked list (case-insensitive, trimmed)", () => {
    expect(deploymentSupportsTemperature("my-custom", " my-custom , other ")).toBe(false);
    expect(deploymentSupportsTemperature("My-Custom", "my-custom")).toBe(false);
    expect(deploymentSupportsTemperature("kept", "my-custom")).toBe(true);
  });

  it("defaults to supported for unknown deployments and empty input", () => {
    expect(deploymentSupportsTemperature("some-future-model")).toBe(true);
    expect(deploymentSupportsTemperature("")).toBe(true);
  });
});
