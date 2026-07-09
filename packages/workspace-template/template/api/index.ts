/**
 * Vercel serverless entry — mounts the Hono app for `/api/*` (except
 * `/api/ai/*`, which vercel.json rewrites to the Arceus Railway API).
 *
 * Locally, Vite serves the same Hono app via `@hono/vite-dev-server`
 * (see vite.config.ts). Keep routes in `server/index.ts` only.
 */
import { handle } from "hono/vercel";
import app from "../server/index";

export const config = {
  runtime: "nodejs",
};

export default handle(app);
