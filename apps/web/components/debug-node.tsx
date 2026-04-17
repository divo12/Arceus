"use client";

import { memo } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";

export interface DebugNodeData {
  kind: string;
  title: string;
  assignedRole: string;
  status: string;
  beatCount: number;
  fileCount: number;
  meetingCount: number;
  memoryWriteCount: number;
  durationMs: number | null;
  reworkCycles: number | null;
  [key: string]: unknown;
}

const STATUS_STYLES: Record<string, string> = {
  completed: "border-emerald-500 bg-white",
  in_progress: "border-blue-500 bg-white ring-2 ring-blue-200 animate-pulse",
  failed: "border-red-500 bg-red-50",
  cancelled: "border-gray-400 bg-gray-50",
  blocked: "border-amber-500 bg-amber-50",
  planned: "border-gray-300 border-dashed bg-gray-50/80",
  created: "border-gray-300 border-dashed bg-gray-50/80",
};

const STATUS_DOT: Record<string, string> = {
  completed: "bg-emerald-500",
  in_progress: "bg-blue-500 animate-pulse",
  failed: "bg-red-500",
  cancelled: "bg-gray-400",
  blocked: "bg-amber-500",
  planned: "bg-gray-300",
  created: "bg-gray-300",
};

const ROLE_COLORS: Record<string, string> = {
  cto: "bg-purple-100 text-purple-700 border border-purple-200",
  developer: "bg-blue-100 text-blue-700 border border-blue-200",
  tester: "bg-orange-100 text-orange-700 border border-orange-200",
  ui_designer: "bg-pink-100 text-pink-700 border border-pink-200",
  pm: "bg-green-100 text-green-700 border border-green-200",
  ceo: "bg-yellow-100 text-yellow-700 border border-yellow-200",
  marketing: "bg-teal-100 text-teal-700 border border-teal-200",
};

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${m}m ${s}s`;
}

function formatKind(kind: string): string {
  return kind.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function DebugNodeComponent({ data, selected }: NodeProps) {
  const d = data as DebugNodeData;
  const statusStyle = STATUS_STYLES[d.status] ?? STATUS_STYLES.planned;
  const dot = STATUS_DOT[d.status] ?? STATUS_DOT.planned;
  const roleColor = ROLE_COLORS[d.assignedRole] ?? "bg-gray-100 text-gray-600 border border-gray-200";

  // ── Special rendering for CEO sprint planning node ──
  if (d.kind === "sprint_planning") {
    return (
      <div
        className={`rounded-xl border-2 border-yellow-400 bg-gradient-to-br from-yellow-50 to-amber-50 px-5 py-4 min-w-[260px] max-w-[300px] shadow-md transition-all duration-200 ${selected ? "ring-2 ring-yellow-400 shadow-lg scale-[1.02]" : "hover:shadow-lg"}`}
      >
        <Handle type="target" position={Position.Left} id="left" className="!bg-yellow-500 !w-2.5 !h-2.5 !border-2 !border-white" />
        <Handle type="target" position={Position.Top} id="top" className="!bg-blue-400 !w-2 !h-2 !border-2 !border-white" />

        <div className="flex items-center gap-2 mb-2">
          <span className="text-lg">🧠</span>
          <span className="text-xs font-bold text-yellow-700 uppercase tracking-wider">CEO Planning</span>
        </div>

        <div className="text-sm font-semibold text-gray-800 leading-snug mb-2 line-clamp-2" title={d.title}>
          {d.title}
        </div>

        <div className="flex items-center gap-1.5">
          <span className={`w-2 h-2 rounded-full shrink-0 ${dot}`} />
          <span className="text-xs text-gray-600 capitalize">{d.status.replace(/_/g, " ")}</span>
        </div>

        <Handle type="source" position={Position.Right} id="right" className="!bg-yellow-500 !w-2.5 !h-2.5 !border-2 !border-white" />
        <Handle type="source" position={Position.Bottom} id="bottom" className="!bg-blue-400 !w-2 !h-2 !border-2 !border-white" />
      </div>
    );
  }

  // ── Special rendering for key ceremony meeting nodes ──
  if (d.kind === "meeting") {
    return (
      <div
        className={`rounded-xl border-2 border-teal-400 bg-gradient-to-br from-teal-50 to-cyan-50 px-5 py-4 min-w-[240px] max-w-[280px] shadow-md transition-all duration-200 ${selected ? "ring-2 ring-teal-400 shadow-lg scale-[1.02]" : "hover:shadow-lg"}`}
      >
        <Handle type="target" position={Position.Left} id="left" className="!bg-teal-500 !w-2.5 !h-2.5 !border-2 !border-white" />
        <Handle type="target" position={Position.Top} id="top" className="!bg-blue-400 !w-2 !h-2 !border-2 !border-white" />

        <div className="flex items-center gap-2 mb-2">
          <span className="text-lg">🤝</span>
          <span className="text-xs font-bold text-teal-700 uppercase tracking-wider">Ceremony</span>
        </div>

        <div className="text-sm font-semibold text-gray-800 leading-snug mb-2 line-clamp-2" title={d.title}>
          {d.title}
        </div>

        <div className="flex items-center gap-1.5">
          <span className={`w-2 h-2 rounded-full shrink-0 ${dot}`} />
          <span className="text-xs text-gray-600 capitalize">{d.status.replace(/_/g, " ")}</span>
        </div>

        <Handle type="source" position={Position.Right} id="right" className="!bg-teal-500 !w-2.5 !h-2.5 !border-2 !border-white" />
        <Handle type="source" position={Position.Bottom} id="bottom" className="!bg-blue-400 !w-2 !h-2 !border-2 !border-white" />
      </div>
    );
  }

  return (
    <div
      className={`rounded-lg border-2 px-4 py-3 min-w-[240px] max-w-[280px] shadow-sm transition-all duration-200 ${statusStyle} ${selected ? "ring-2 ring-blue-400 shadow-lg scale-[1.02]" : "hover:shadow-md"}`}
    >
      <Handle type="target" position={Position.Left} id="left" className="!bg-gray-400 !w-2.5 !h-2.5 !border-2 !border-white" />
      <Handle type="target" position={Position.Top} id="top" className="!bg-blue-400 !w-2 !h-2 !border-2 !border-white" />

      {/* Top row: kind badge + role badge */}
      <div className="flex items-center justify-between gap-2 mb-2">
        <span className={`text-[0.65rem] font-semibold px-2 py-0.5 rounded-full ${roleColor}`}>
          {formatKind(d.kind)}
        </span>
        <span className="text-[0.6rem] font-medium text-gray-400 uppercase tracking-wide">
          {d.assignedRole.replace(/_/g, " ")}
        </span>
      </div>

      {/* Title */}
      <div className="text-sm font-semibold text-gray-800 leading-snug mb-2 line-clamp-2" title={d.title}>
        {d.title}
      </div>

      {/* Status row */}
      <div className="flex items-center gap-1.5 mb-2">
        <span className={`w-2 h-2 rounded-full shrink-0 ${dot}`} />
        <span className="text-xs text-gray-600 capitalize">{d.status.replace(/_/g, " ")}</span>
      </div>

      {/* Stats row */}
      <div className="flex items-center gap-3 text-[0.65rem] text-gray-400">
        {d.beatCount > 0 && (
          <span className="flex items-center gap-0.5">
            <span className="text-gray-500">⚡</span> {d.beatCount}
          </span>
        )}
        {d.fileCount > 0 && (
          <span className="flex items-center gap-0.5">
            <span className="text-gray-500">📄</span> {d.fileCount}
          </span>
        )}
        {d.meetingCount > 0 && (
          <span className="flex items-center gap-0.5">
            <span className="text-gray-500">🤝</span> {d.meetingCount}
          </span>
        )}
        {d.memoryWriteCount > 0 && (
          <span className="flex items-center gap-0.5">
            <span className="text-purple-500">🧠</span> {d.memoryWriteCount}
          </span>
        )}
        {d.durationMs != null && (
          <span className="flex items-center gap-0.5">
            <span className="text-gray-500">⏱</span> {formatDuration(d.durationMs)}
          </span>
        )}
      </div>

      {d.reworkCycles != null && d.reworkCycles > 0 && (
        <div className="text-[0.65rem] text-orange-600 font-medium mt-1.5">🔁 {d.reworkCycles} rework cycle{d.reworkCycles > 1 ? "s" : ""}</div>
      )}

      <Handle type="source" position={Position.Right} id="right" className="!bg-gray-400 !w-2.5 !h-2.5 !border-2 !border-white" />
      <Handle type="source" position={Position.Bottom} id="bottom" className="!bg-blue-400 !w-2 !h-2 !border-2 !border-white" />
    </div>
  );
}

export const DebugNode = memo(DebugNodeComponent);
