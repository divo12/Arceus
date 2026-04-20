/**
 * HTTP server configuration.
 * Port and host for the Fastify server.
 */
import { readNumberEnv, readOptionalEnv } from "./env";

export const serverConfig = {
  port: readNumberEnv("PORT", 4000),
  host: readOptionalEnv("HOST", "0.0.0.0"),
};