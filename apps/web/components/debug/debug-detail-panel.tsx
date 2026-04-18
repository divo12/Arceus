"use client";

import { useState } from "react";
import { Badge } from "../ui/badge";

/* Types matching graph-store.ts on the server */
interface StatusTransition {
  from: string;
  to: string;
  triggeredBy: string;
  reason: string;
  timestamp: string;
}

interface DecisionEntry {
  id: string;
  timestamp: string;
  type: string;
  decision: string;
  reasoning: string;
  confidence: number | null;
  alternatives: string[] | null;
  sourceRole: string;
}

interface FileChange {
  path: string;
  action: "created" | "modified" | "deleted";
  linesChanged: number | null;
}

interface BeatNode {
  beatId: string;
  agentRole: string;
  action: string;
  status: string;
  promptSummary: string | null;
  outputSummary: string | null;
  toolCalls: Array<{ name: string; status: string; summary: string | null; timestamp: string; durationMs: number | null }>;
  fileChanges: FileChange[];
  decisions: DecisionEntry[];
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
}

interface ReworkGroup {
  taskId: string;
  iterations: Array<{ cycle: number; verdict: string; reason: string; startedAt: string; completedAt: string | null }>;
  maxCycles: number;
  escalated: boolean;
}

interface MeetingEntry {
  id: string;
  type: string;
  title: string;
  facilitatorRole: string;
  participantRoles: string[];
  summary: string;
  trigger: string;
  isKeyCeremony: boolean;
  ceremonyKind: string | null;
  decisions: string[];
  memoryWrites: string[];
  timestamp: string;
  dynamic: boolean;
}

interface MemoryWriteEntry {
  id: string;
  agentRole: string;
  taskId: string | null;
  meetingId: string | null;
  memoryTier: string;
  triggeredBy: string;
  summary: string;
  content: string;
  outcome: string | null;
  timestamp: string;
  dynamic: boolean;
}

interface StateDiff {
  taskChanges: Array<{ taskId: string; field: string; before: string | null; after: string | null }>;
  sprintChanges: Array<{ field: string; before: string | null; after: string | null }>;
  memoryChanges: Array<{ agentRole: string; field: string; action: string; value: string }>;
}

export interface GraphNodeDetail {
  id: string;
  taskId: string;
  kind: string;
  title: string;
  assignedRole: string;
  status: string;
  statusHistory: StatusTransition[];
  inputArtifactIds: string[];
  outputArtifactIds: string[];
  inputContext: string | null;
  stateDiff: StateDiff | null;
  fileChanges: FileChange[];
  decisions: DecisionEntry[];
  beats: BeatNode[];
  meetings: MeetingEntry[];
  memoryWrites: MemoryWriteEntry[];
  reworkGroup: ReworkGroup | null;
  startedAt: string | null;
  completedAt: string | null;
}

type Tab = "overview" | "beats" | "decisions" | "files";

const DECISION_COLORS: Record<string, string> = {
  gate_verdict: "bg-blue-100 text-blue-700",
  router_transition: "bg-purple-100 text-purple-700",
  escalation: "bg-red-100 text-red-700",
  cto_review: "bg-indigo-100 text-indigo-700",
  task_completion: "bg-green-100 text-green-700",
  prune_decision: "bg-yellow-100 text-yellow-700",
  preview_validation: "bg-cyan-100 text-cyan-700",
  rework_decision: "bg-orange-100 text-orange-700",
  auto_approve: "bg-gray-100 text-gray-700",
  sprint_planning: "bg-amber-100 text-amber-700",
};

/** Dynamic = LLM decides at runtime; Hardcoded = deterministic code path. */
const DYNAMIC_DECISIONS = new Set([
  "router_transition",   // LLM proposes task transitions
  "cto_review",          // LLM evaluates code quality
  "preview_validation",  // LLM validates rendered output vs spec
  "prune_decision",      // LLM decides which tasks are already satisfied
  "task_completion",     // LLM checks sprint completion criteria
  "sprint_planning",     // LLM proposes sprint tasks (Sprint N+1)
]);

function isLlmDecision(type: string): boolean {
  return DYNAMIC_DECISIONS.has(type);
}

