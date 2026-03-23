#!/usr/bin/env node
// Paperclip API CLI helper — lets agents interact with the Paperclip API from bash
// Usage: node scripts/paperclip-cli.mjs <command> [args...]
//
// Environment variables:
//   PAPERCLIP_API_URL   — e.g. http://localhost:3105
//   PAPERCLIP_AGENT_ID  — the calling agent's ID
//   PAPERCLIP_COMPANY_ID — the company ID
//   PAPERCLIP_RUN_ID    — current run ID
//   PAPERCLIP_AUTH_TOKEN — (optional) bearer token

const API = process.env.PAPERCLIP_API_URL || "http://localhost:3100";
const AGENT_ID = process.env.PAPERCLIP_AGENT_ID || "";
const COMPANY_ID = process.env.PAPERCLIP_COMPANY_ID || "";
const RUN_ID = process.env.PAPERCLIP_RUN_ID || "";
const AUTH = process.env.PAPERCLIP_AUTH_TOKEN || "";

function headers() {
  const h = { "Content-Type": "application/json" };
  if (RUN_ID) h["X-Paperclip-Run-Id"] = RUN_ID;
  if (AUTH) h["Authorization"] = `Bearer ${AUTH}`;
  return h;
}

async function get(path) {
  const res = await fetch(`${API}${path}`, { headers: headers() });
  return res.text();
}

async function post(path, body) {
  const res = await fetch(`${API}${path}`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(body),
  });
  return res.text();
}

async function patch(path, body) {
  const res = await fetch(`${API}${path}`, {
    method: "PATCH",
    headers: headers(),
    body: JSON.stringify(body),
  });
  return res.text();
}

const [, , command, ...args] = process.argv;

function parseArgs(args) {
  const result = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]?.replace(/^--/, "");
    const val = args[i + 1];
    if (key && val !== undefined) result[key] = val;
  }
  return result;
}

async function main() {
  const a = parseArgs(args);

  switch (command) {
    case "me":
      return get(`/api/agents/${AGENT_ID}`);

    case "inbox":
      return get(`/api/agents/${AGENT_ID}/inbox-lite`);

    case "checkout":
      return post(`/api/issues/${a.issue}/checkout`, {
        agentId: AGENT_ID,
        expectedStatuses: ["todo", "backlog", "blocked"],
      });

    case "context":
      return get(`/api/issues/${a.issue}/heartbeat-context`);

    case "comments":
      return a.after
        ? get(`/api/issues/${a.issue}/comments?after=${a.after}&order=asc`)
        : get(`/api/issues/${a.issue}/comments`);

    case "update-issue": {
      const body = {};
      if (a.status) body.status = a.status;
      if (a.comment) body.comment = a.comment;
      if (a.title) body.title = a.title;
      if (a.description) body.description = a.description;
      if (a.priority) body.priority = a.priority;
      if (a.assignee) body.assigneeAgentId = a.assignee;
      return patch(`/api/issues/${a.issue}`, body);
    }

    case "create-issue": {
      const body = { title: a.title };
      if (a.description) body.description = a.description;
      if (a.status) body.status = a.status;
      if (a.priority) body.priority = a.priority;
      if (a.assignee) body.assigneeAgentId = a.assignee;
      if (a.parent) body.parentId = a.parent;
      if (a.goal) body.goalId = a.goal;
      if (a.project) body.projectId = a.project;
      return post(`/api/companies/${COMPANY_ID}/issues`, body);
    }

    case "comment":
      return post(`/api/issues/${a.issue}/comments`, { body: a.body });

    case "agents":
      return get(`/api/companies/${COMPANY_ID}/agents`);

    case "hire": {
      const body = {
        name: a.name,
        role: a.role || "engineer",
        adapterType: a.adapter || "opencode",
        adapterConfig: {},
        runtimeConfig: {
          heartbeat: { enabled: true, intervalSec: 3600, wakeOnDemand: true, cooldownSec: 10, maxConcurrentRuns: 1 },
        },
      };
      if (a.title) body.title = a.title;
      if (a.reports) body.reportsTo = a.reports;
      if (a.capabilities) body.capabilities = a.capabilities;
      return post(`/api/companies/${COMPANY_ID}/agents`, body);
    }

    case "goals":
      return get(`/api/companies/${COMPANY_ID}/goals`);

    case "create-goal": {
      const body = {
        title: a.title,
        level: a.level || "company",
        status: a.status || "active",
      };
      if (a.description) body.description = a.description;
      return post(`/api/companies/${COMPANY_ID}/goals`, body);
    }

    case "help":
    default:
      return JSON.stringify({
        commands: {
          me: "Get your agent info",
          inbox: "Get your task inbox",
          checkout: "--issue <id> : Checkout an issue before working",
          context: "--issue <id> : Get heartbeat context for an issue",
          comments: "--issue <id> [--after <commentId>] : Get issue comments",
          "update-issue": "--issue <id> [--status ...] [--comment ...] [--title ...] [--assignee ...]",
          "create-issue": "--title <t> [--description ...] [--status ...] [--priority ...] [--assignee ...] [--parent ...]",
          comment: "--issue <id> --body <markdown>",
          agents: "List all agents in the company",
          hire: "--name <n> --role <r> [--title ...] [--reports <agentId>] [--adapter opencode]",
          goals: "List company goals",
          "create-goal": "--title <t> [--description ...] [--level company|team] [--status active]",
        },
        env: { PAPERCLIP_API_URL: API, PAPERCLIP_AGENT_ID: AGENT_ID, PAPERCLIP_COMPANY_ID: COMPANY_ID },
      }, null, 2);
  }
}

main()
  .then((result) => {
    process.stdout.write(typeof result === "string" ? result : JSON.stringify(result));
    process.stdout.write("\n");
  })
  .catch((err) => {
    process.stderr.write(`Error: ${err.message}\n`);
    process.exit(1);
  });
