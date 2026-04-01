import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, resolveHippocampusMode } from "../config.js";

const ORIGINAL_PAPERCLIP_HIPPOCAMPUS_MODE = process.env.PAPERCLIP_HIPPOCAMPUS_MODE;
const ORIGINAL_PAPERCLIP_HIPPOCAMPUS_PYTHON_BIN = process.env.PAPERCLIP_HIPPOCAMPUS_PYTHON_BIN;
const ORIGINAL_PAPERCLIP_HIPPOCAMPUS_STARTUP_TIMEOUT_MS = process.env.PAPERCLIP_HIPPOCAMPUS_STARTUP_TIMEOUT_MS;
const ORIGINAL_PAPERCLIP_HIPPOCAMPUS_REQUEST_TIMEOUT_MS = process.env.PAPERCLIP_HIPPOCAMPUS_REQUEST_TIMEOUT_MS;
const ORIGINAL_REDIS_URL = process.env.REDIS_URL;

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

  if (ORIGINAL_REDIS_URL === undefined) delete process.env.REDIS_URL;
  else process.env.REDIS_URL = ORIGINAL_REDIS_URL;
});

describe("hippocampus config", () => {
  it("defaults to active when no mode is configured", () => {
    delete process.env.PAPERCLIP_HIPPOCAMPUS_MODE;
    process.env.REDIS_URL = "redis://localhost:6379/0";

    expect(resolveHippocampusMode()).toBe("active");
    expect(loadConfig().hippocampusMode).toBe("active");
  });

  it("parses active mode and runtime tuning fields", () => {
    process.env.PAPERCLIP_HIPPOCAMPUS_MODE = "active";
    process.env.PAPERCLIP_HIPPOCAMPUS_PYTHON_BIN = "/usr/bin/python3";
    process.env.PAPERCLIP_HIPPOCAMPUS_STARTUP_TIMEOUT_MS = "20000";
    process.env.PAPERCLIP_HIPPOCAMPUS_REQUEST_TIMEOUT_MS = "45000";
    process.env.REDIS_URL = "redis://localhost:6379/0";

    const config = loadConfig();

    expect(config.hippocampusMode).toBe("active");
    expect(config.hippocampusPythonBin).toBe("/usr/bin/python3");
    expect(config.hippocampusStartupTimeoutMs).toBe(20000);
    expect(config.hippocampusRequestTimeoutMs).toBe(45000);
  });
});
