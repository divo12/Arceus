import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, resolveHippocampusMode } from "../config.js";

const ORIGINAL_PAPERCLIP_HIPPOCAMPUS_MODE = process.env.PAPERCLIP_HIPPOCAMPUS_MODE;
const ORIGINAL_PAPERCLIP_HIPPOCAMPUS_PYTHON_BIN = process.env.PAPERCLIP_HIPPOCAMPUS_PYTHON_BIN;
const ORIGINAL_PAPERCLIP_HIPPOCAMPUS_STARTUP_TIMEOUT_MS = process.env.PAPERCLIP_HIPPOCAMPUS_STARTUP_TIMEOUT_MS;
const ORIGINAL_PAPERCLIP_HIPPOCAMPUS_REQUEST_TIMEOUT_MS = process.env.PAPERCLIP_HIPPOCAMPUS_REQUEST_TIMEOUT_MS;

afterEach(() => {
  if (ORIGINAL_PAPERCLIP_HIPPOCAMPUS_MODE === undefined) delete process.env.PAPERCLIP_HIPPOCAMPUS_MODE;
  else process.env.PAPERCLIP_HIPPOCAMPUS_MODE = ORIGINAL_PAPERCLIP_HIPPOCAMPUS_MODE;

  if (ORIGINAL_PAPERCLIP_HIPPOCAMPUS_PYTHON_BIN === undefined) delete process.env.PAPERCLIP_HIPPOCAMPUS_PYTHON_BIN;
  else process.env.PAPERCLIP_HIPPOCAMPUS_PYTHON_BIN = ORIGINAL_PAPERCLIP_HIPPOCAMPUS_PYTHON_BIN;

  if (ORIGINAL_PAPERCLIP_HIPPOCAMPUS_STARTUP_TIMEOUT_MS === undefined) {
    delete process.env.PAPERCLIP_HIPPOCAMPUS_STARTUP_TIMEOUT_MS;
  } else {
    process.env.PAPERCLIP_HIPPOCAMPUS_STARTUP_TIMEOUT_MS = ORIGINAL_PAPERCLIP_HIPPOCAMPUS_STARTUP_TIMEOUT_MS;
  }

  if (ORIGINAL_PAPERCLIP_HIPPOCAMPUS_REQUEST_TIMEOUT_MS === undefined) {
    delete process.env.PAPERCLIP_HIPPOCAMPUS_REQUEST_TIMEOUT_MS;
  } else {
    process.env.PAPERCLIP_HIPPOCAMPUS_REQUEST_TIMEOUT_MS = ORIGINAL_PAPERCLIP_HIPPOCAMPUS_REQUEST_TIMEOUT_MS;
  }
});

describe("hippocampus config", () => {
  it("defaults to off when no mode is configured", () => {
    delete process.env.PAPERCLIP_HIPPOCAMPUS_MODE;

    expect(resolveHippocampusMode()).toBe("off");
    expect(loadConfig().hippocampusMode).toBe("off");
  });

  it("parses embedded mode and runtime tuning fields", () => {
    process.env.PAPERCLIP_HIPPOCAMPUS_MODE = "embedded";
    process.env.PAPERCLIP_HIPPOCAMPUS_PYTHON_BIN = "/usr/bin/python3";
    process.env.PAPERCLIP_HIPPOCAMPUS_STARTUP_TIMEOUT_MS = "20000";
    process.env.PAPERCLIP_HIPPOCAMPUS_REQUEST_TIMEOUT_MS = "45000";

    const config = loadConfig();

    expect(config.hippocampusMode).toBe("embedded");
    expect(config.hippocampusPythonBin).toBe("/usr/bin/python3");
    expect(config.hippocampusStartupTimeoutMs).toBe(20000);
    expect(config.hippocampusRequestTimeoutMs).toBe(45000);
  });
});
