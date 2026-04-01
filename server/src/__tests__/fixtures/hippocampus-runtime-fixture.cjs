const readline = require("node:readline");

const mode = process.env.HIPPOCAMPUS_FIXTURE_MODE || "normal";

if (mode === "malformed-on-start") {
  process.stdout.write("this-is-not-json\n");
}

function send(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function sendError(id, code, message) {
  process.stdout.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id,
    error: { code, message },
  })}\n`);
}

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

rl.on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }

  const params = message.params || {};

  switch (message.method) {
    case "health":
      send(message.id, { status: "ok", agents_loaded: 1, debug: false });
      return;
    case "remember":
      send(message.id, {
        id: `mem-${params.agent_id || "agent"}`,
        content: params.content,
        memory_type: params.memory_type || "dynamic",
        confidence: 1,
      });
      return;
    case "recall":
      if (mode === "crash-on-recall") {
        process.stderr.write("fixture crash on recall\n");
        process.exit(17);
      }
      if (mode === "hang-on-recall") {
        return;
      }
      send(message.id, {
        items: [
          {
            id: "mem-1",
            content: `recalled:${params.query}`,
            memory_type: "dynamic",
            confidence: 0.8,
            relevance_score: 0.9,
            kind: "memory",
          },
        ],
      });
      return;
    case "extract":
      send(message.id, { added: params.messages?.length || 0, updated: 0, deleted: 0 });
      return;
    case "processTrajectory":
      send(message.id, {
        verdict: { outcome: params.outcome },
        distilled: null,
        pattern: null,
        habit: null,
      });
      return;
    case "getPriming":
      send(message.id, { prompt: `priming:${params.agent_id}` });
      return;
    case "getHabits":
      send(message.id, {
        habits: [{ trigger: params.context || "default", action: "do thing", confidence: 0.7 }],
      });
      return;
    case "getSummary":
      send(message.id, {
        total_static: 1,
        total_dynamic: 2,
        active_habits: [],
        priming_prompt: "",
      });
      return;
    case "listMemories":
      send(message.id, {
        items: [],
        total: Number(params.limit || 0),
      });
      return;
    case "runGC":
      send(message.id, { expired: 0, decayed: 0, demoted: 0 });
      return;
    case "runPromotions":
      send(message.id, { promotions: [] });
      return;
    case "shutdown":
      if (mode === "ignore-shutdown") {
        return;
      }
      send(message.id, { status: "shutting_down" });
      setTimeout(() => process.exit(0), 10);
      return;
    default:
      sendError(message.id ?? null, -32601, `Unknown method "${message.method}"`);
  }
});

process.on("SIGTERM", () => {
  process.exit(0);
});
