"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  Panel,
  useNodesState,
  useEdgesState,
  type Node,
  type Edge,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import dagre from "dagre";
import { DebugNode, type DebugNodeData } from "./debug-node";
import { DebugEdge, EdgeArrowMarker } from "./debug-edge";
import { DebugDetailPanel, type GraphNodeDetail } from "./debug-detail-panel";
import { apiUrl } from "../../lib/api";

/* ── Types (matching server graph-store.ts) ── */

interface GraphNodeServer {
  id: string;
  taskId: string;
  kind: string;
  title: string;
  assignedRole: string;
  status: string;
  statusHistory: Array<{ from: string; to: string; triggeredBy: string; reason: string; timestamp: string }>;
  inputArtifactIds: string[];
  outputArtifactIds: string[];
  inputContext: string | null;
  stateDiff: unknown;
  fileChanges: Array<{ path: string; action: string; linesChanged: number | null }>;
  decisions: unknown[];
  beats: unknown[];
  meetings: unknown[];
  memoryWrites: unknown[];
  reworkGroup: unknown;
  startedAt: string | null;
  completedAt: string | null;
}

interface GraphEdgeServer {
  id: string;
  sourceNodeId: string;
  targetNodeId: string;
  type: string;
  label: string | null;
  artifactId: string | null;
}

interface ExecutionGraph {
  sprintId: string;
  sprintNumber: number;
  sprintGoal: string;
  status: string;
  nodes: GraphNodeServer[];
  edges: GraphEdgeServer[];
  startedAt: string;
  completedAt: string | null;
}

interface SprintSummary {
  sprintId: string;
  number: number;
  status: string;
}

/* ── dagre layout ── */

const NODE_WIDTH = 260;
const NODE_HEIGHT = 130;

/** Statuses that indicate a node has been "touched" — it should appear on the graph. */
const ACTIVE_STATUSES = new Set(["in_progress", "completed", "failed", "blocked", "cancelled"]);

/**
 * Filter nodes to only show those that are active or completed.
 * This gives a progressive reveal effect — nodes appear as they are being worked on.
 * We also include any planned/created node whose immediate dependency is already visible,
 * so you can see "what comes next".
 */
function filterVisibleGraph(
  allNodes: GraphNodeServer[],
  allEdges: GraphEdgeServer[],
): { nodes: GraphNodeServer[]; edges: GraphEdgeServer[] } {
  const visibleIds = new Set<string>();

  // Pass 1: include all nodes with an active status
  for (const n of allNodes) {
    if (ACTIVE_STATUSES.has(n.status)) {
      visibleIds.add(n.id);
    }
  }

  // If nothing is active yet, show all nodes (initial load / fully planned sprint)
  if (visibleIds.size === 0) {
    return { nodes: allNodes, edges: allEdges };
  }

  // Pass 2: include immediate downstream (planned/created) neighbors of active nodes
  // so the user can see "what's next"
  for (const edge of allEdges) {
    if (visibleIds.has(edge.sourceNodeId)) {
      visibleIds.add(edge.targetNodeId);
    }
  }

  const nodes = allNodes.filter((n) => visibleIds.has(n.id));
  const nodeIdSet = new Set(nodes.map((n) => n.id));
  const edges = allEdges.filter((e) => nodeIdSet.has(e.sourceNodeId) && nodeIdSet.has(e.targetNodeId));
  return { nodes, edges };
}

function layoutGraph(
  nodes: Node[],
  edges: Edge[],
): { nodes: Node[]; edges: Edge[] } {
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: "LR", nodesep: 60, ranksep: 120, marginx: 40, marginy: 40 });

  for (const node of nodes) {
    g.setNode(node.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  }
  for (const edge of edges) {
    g.setEdge(edge.source, edge.target);
  }

  dagre.layout(g);

  const laidOut = nodes.map((node) => {
    const pos = g.node(node.id);
    return {
      ...node,
      position: { x: pos.x - NODE_WIDTH / 2, y: pos.y - NODE_HEIGHT / 2 },
    };
  });

  return { nodes: laidOut, edges };
}

/* ── Helpers ── */

