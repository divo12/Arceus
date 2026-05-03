#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadMcpContext } from "./context.js";
import { createArceusMcpServer } from "./server.js";

const main = async (): Promise<void> => {
  const ctx = loadMcpContext();
  const server = createArceusMcpServer(ctx);
  const transport = new StdioServerTransport();
  await server.connect(transport);
};

main().catch((err: unknown) => {
  process.stderr.write(`arceus-mcp stdio transport failed: ${String(err)}\n`);
  process.exit(1);
});