const FILE_ACTION_COLORS: Record<string, string> = {
  created: "text-emerald-600",
  modified: "text-blue-600",
  deleted: "text-red-600",
};

function formatTime(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleTimeString();
}

function formatDuration(ms: number | null): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${m}m ${s}s`;
}

export function DebugDetailPanel({ node, onClose }: { node: GraphNodeDetail; onClose: () => void }) {
  const [tab, setTab] = useState<Tab>("overview");

  const meetings = node.meetings ?? [];
  const memoryWrites = node.memoryWrites ?? [];

  const tabs: { key: Tab; label: string; count?: number }[] = [
    { key: "overview", label: "Overview" },
    { key: "beats", label: "Beats", count: node.beats.length },
    { key: "decisions", label: "Decisions", count: node.decisions.length },
    { key: "files", label: "Files", count: node.fileChanges.length },
  ];

  return (
    <div className="border-t border-gray-200 bg-white">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-3 border-b border-gray-100">
        <div className="flex items-center gap-3">
          <span className="text-base font-semibold text-gray-900">{node.title}</span>
          <Badge variant="secondary" className="text-xs uppercase tracking-wide">{node.kind.replace(/_/g, " ")}</Badge>
          <Badge variant="outline" className="text-xs uppercase tracking-wide">{node.assignedRole}</Badge>
        </div>
        <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-lg px-1">✕</button>
      </div>

      {/* Tab bar */}
      <div className="flex border-b border-gray-100 px-2">
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`px-5 py-2.5 text-sm font-medium transition-colors ${
              tab === t.key
                ? "border-b-2 border-blue-500 text-blue-600"
                : "text-gray-500 hover:text-gray-700"
            }`}
          >
            {t.label}
            {t.count != null && t.count > 0 && (
              <span className="ml-1.5 text-xs text-gray-400">({t.count})</span>
            )}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="p-6 max-h-[340px] overflow-y-auto text-sm">
        {tab === "overview" && <OverviewTab node={node} />}
        {tab === "beats" && <BeatsTab beats={node.beats} />}
        {tab === "decisions" && <DecisionsTab decisions={node.decisions} />}
        {tab === "files" && <FilesTab files={node.fileChanges} />}
      </div>

      {/* Meetings & Memory Writes — always visible below tabs */}
      {(meetings.length > 0 || memoryWrites.length > 0) && (
        <div className="border-t border-gray-100 p-6 max-h-[260px] overflow-y-auto space-y-4">
          {meetings.length > 0 && (
            <MeetingsBlock meetings={meetings} memoryWrites={memoryWrites} />
          )}
          {/* Memory writes not tied to a meeting — show under the task itself */}
          {memoryWrites.filter((w) => !w.meetingId).length > 0 && (
            <MemoryWritesBlock
              label="Task"
              entries={memoryWrites.filter((w) => !w.meetingId)}
            />
          )}
        </div>
      )}
    </div>
  );
}

function OverviewTab({ node }: { node: GraphNodeDetail }) {
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-x-8 gap-y-3">
        <div>
          <div className="text-xs font-medium text-gray-400 uppercase tracking-wide mb-0.5">Status</div>
          <div className="text-sm font-semibold text-gray-800 capitalize">{node.status.replace(/_/g, " ")}</div>
        </div>
        <div>
          <div className="text-xs font-medium text-gray-400 uppercase tracking-wide mb-0.5">Role</div>
          <div className="text-sm font-semibold text-gray-800 capitalize">{node.assignedRole.replace(/_/g, " ")}</div>
        </div>
        <div>
          <div className="text-xs font-medium text-gray-400 uppercase tracking-wide mb-0.5">Started</div>
          <div className="text-sm text-gray-700">{formatTime(node.startedAt)}</div>
        </div>
        <div>
          <div className="text-xs font-medium text-gray-400 uppercase tracking-wide mb-0.5">Completed</div>
          <div className="text-sm text-gray-700">{formatTime(node.completedAt)}</div>
        </div>
      </div>

      {node.inputArtifactIds.length > 0 && (
        <div>
          <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">Input Artifacts</div>
          <ul className="space-y-1">
            {node.inputArtifactIds.map((id) => (
              <li key={id} className="text-sm text-gray-600 font-mono">• {id}</li>
            ))}
          </ul>
        </div>
      )}

      {node.outputArtifactIds.length > 0 && (
        <div>
          <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">Output Artifacts</div>
          <ul className="space-y-1">
            {node.outputArtifactIds.map((id) => (
              <li key={id} className="text-sm text-gray-600 font-mono">• {id}</li>
            ))}
          </ul>
        </div>
      )}

      {node.statusHistory.length > 0 && (
        <div>
          <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">Status History</div>
          <div className="space-y-1.5">
            {node.statusHistory.map((t, i) => (
              <div key={i} className="flex items-center gap-2.5 text-sm">
                <span className="text-gray-400 tabular-nums">{formatTime(t.timestamp)}</span>
                <span className="text-gray-500">{t.from}</span>
                <span className="text-gray-400">→</span>
                <span className="font-medium text-gray-800">{t.to}</span>
                <span className="text-gray-400">by {t.triggeredBy}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {node.stateDiff && (
        <div>
          <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">State Diff</div>
          {node.stateDiff.taskChanges.map((c, i) => (
            <div key={i} className="text-sm font-mono">
              <span className="text-gray-400">{c.field}:</span> {c.before ?? "null"} → {c.after ?? "null"}
            </div>
          ))}
          {node.stateDiff.sprintChanges.map((c, i) => (
            <div key={i} className="text-sm font-mono">
              <span className="text-gray-400">sprint.{c.field}:</span> {c.before ?? "null"} → {c.after ?? "null"}
            </div>
          ))}
        </div>
      )}

      {node.reworkGroup && (
        <div>
          <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">
            Rework ({node.reworkGroup.iterations.length}/{node.reworkGroup.maxCycles} cycles)
            {node.reworkGroup.escalated && <span className="text-red-500 font-bold ml-2">ESCALATED</span>}
          </div>
          <div className="space-y-1.5">
            {node.reworkGroup.iterations.map((it, i) => (
              <div key={i} className="flex items-center gap-2.5 text-sm">
                <span className="font-medium text-gray-700">Cycle {it.cycle}</span>
                <span className={it.verdict === "pass" ? "text-emerald-600 font-semibold" : it.verdict === "fail" ? "text-red-600 font-semibold" : "text-gray-600"}>
                  {it.verdict}
                </span>
                <span className="text-gray-400 truncate">{it.reason}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function BeatsTab({ beats }: { beats: BeatNode[] }) {
  const [expanded, setExpanded] = useState<string | null>(null);

  if (beats.length === 0) return <div className="text-gray-400 text-sm">No beats recorded.</div>;

  return (
    <div className="space-y-2.5">
      {beats.map((beat) => (
        <div key={beat.beatId} className="border border-gray-200 rounded-lg p-3">
          <button
            className="w-full flex items-center justify-between text-left"
            onClick={() => setExpanded(expanded === beat.beatId ? null : beat.beatId)}
          >
            <div className="flex items-center gap-2.5">
              <span className={`w-2 h-2 rounded-full shrink-0 ${
                beat.status === "completed" ? "bg-emerald-500" : beat.status === "failed" ? "bg-red-500" : "bg-blue-500 animate-pulse"
              }`} />
              <span className="font-semibold text-sm text-gray-800">{beat.action}</span>
              <span className="text-sm text-gray-400">{beat.agentRole}</span>
            </div>
            <div className="flex items-center gap-3 text-sm text-gray-400">
              <span>{formatDuration(beat.durationMs)}</span>
              {beat.toolCalls.length > 0 && <span>{beat.toolCalls.length} tools</span>}
              <span className="text-xs">{expanded === beat.beatId ? "▲" : "▼"}</span>
            </div>
          </button>

          {expanded === beat.beatId && (
            <div className="mt-3 pl-4 border-l-2 border-gray-200 space-y-3">
              {beat.outputSummary && (
                <div>
                  <div className="text-xs font-medium text-gray-400 uppercase tracking-wide mb-1">Output</div>
                  <div className="text-sm text-gray-600 whitespace-pre-wrap">{beat.outputSummary}</div>
                </div>
              )}
              {beat.toolCalls.length > 0 && (
                <div>
                  <div className="text-xs font-medium text-gray-400 uppercase tracking-wide mb-1">Tool Calls</div>
                  <div className="space-y-1">
                    {beat.toolCalls.map((tc, i) => (
                      <div key={i} className="flex items-center gap-2.5 text-sm">
                        <span className={`w-2 h-2 rounded-full shrink-0 ${
                          tc.status === "completed" ? "bg-emerald-500" : tc.status === "error" ? "bg-red-500" : "bg-blue-500"
                        }`} />
                        <span className="font-mono text-gray-700">{tc.name}</span>
                        {tc.durationMs != null && <span className="text-gray-400">{formatDuration(tc.durationMs)}</span>}
                        {tc.summary && <span className="text-gray-400 truncate">{tc.summary}</span>}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function DecisionsTab({ decisions }: { decisions: DecisionEntry[] }) {
  if (decisions.length === 0) return <div className="text-gray-400 text-sm">No decisions recorded.</div>;

  return (
    <div className="space-y-3">
      {decisions.map((d) => {
        const dynamic = isLlmDecision(d.type);
        return (
          <div
            key={d.id}
            className={`border rounded-lg p-3 ${dynamic ? "border-l-4 border-l-violet-400 border-gray-200" : "border-l-4 border-l-gray-300 border-gray-200"}`}
          >
            <div className="flex items-center gap-2.5 mb-1.5">
              <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${DECISION_COLORS[d.type] ?? "bg-gray-100 text-gray-700"}`}>
                {d.type.replace(/_/g, " ")}
              </span>
              <span className={`text-[0.65rem] font-bold px-1.5 py-0.5 rounded ${dynamic ? "bg-violet-100 text-violet-700" : "bg-gray-100 text-gray-500"}`}>
                {dynamic ? "LLM" : "CODE"}
              </span>
              <span className="text-xs text-gray-400">{formatTime(d.timestamp)}</span>
              <span className="text-xs text-gray-400">by {d.sourceRole}</span>
            </div>
            <div className="text-sm font-medium text-gray-800 mb-1">{d.decision}</div>
            <div className="text-sm text-gray-500">{d.reasoning}</div>
            {d.confidence != null && (
              <div className="mt-2 flex items-center gap-2">
                <span className="text-xs text-gray-400">Confidence:</span>
                <div className="w-20 h-2 bg-gray-100 rounded-full">
                  <div
                    className="h-full bg-blue-500 rounded-full"
                    style={{ width: `${Math.round(d.confidence * 100)}%` }}
                  />
                </div>
                <span className="text-xs text-gray-500 font-medium">{Math.round(d.confidence * 100)}%</span>
              </div>
            )}
            {d.alternatives && d.alternatives.length > 0 && (
              <div className="mt-1.5 text-xs text-gray-400">
                Alternatives: {d.alternatives.join(", ")}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function FilesTab({ files }: { files: FileChange[] }) {
  if (files.length === 0) return <div className="text-gray-400 text-sm">No file changes recorded.</div>;

  return (
    <div className="space-y-1">
      {files.map((f, i) => (
        <div key={i} className="flex items-center gap-3 text-sm font-mono py-0.5">
          <span className={`font-bold w-4 text-center shrink-0 ${FILE_ACTION_COLORS[f.action] ?? "text-gray-600"}`}>
            {f.action === "created" ? "A" : f.action === "modified" ? "M" : "D"}
          </span>
          <span className="truncate text-gray-700">{f.path}</span>
          {f.linesChanged != null && <span className="text-gray-400 shrink-0">±{f.linesChanged}</span>}
        </div>
      ))}
    </div>
  );
}

const CEREMONY_COLORS: Record<string, string> = {
  kickoff: "bg-green-100 text-green-700",
  handoff: "bg-blue-100 text-blue-700",
  cto_approval: "bg-indigo-100 text-indigo-700",
  board_approval: "bg-purple-100 text-purple-700",
  retrospective: "bg-amber-100 text-amber-700",
};

const TIER_COLORS: Record<string, string> = {
  static: "bg-gray-100 text-gray-700",
  dynamic: "bg-blue-100 text-blue-700",
  procedural: "bg-green-100 text-green-700",
  priming: "bg-purple-100 text-purple-700",
};

/** Compact memory-write list with a down-arrow connector from the source block. */
function MemoryWritesBlock({ label, entries }: { label: string; entries: MemoryWriteEntry[] }) {
  if (entries.length === 0) return null;
  return (
    <div className="relative pl-6">
      {/* Down-arrow connector */}
      <div className="absolute left-2 top-0 bottom-0 flex flex-col items-center">
        <div className="w-px flex-1 bg-purple-300" />
        <span className="text-purple-400 text-xs leading-none">▼</span>
      </div>
      <div className="text-xs font-semibold text-purple-600 uppercase tracking-wide mb-1.5">
        🧠 Memory writes from {label}
      </div>
      <div className="space-y-1.5">
        {entries.map((e) => (
          <div key={e.id} className="flex items-start gap-2 text-sm">
            <span className={`shrink-0 text-[0.65rem] font-bold px-1.5 py-0.5 rounded ${TIER_COLORS[e.memoryTier] ?? "bg-gray-100 text-gray-700"}`}>
              {e.memoryTier}
            </span>
            <span className="text-gray-700">{e.summary}</span>
            {e.outcome && (
              <span className={`shrink-0 text-xs ${e.outcome === "success" ? "text-emerald-600" : "text-red-600"}`}>
                {e.outcome}
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/** Meetings shown as blocks with participants, decisions, and related memory writes. */
function MeetingsBlock({ meetings, memoryWrites }: { meetings: MeetingEntry[]; memoryWrites: MemoryWriteEntry[] }) {
  return (
    <div className="space-y-3">
      <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide">🤝 Meetings</div>
      {meetings.map((m) => {
        const relatedMemoryWrites = memoryWrites.filter((w) => w.meetingId === m.id);
        return (
          <div key={m.id} className="space-y-0">
            <div
              className={`border rounded-lg p-3 ${m.isKeyCeremony ? "border-l-4 border-l-amber-400 border-gray-200" : "border-gray-200"}`}
            >
              <div className="flex items-center gap-2 mb-1.5 flex-wrap">
                {m.isKeyCeremony && m.ceremonyKind && (
                  <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${CEREMONY_COLORS[m.ceremonyKind] ?? "bg-gray-100 text-gray-700"}`}>
                    {m.ceremonyKind.replace(/_/g, " ")}
                  </span>
                )}
                <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-gray-100 text-gray-600">
                  {m.type.replace(/_/g, " ")}
                </span>
                <span className="text-xs text-gray-400">{formatTime(m.timestamp)}</span>
              </div>
              <div className="text-sm font-medium text-gray-800 mb-1">{m.title}</div>
              {m.trigger && (
                <div className="text-xs text-amber-700 bg-amber-50 rounded px-2 py-1 mb-1.5">
                  <span className="font-semibold">Trigger:</span> {m.trigger}
                </div>
              )}
              <div className="text-sm text-gray-500 mb-2">{m.summary}</div>
              {/* Participants */}
              <div className="flex items-center gap-1.5 mb-1.5 flex-wrap">
                <span className="text-xs text-gray-400 shrink-0">Who joined:</span>
                {m.participantRoles.map((r) => (
                  <span key={r} className="text-xs font-medium px-2 py-0.5 rounded-full bg-teal-50 text-teal-700 border border-teal-200">
                    {r.replace(/_/g, " ")}
                  </span>
                ))}
                <span className="text-xs text-gray-300 mx-1">•</span>
                <span className="text-xs text-gray-400">Facilitator: {m.facilitatorRole.replace(/_/g, " ")}</span>
              </div>
              {m.decisions.length > 0 && (
                <div>
                  <div className="text-xs font-medium text-gray-400 uppercase tracking-wide mb-1">Decisions</div>
                  <ul className="space-y-0.5">
                    {m.decisions.map((d, i) => (
                      <li key={i} className="text-sm text-gray-600">• {d}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
            {/* Memory writes triggered by this meeting — down arrow */}
            {relatedMemoryWrites.length > 0 && (
              <MemoryWritesBlock label={m.title || "meeting"} entries={relatedMemoryWrites} />
            )}
          </div>
        );
      })}
    </div>
  );
}