function serverToFlowNodes(graph: ExecutionGraph): Node[] {
  return graph.nodes.map((n) => ({
    id: n.id,
    type: "debugNode",
    position: { x: 0, y: 0 },
    data: {
      kind: n.kind,
      title: n.title,
      assignedRole: n.assignedRole,
      status: n.status,
      beatCount: Array.isArray(n.beats) ? n.beats.length : 0,
      fileCount: Array.isArray(n.fileChanges) ? n.fileChanges.length : 0,
      meetingCount: Array.isArray(n.meetings) ? n.meetings.length : 0,
      memoryWriteCount: Array.isArray(n.memoryWrites) ? n.memoryWrites.length : 0,
      durationMs:
        n.startedAt && n.completedAt
          ? new Date(n.completedAt).getTime() - new Date(n.startedAt).getTime()
          : null,
      reworkCycles: n.reworkGroup && typeof n.reworkGroup === "object" && "iterations" in n.reworkGroup
        ? (n.reworkGroup as { iterations: unknown[] }).iterations.length
        : null,
    } satisfies DebugNodeData,
  }));
}

function serverToFlowEdges(graph: ExecutionGraph): Edge[] {
  return graph.edges.map((e) => {
    const isDashed = e.type === "artifact_flow" || e.type === "escalation";
    return {
      id: e.id,
      source: e.sourceNodeId,
      target: e.targetNodeId,
      sourceHandle: isDashed ? "bottom" : "right",
      targetHandle: isDashed ? "top" : "left",
      type: "debugEdge",
      label: e.label ?? undefined,
      data: { type: e.type, artifactId: e.artifactId },
    };
  });
}

function computeDuration(n: GraphNodeServer): number | null {
  if (n.startedAt && n.completedAt) {
    return new Date(n.completedAt).getTime() - new Date(n.startedAt).getTime();
  }
  return null;
}

/* ── Component ── */

const nodeTypes = { debugNode: DebugNode };
const edgeTypes = { debugEdge: DebugEdge };

/* ── Legend overlay (renders inside ReactFlow via Panel) ── */

const LEGEND_ITEMS = [
  { label: "Dependency", color: "#6b7280", dash: false, width: 2 },
  { label: "Artifact flow", color: "#3b82f6", dash: true, width: 2 },
  { label: "Rework", color: "#f97316", dash: false, width: 2.5 },
  { label: "Escalation", color: "#ef4444", dash: true, width: 2.5 },
] as const;

function GraphLegend() {
  return (
    <Panel position="bottom-left">
      <div className="bg-white/90 backdrop-blur border border-gray-200 rounded-lg px-3 py-2 shadow-sm">
        <div className="text-[0.6rem] font-semibold text-gray-500 uppercase tracking-wider mb-1.5">Legend</div>
        <div className="flex flex-col gap-1">
          {LEGEND_ITEMS.map((item) => (
            <div key={item.label} className="flex items-center gap-2">
              <svg width="32" height="10">
                <line
                  x1="0" y1="5" x2="32" y2="5"
                  stroke={item.color}
                  strokeWidth={item.width}
                  strokeDasharray={item.dash ? (item.width > 2 ? "4 4" : "8 4") : undefined}
                />
              </svg>
              <span className="text-[0.65rem] text-gray-600">{item.label}</span>
            </div>
          ))}
        </div>
      </div>
    </Panel>
  );
}

/* ── Edge info panel (shown when an edge is clicked) ── */

const EDGE_TYPE_LABELS: Record<string, string> = {
  dependency: "Dependency",
  artifact_flow: "Artifact Flow",
  rework: "Rework",
  escalation: "Escalation",
};

const EDGE_TYPE_COLORS: Record<string, string> = {
  dependency: "bg-gray-100 text-gray-700",
  artifact_flow: "bg-blue-100 text-blue-700",
  rework: "bg-orange-100 text-orange-700",
  escalation: "bg-red-100 text-red-700",
};

