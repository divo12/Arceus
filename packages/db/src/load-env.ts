import { config as loadEnv } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const currentDir = dirname(fileURLToPath(import.meta.url));
const repoEnvPath = resolve(currentDir, "../../../.env.local");

loadEnv({ path: repoEnvPath, override: false });