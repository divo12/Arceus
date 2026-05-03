import { tool } from "@opencode-ai/plugin";
import { z } from "zod";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { failure, run, success } from "./_lib/envelope.js";

interface ConsoleEntry {
  type: string;
  text: string;
}

interface NetworkEntry {
  url: string;
  status: number;
  method: string;
}

interface ProbeBundle {
  url: string;
  capturedAt: string;
  screenshotPath: string;
  domSnapshotPath: string;
  console: ConsoleEntry[];
  network: NetworkEntry[];
  pageErrors: string[];
}

const captureWithPlaywright = async (
  url: string,
  outDir: string,
  timeoutMs: number,
): Promise<ProbeBundle> => {
  // Dynamic import so the tool loads even if @playwright/test is absent.
  const { chromium } = (await import("@playwright/test"));

  const consoleEntries: ConsoleEntry[] = [];
  const networkEntries: NetworkEntry[] = [];
  const pageErrors: string[] = [];

  const browser = await chromium.launch({ headless: true });
  try {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    page.on("console", (msg) => consoleEntries.push({ type: msg.type(), text: msg.text() }));
    page.on("pageerror", (err) => pageErrors.push(err.message));
    page.on("response", (res) => networkEntries.push({
      url: res.url(),
      status: res.status(),
      method: res.request().method(),
    }));

    await page.goto(url, { timeout: timeoutMs, waitUntil: "load" });

    const screenshotPath = join(outDir, "screenshot.png");
    await page.screenshot({ path: screenshotPath, fullPage: true });

    const domSnapshotPath = join(outDir, "dom.html");
    const html = await page.content();
    await writeFile(domSnapshotPath, html, "utf8");

    return {
      url,
      capturedAt: new Date().toISOString(),
      screenshotPath,
      domSnapshotPath,
      console: consoleEntries,
      network: networkEntries,
      pageErrors,
    };
  } finally {
    await browser.close();
  }
};

export default tool({
  description: "Capture a headless browser probe (screenshot + DOM + console + network) at a URL. Returns a bundle path. QA-only.",
  args: {
    url: z.url(),
    timeoutMs: z.number().int().positive().max(60_000).optional(),
    outDir: z.string().optional(),
  },
  execute: async ({ url, timeoutMs, outDir }) =>
    run(async () => {
      const taskId = process.env.TASK_ID ?? "unknown";
      const dir = outDir ?? join(tmpdir(), `probe-${taskId}-${Date.now()}`);
      await mkdir(dir, { recursive: true });
      try {
        const bundle = await captureWithPlaywright(url, dir, timeoutMs ?? 15_000);
        const manifestPath = join(dir, "probe.json");
        await writeFile(manifestPath, JSON.stringify(bundle, null, 2), "utf8");
        return success(`Probe captured for ${url}.`, {
          bundleDir: dir,
          manifestPath,
          screenshotPath: bundle.screenshotPath,
          domSnapshotPath: bundle.domSnapshotPath,
          consoleCount: bundle.console.length,
          networkCount: bundle.network.length,
          pageErrorCount: bundle.pageErrors.length,
        });
      } catch (err) {
        return failure(
          `Browser probe failed: ${err instanceof Error ? err.message : String(err)}`,
          "tooling",
          "safe",
          "playwright_installed",
        );
      }
    }),
});