function EdgeInfoPanel({
  edge,
  onClose,
}: {
  edge: { type: string; label: string | null; artifactId: string | null; source: string; target: string };
  onClose: () => void;
}) {
  return (
    <div className="border-t border-gray-200 bg-white px-4 py-3 shrink-0">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <span className={`text-[0.65rem] font-semibold px-2 py-0.5 rounded-full ${EDGE_TYPE_COLORS[edge.type] ?? "bg-gray-100 text-gray-600"}`}>
            {EDGE_TYPE_LABELS[edge.type] ?? edge.type}
          </span>
          {edge.label && <span className="text-xs text-gray-700 font-medium">{edge.label}</span>}
        </div>
        <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-sm">✕</button>
      </div>
      <div className="flex items-center gap-2 text-xs text-gray-500">
        <span className="truncate max-w-[200px]" title={edge.source}>{edge.source}</span>
        <span className="text-gray-300">→</span>
        <span className="truncate max-w-[200px]" title={edge.target}>{edge.target}</span>
      </div>
      {edge.artifactId && (
        <div className="mt-2 text-xs">
          <span className="text-gray-400">Artifact:</span>{" "}
          <span className="font-mono text-blue-600 bg-blue-50 px-1.5 py-0.5 rounded">{edge.artifactId}</span>
        </div>
      )}
    </div>
  );
}

