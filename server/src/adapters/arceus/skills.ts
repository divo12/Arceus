import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AdapterSkillContext, AdapterSkillSnapshot } from "../types.js";
import {
  readPaperclipRuntimeSkillEntries,
  resolvePaperclipDesiredSkillNames,
} from "@paperclipai/adapter-utils/server-utils";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));

async function buildSnapshot(
  config: Record<string, unknown>,
): Promise<AdapterSkillSnapshot> {
  const entries = await readPaperclipRuntimeSkillEntries(config, __moduleDir);
  const desiredSkills = resolvePaperclipDesiredSkillNames(config, entries);

  return {
    adapterType: "arceus",
    supported: true,
    mode: "ephemeral",
    desiredSkills,
    entries: entries.map((e) => ({
      key: e.key,
      runtimeName: e.runtimeName,
      desired: desiredSkills.includes(e.key),
      managed: true,
      required: e.required,
      requiredReason: e.requiredReason ?? null,
      state: "available" as const,
      origin: e.required ? ("paperclip_required" as const) : ("company_managed" as const),
      originLabel: e.required ? "Required by Paperclip" : "Managed by Paperclip",
      readOnly: false,
      sourcePath: e.source,
      targetPath: null,
      detail: "Injected into system prompt at runtime",
    })),
    warnings: [],
  };
}

export async function listArceusSkills(
  ctx: AdapterSkillContext,
): Promise<AdapterSkillSnapshot> {
  return buildSnapshot(ctx.config);
}

export async function syncArceusSkills(
  ctx: AdapterSkillContext,
  _desiredSkills: string[],
): Promise<AdapterSkillSnapshot> {
  return buildSnapshot(ctx.config);
}
