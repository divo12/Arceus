import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpContext } from "../context.js";
import type { ArceusHttpClient } from "../http-client.js";
import { failure, success, toMcpContent } from "../envelope.js";

interface CatalogEntry {
  id: string;
  description: string;
  tags: string[];
}

const TOOL_CATALOG: CatalogEntry[] = [
  { id: "task_complete", description: "Mark a task completed.", tags: ["task", "completion"] },
  { id: "task_block", description: "Mark a task blocked with a reason.", tags: ["task", "blocker"] },
  { id: "task_verify", description: "Record tester verification on a task.", tags: ["task", "verify", "tester"] },
  { id: "task_append_result", description: "Append a result entry to a task log.", tags: ["task", "log", "result"] },
  { id: "task_set_preview_url", description: "Set the preview URL slot on a task.", tags: ["task", "preview", "url"] },
  { id: "task_create", description: "Create a new task.", tags: ["task", "create"] },
  { id: "task_update", description: "Patch whitelisted task fields.", tags: ["task", "update", "patch"] },
  { id: "task_hydrate_from_spec", description: "Rehydrate a task's fields from a spec object.", tags: ["task", "spec", "hydrate"] },
  { id: "task_attach_artifact", description: "Link an existing artifact to a task.", tags: ["task", "artifact"] },
  { id: "artifact_create", description: "Create a new artifact.", tags: ["artifact", "create"] },
  { id: "artifact_write_to_workspace", description: "Write an artifact's content to workspace.", tags: ["artifact", "workspace", "write"] },
  { id: "artifact_persist", description: "Promote artifact to durable storage.", tags: ["artifact", "persist", "storage"] },
  { id: "workspace_checkpoint", description: "Commit current workspace state as a git checkpoint.", tags: ["workspace", "git", "checkpoint"] },
  { id: "workspace_probe_preview", description: "Probe the preview server.", tags: ["workspace", "preview", "probe"] },
  { id: "meeting_record", description: "Record a meeting with agenda, decisions, and learnings.", tags: ["meeting", "record"] },
  { id: "approval_request", description: "Request an external approval.", tags: ["approval", "governance"] },
  { id: "sprint_propose", description: "Trigger a CEO sprint proposal.", tags: ["sprint", "ceo", "proposal"] },
  { id: "tool_help", description: "Get full docs (schema, examples, errors, related tools) for an Arceus tool.", tags: ["meta", "help", "docs"] },
  { id: "arceus_tool_search", description: "Search Arceus tool catalog by keyword.", tags: ["meta", "search", "catalog"] },
];

export const registerMetaTools = (
  server: McpServer,
  _ctx: McpContext,
  _client: ArceusHttpClient
): void => {
  server.registerTool(
    "tool_help",
    {
      description: "Get full docs (schema, examples, errors, related tools) for an Arceus tool.",
      inputSchema: { toolId: z.string() },
    },
    async ({ toolId }) => {
      const entry = TOOL_CATALOG.find((t) => t.id === toolId);
      if (!entry) {
        return toMcpContent(
          failure(`Unknown tool: ${toolId}`, "not_found", "never", "valid_tool_id")
        );
      }
      const related = TOOL_CATALOG
        .filter((t) => t.id !== toolId && t.tags.some((tag) => entry.tags.includes(tag)))
        .slice(0, 3)
        .map((t) => t.id);
      return toMcpContent(
        success(`Tool: ${entry.id}`, { id: entry.id, description: entry.description, tags: entry.tags, related })
      );
    }
  );

  server.registerTool(
    "arceus_tool_search",
    {
      description: "Search Arceus tool catalog by keyword. Returns 3-5 matching tool ids.",
      inputSchema: { query: z.string().max(200) },
    },
    async ({ query }) => {
      const lower = query.toLowerCase();
      const matches = TOOL_CATALOG
        .filter(
          (t) =>
            t.id.includes(lower) ||
            t.description.toLowerCase().includes(lower) ||
            t.tags.some((tag) => tag.includes(lower))
        )
        .slice(0, 5);
      return toMcpContent(
        success(`Found ${matches.length} tool(s) matching "${query}".`, {
          query,
          results: matches.map((t) => ({ id: t.id, description: t.description })),
        })
      );
    }
  );
};