export function DebugGraph() {
  const [sprints, setSprints] = useState<SprintSummary[]>([]);
  const [selectedSprintId, setSelectedSprintId] = useState<string | null>(null);
  const [graph, setGraph] = useState<ExecutionGraph | null>(null);

  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);

  const [selectedNode, setSelectedNode] = useState<GraphNodeDetail | null>(null);
  const [selectedEdge, setSelectedEdge] = useState<{ type: string; label: string | null; artifactId: string | null; source: string; target: string } | null>(null);

  const sseRef = useRef<EventSource | null>(null);

  // Fetch sprint list
  useEffect(() => {
    const fetchSprints = async () => {
      try {
        const res = await fetch(apiUrl("/debug/graph"));
        const data = await res.json();
        setSprints(data.sprints ?? []);
        if (!selectedSprintId && data.sprints?.length > 0) {
          // Auto-select the latest sprint
          const latest = data.sprints[data.sprints.length - 1];
          setSelectedSprintId(latest.sprintId);
        }
      } catch {
        /* ignore */
      }
    };
    fetchSprints();
    const interval = setInterval(fetchSprints, 5000);
    return () => clearInterval(interval);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch graph snapshot when sprint changes
  useEffect(() => {
    if (!selectedSprintId) return;

    const fetchGraph = async () => {
      try {
        const res = await fetch(apiUrl(`/debug/graph/${selectedSprintId}`));
        if (!res.ok) return;
        const data: ExecutionGraph = await res.json();
        setGraph(data);
        applyGraphToFlow(data);
      } catch {
        /* ignore */
      }
    };
    fetchGraph();
  }, [selectedSprintId]); // eslint-disable-line react-hooks/exhaustive-deps

  // SSE streaming
  useEffect(() => {
    if (!selectedSprintId) return;

    const url = new URL(apiUrl("/debug/graph/stream"), window.location.origin);
    url.searchParams.set("sprintId", selectedSprintId);

    const sse = new EventSource(url.toString());
    sseRef.current = sse;

    sse.addEventListener("graph", (ev) => {
      try {
        const event = JSON.parse(ev.data);
        handleGraphEvent(event);
      } catch {
        /* ignore */
      }
    });

    // Periodic full re-sync to catch any missed SSE events
    const resync = setInterval(async () => {
      try {
        const res = await fetch(apiUrl(`/debug/graph/${selectedSprintId}`));
        if (!res.ok) return;
        const data: ExecutionGraph = await res.json();
        setGraph(data);
        applyGraphToFlow(data);
      } catch {
        /* ignore */
      }
    }, 10_000);

    return () => {
      sse.close();
      sseRef.current = null;
      clearInterval(resync);
    };
  }, [selectedSprintId]); // eslint-disable-line react-hooks/exhaustive-deps

  const applyGraphToFlow = useCallback((g: ExecutionGraph) => {
    const { nodes: visibleNodes, edges: visibleEdges } = filterVisibleGraph(g.nodes, g.edges);
    const fakeGraph = { ...g, nodes: visibleNodes, edges: visibleEdges };
    const flowNodes = serverToFlowNodes(fakeGraph);
    const flowEdges = serverToFlowEdges(fakeGraph);
    const laid = layoutGraph(flowNodes, flowEdges);
    setNodes(laid.nodes);
    setEdges(laid.edges);
  }, [setNodes, setEdges]);

  const handleGraphEvent = useCallback((event: { type: string; [key: string]: unknown }) => {
    setGraph((prev) => {
      if (!prev) return prev;
      // Deep-clone to mutate safely
      const g = JSON.parse(JSON.stringify(prev)) as ExecutionGraph;

      switch (event.type) {
        case "node_added": {
          const node = event.node as GraphNodeServer | null;
          const newEdges = (event.edges ?? []) as GraphEdgeServer[];
          if (node) g.nodes.push(node);
          g.edges.push(...newEdges);
          break;
        }
        case "status_changed": {
          const nodeId = event.nodeId as string;
          const transition = event.transition as { from: string; to: string; triggeredBy: string; reason: string; timestamp: string };
          const n = g.nodes.find((x) => x.id === nodeId);
          if (n) {
            n.status = transition.to;
            n.statusHistory.push(transition);
            if (transition.to === "in_progress" && !n.startedAt) n.startedAt = transition.timestamp;
            if (["completed", "failed", "cancelled"].includes(transition.to)) n.completedAt = transition.timestamp;
          }
          break;
        }
        case "beat_started": {
          const nodeId = event.nodeId as string;
          const beat = event.beat as unknown;
          const n = g.nodes.find((x) => x.id === nodeId);
          if (n && Array.isArray(n.beats)) n.beats.push(beat);
          break;
        }
        case "beat_completed": {
          const nodeId = event.nodeId as string;
          const beatId = event.beatId as string;
          const patch = event.patch as Record<string, unknown>;
          const n = g.nodes.find((x) => x.id === nodeId);
          if (n && Array.isArray(n.beats)) {
            const beat = (n.beats as Array<Record<string, unknown>>).find((b) => b.beatId === beatId);
            if (beat) Object.assign(beat, patch);
          }
          break;
        }
        case "artifact_produced": {
          const nodeId = event.nodeId as string;
          const artifactId = event.artifactId as string;
          const edge = event.edge as GraphEdgeServer | null;
          const n = g.nodes.find((x) => x.id === nodeId);
          if (n && !n.outputArtifactIds.includes(artifactId)) n.outputArtifactIds.push(artifactId);
          if (edge) g.edges.push(edge);
          break;
        }
        case "decision": {
          const nodeId = event.nodeId as string | null;
          const entry = event.entry as unknown;
          if (nodeId) {
            const n = g.nodes.find((x) => x.id === nodeId);
            if (n && Array.isArray(n.decisions)) n.decisions.push(entry);
          }
          break;
        }
        case "files_changed": {
          const nodeId = event.nodeId as string;
          const files = event.files as Array<{ path: string; action: string; linesChanged: number | null }>;
          const n = g.nodes.find((x) => x.id === nodeId);
          if (n && Array.isArray(n.fileChanges)) n.fileChanges.push(...files);
          break;
        }
        case "sprint_completed": {
          g.status = (event.status as string) ?? "completed";
          g.completedAt = new Date().toISOString();
          break;
        }
        case "meeting_recorded": {
          const nodeId = event.nodeId as string | null;
          const meeting = event.meeting as unknown;
          if (nodeId) {
            const n = g.nodes.find((x) => x.id === nodeId);
            if (n) {
              if (!Array.isArray(n.meetings)) n.meetings = [];
              n.meetings.push(meeting);
            }
          }
          break;
        }
        case "memory_written": {
          const nodeId = event.nodeId as string | null;
          const entry = event.entry as unknown;
          if (nodeId) {
            const n = g.nodes.find((x) => x.id === nodeId);
            if (n) {
              if (!Array.isArray(n.memoryWrites)) n.memoryWrites = [];
              n.memoryWrites.push(entry);
            }
          }
          break;
        }
      }

      // Re-layout with progressive filter
      const { nodes: visibleNodes, edges: visibleEdges } = filterVisibleGraph(g.nodes, g.edges);
      const fakeGraph = { ...g, nodes: visibleNodes, edges: visibleEdges };
      const flowNodes = serverToFlowNodes(fakeGraph);
      const flowEdges = serverToFlowEdges(fakeGraph);
      const laid = layoutGraph(flowNodes, flowEdges);
      setNodes(laid.nodes);
      setEdges(laid.edges);

      return g;
    });
  }, [setNodes, setEdges]);

  const onNodeClick = useCallback(
    (_: React.MouseEvent, node: Node) => {
      setSelectedEdge(null);
      if (!graph) return;
      const serverNode = graph.nodes.find((n) => n.id === node.id);
      if (serverNode) {
        setSelectedNode(serverNode as unknown as GraphNodeDetail);
      }
    },
    [graph],
  );

  const onEdgeClick = useCallback(
    (_: React.MouseEvent, edge: Edge) => {
      setSelectedNode(null);
      if (!graph) return;
      const serverEdge = graph.edges.find((e) => e.id === edge.id);
      if (serverEdge) {
        const sourceNode = graph.nodes.find((n) => n.id === serverEdge.sourceNodeId);
        const targetNode = graph.nodes.find((n) => n.id === serverEdge.targetNodeId);
        setSelectedEdge({
          type: serverEdge.type,
          label: serverEdge.label,
          artifactId: serverEdge.artifactId,
          source: sourceNode?.title ?? serverEdge.sourceNodeId,
          target: targetNode?.title ?? serverEdge.targetNodeId,
        });
      }
    },
    [graph],
  );

  const currentSprint = sprints.find((s) => s.sprintId === selectedSprintId);

  return (
    <div className="flex flex-col h-full">
      {/* Sprint selector header */}
      <div className="flex items-center gap-3 px-4 py-2 border-b border-gray-200 bg-gray-50 shrink-0">
        <select
          className="text-xs border border-gray-200 rounded px-2 py-1 bg-white"
          value={selectedSprintId ?? ""}
          onChange={(e) => {
            setSelectedSprintId(e.target.value || null);
            setSelectedNode(null);
          }}
        >
          <option value="">Select sprint…</option>
          {sprints.map((s) => (
            <option key={s.sprintId} value={s.sprintId}>
              Sprint {s.number}
            </option>
          ))}
        </select>

        {graph && (
          <>
            <span className="text-xs text-gray-600 truncate">{graph.sprintGoal}</span>
            <span
              className={`text-[0.6rem] font-semibold px-1.5 py-0.5 rounded ${
                graph.status === "running"
                  ? "bg-blue-100 text-blue-700"
                  : graph.status === "completed"
                  ? "bg-emerald-100 text-emerald-700"
                  : graph.status === "failed"
                  ? "bg-red-100 text-red-700"
                  : "bg-gray-100 text-gray-700"
              }`}
            >
              {graph.status.toUpperCase()}
            </span>
            <span className="text-[0.6rem] text-gray-400">
              {graph.nodes.length} nodes · {graph.edges.length} edges
            </span>
          </>
        )}
      </div>

      {/* React Flow canvas */}
      <div className="flex-1 min-h-0">
        {graph ? (
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onNodeClick={onNodeClick}
            onEdgeClick={onEdgeClick}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            fitView
            minZoom={0.2}
            maxZoom={2}
            proOptions={{ hideAttribution: true }}
          >
            <EdgeArrowMarker />
            <Background color="#e5e7eb" gap={16} />
            <Controls showInteractive={false} />
            {/* Legend */}
            <GraphLegend />
          </ReactFlow>
        ) : (
          <div className="flex items-center justify-center h-full text-gray-400 text-sm">
            {selectedSprintId ? "Loading graph…" : "Select a sprint to view the execution graph."}
          </div>
        )}
      </div>

      {/* Detail panel */}
      {selectedNode && (
        <DebugDetailPanel
          node={selectedNode}
          onClose={() => setSelectedNode(null)}
        />
      )}

      {/* Edge info panel */}
      {selectedEdge && (
        <EdgeInfoPanel
          edge={selectedEdge}
          onClose={() => setSelectedEdge(null)}
        />
      )}
    </div>
  );
}
