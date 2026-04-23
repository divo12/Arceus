"use client";
import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useCallback, useEffect, useRef, useState } from "react";
import { ReactFlow, Background, Controls, Panel, useNodesState, useEdgesState, } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import dagre from "dagre";
import { DebugNode } from "./debug-node";
import { DebugEdge, EdgeArrowMarker } from "./debug-edge";
import { DebugDetailPanel } from "./debug-detail-panel";
import { apiUrl } from "../../lib/api";
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
function filterVisibleGraph(allNodes, allEdges) {
    const visibleIds = new Set();
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
function layoutGraph(nodes, edges) {
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
function serverToFlowNodes(graph) {
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
            durationMs: n.startedAt && n.completedAt
                ? new Date(n.completedAt).getTime() - new Date(n.startedAt).getTime()
                : null,
            reworkCycles: n.reworkGroup && typeof n.reworkGroup === "object" && "iterations" in n.reworkGroup
                ? n.reworkGroup.iterations.length
                : null,
        },
    }));
}
function serverToFlowEdges(graph) {
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
function computeDuration(n) {
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
];
function GraphLegend() {
    return (_jsx(Panel, { position: "bottom-left", children: _jsxs("div", { className: "bg-white/90 backdrop-blur border border-gray-200 rounded-lg px-3 py-2 shadow-sm", children: [_jsx("div", { className: "text-[0.6rem] font-semibold text-gray-500 uppercase tracking-wider mb-1.5", children: "Legend" }), _jsx("div", { className: "flex flex-col gap-1", children: LEGEND_ITEMS.map((item) => (_jsxs("div", { className: "flex items-center gap-2", children: [_jsx("svg", { width: "32", height: "10", children: _jsx("line", { x1: "0", y1: "5", x2: "32", y2: "5", stroke: item.color, strokeWidth: item.width, strokeDasharray: item.dash ? (item.width > 2 ? "4 4" : "8 4") : undefined }) }), _jsx("span", { className: "text-[0.65rem] text-gray-600", children: item.label })] }, item.label))) })] }) }));
}
/* ── Edge info panel (shown when an edge is clicked) ── */
const EDGE_TYPE_LABELS = {
    dependency: "Dependency",
    artifact_flow: "Artifact Flow",
    rework: "Rework",
    escalation: "Escalation",
};
const EDGE_TYPE_COLORS = {
    dependency: "bg-gray-100 text-gray-700",
    artifact_flow: "bg-blue-100 text-blue-700",
    rework: "bg-orange-100 text-orange-700",
    escalation: "bg-red-100 text-red-700",
};
function EdgeInfoPanel({ edge, onClose, }) {
    return (_jsxs("div", { className: "border-t border-gray-200 bg-white px-4 py-3 shrink-0", children: [_jsxs("div", { className: "flex items-center justify-between mb-2", children: [_jsxs("div", { className: "flex items-center gap-2", children: [_jsx("span", { className: `text-[0.65rem] font-semibold px-2 py-0.5 rounded-full ${EDGE_TYPE_COLORS[edge.type] ?? "bg-gray-100 text-gray-600"}`, children: EDGE_TYPE_LABELS[edge.type] ?? edge.type }), edge.label && _jsx("span", { className: "text-xs text-gray-700 font-medium", children: edge.label })] }), _jsx("button", { onClick: onClose, className: "text-gray-400 hover:text-gray-600 text-sm", children: "\u2715" })] }), _jsxs("div", { className: "flex items-center gap-2 text-xs text-gray-500", children: [_jsx("span", { className: "truncate max-w-[200px]", title: edge.source, children: edge.source }), _jsx("span", { className: "text-gray-300", children: "\u2192" }), _jsx("span", { className: "truncate max-w-[200px]", title: edge.target, children: edge.target })] }), edge.artifactId && (_jsxs("div", { className: "mt-2 text-xs", children: [_jsx("span", { className: "text-gray-400", children: "Artifact:" }), " ", _jsx("span", { className: "font-mono text-blue-600 bg-blue-50 px-1.5 py-0.5 rounded", children: edge.artifactId })] }))] }));
}
export function DebugGraph() {
    const [sprints, setSprints] = useState([]);
    const [selectedSprintId, setSelectedSprintId] = useState(null);
    const [graph, setGraph] = useState(null);
    const [nodes, setNodes, onNodesChange] = useNodesState([]);
    const [edges, setEdges, onEdgesChange] = useEdgesState([]);
    const [selectedNode, setSelectedNode] = useState(null);
    const [selectedEdge, setSelectedEdge] = useState(null);
    const sseRef = useRef(null);
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
            }
            catch {
                /* ignore */
            }
        };
        fetchSprints();
        const interval = setInterval(fetchSprints, 5000);
        return () => clearInterval(interval);
    }, []); // eslint-disable-line react-hooks/exhaustive-deps
    // Fetch graph snapshot when sprint changes
    useEffect(() => {
        if (!selectedSprintId)
            return;
        const fetchGraph = async () => {
            try {
                const res = await fetch(apiUrl(`/debug/graph/${selectedSprintId}`));
                if (!res.ok)
                    return;
                const data = await res.json();
                setGraph(data);
                applyGraphToFlow(data);
            }
            catch {
                /* ignore */
            }
        };
        fetchGraph();
    }, [selectedSprintId]); // eslint-disable-line react-hooks/exhaustive-deps
    // SSE streaming
    useEffect(() => {
        if (!selectedSprintId)
            return;
        const url = new URL(apiUrl("/debug/graph/stream"), window.location.origin);
        url.searchParams.set("sprintId", selectedSprintId);
        const sse = new EventSource(url.toString());
        sseRef.current = sse;
        sse.addEventListener("graph", (ev) => {
            try {
                const event = JSON.parse(ev.data);
                handleGraphEvent(event);
            }
            catch {
                /* ignore */
            }
        });
        // Periodic full re-sync to catch any missed SSE events
        const resync = setInterval(async () => {
            try {
                const res = await fetch(apiUrl(`/debug/graph/${selectedSprintId}`));
                if (!res.ok)
                    return;
                const data = await res.json();
                setGraph(data);
                applyGraphToFlow(data);
            }
            catch {
                /* ignore */
            }
        }, 10_000);
        return () => {
            sse.close();
            sseRef.current = null;
            clearInterval(resync);
        };
    }, [selectedSprintId]); // eslint-disable-line react-hooks/exhaustive-deps
    const applyGraphToFlow = useCallback((g) => {
        const { nodes: visibleNodes, edges: visibleEdges } = filterVisibleGraph(g.nodes, g.edges);
        const fakeGraph = { ...g, nodes: visibleNodes, edges: visibleEdges };
        const flowNodes = serverToFlowNodes(fakeGraph);
        const flowEdges = serverToFlowEdges(fakeGraph);
        const laid = layoutGraph(flowNodes, flowEdges);
        setNodes(laid.nodes);
        setEdges(laid.edges);
    }, [setNodes, setEdges]);
    const handleGraphEvent = useCallback((event) => {
        setGraph((prev) => {
            if (!prev)
                return prev;
            // Deep-clone to mutate safely
            const g = JSON.parse(JSON.stringify(prev));
            switch (event.type) {
                case "node_added": {
                    const node = event.node;
                    const newEdges = (event.edges ?? []);
                    if (node)
                        g.nodes.push(node);
                    g.edges.push(...newEdges);
                    break;
                }
                case "status_changed": {
                    const nodeId = event.nodeId;
                    const transition = event.transition;
                    const n = g.nodes.find((x) => x.id === nodeId);
                    if (n) {
                        n.status = transition.to;
                        n.statusHistory.push(transition);
                        if (transition.to === "in_progress" && !n.startedAt)
                            n.startedAt = transition.timestamp;
                        if (["completed", "failed", "cancelled"].includes(transition.to))
                            n.completedAt = transition.timestamp;
                    }
                    break;
                }
                case "beat_started": {
                    const nodeId = event.nodeId;
                    const beat = event.beat;
                    const n = g.nodes.find((x) => x.id === nodeId);
                    if (n && Array.isArray(n.beats))
                        n.beats.push(beat);
                    break;
                }
                case "beat_completed": {
                    const nodeId = event.nodeId;
                    const beatId = event.beatId;
                    const patch = event.patch;
                    const n = g.nodes.find((x) => x.id === nodeId);
                    if (n && Array.isArray(n.beats)) {
                        const beat = n.beats.find((b) => b.beatId === beatId);
                        if (beat)
                            Object.assign(beat, patch);
                    }
                    break;
                }
                case "artifact_produced": {
                    const nodeId = event.nodeId;
                    const artifactId = event.artifactId;
                    const edge = event.edge;
                    const n = g.nodes.find((x) => x.id === nodeId);
                    if (n && !n.outputArtifactIds.includes(artifactId))
                        n.outputArtifactIds.push(artifactId);
                    if (edge)
                        g.edges.push(edge);
                    break;
                }
                case "decision": {
                    const nodeId = event.nodeId;
                    const entry = event.entry;
                    if (nodeId) {
                        const n = g.nodes.find((x) => x.id === nodeId);
                        if (n && Array.isArray(n.decisions))
                            n.decisions.push(entry);
                    }
                    break;
                }
                case "files_changed": {
                    const nodeId = event.nodeId;
                    const files = event.files;
                    const n = g.nodes.find((x) => x.id === nodeId);
                    if (n && Array.isArray(n.fileChanges))
                        n.fileChanges.push(...files);
                    break;
                }
                case "sprint_completed": {
                    g.status = event.status ?? "completed";
                    g.completedAt = new Date().toISOString();
                    break;
                }
                case "meeting_recorded": {
                    const nodeId = event.nodeId;
                    const meeting = event.meeting;
                    if (nodeId) {
                        const n = g.nodes.find((x) => x.id === nodeId);
                        if (n) {
                            if (!Array.isArray(n.meetings))
                                n.meetings = [];
                            n.meetings.push(meeting);
                        }
                    }
                    break;
                }
                case "memory_written": {
                    const nodeId = event.nodeId;
                    const entry = event.entry;
                    if (nodeId) {
                        const n = g.nodes.find((x) => x.id === nodeId);
                        if (n) {
                            if (!Array.isArray(n.memoryWrites))
                                n.memoryWrites = [];
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
    const onNodeClick = useCallback((_, node) => {
        setSelectedEdge(null);
        if (!graph)
            return;
        const serverNode = graph.nodes.find((n) => n.id === node.id);
        if (serverNode) {
            setSelectedNode(serverNode);
        }
    }, [graph]);
    const onEdgeClick = useCallback((_, edge) => {
        setSelectedNode(null);
        if (!graph)
            return;
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
    }, [graph]);
    const currentSprint = sprints.find((s) => s.sprintId === selectedSprintId);
    return (_jsxs("div", { className: "flex flex-col h-full", children: [_jsxs("div", { className: "flex items-center gap-3 px-4 py-2 border-b border-gray-200 bg-gray-50 shrink-0", children: [_jsxs("select", { className: "text-xs border border-gray-200 rounded px-2 py-1 bg-white", value: selectedSprintId ?? "", onChange: (e) => {
                            setSelectedSprintId(e.target.value || null);
                            setSelectedNode(null);
                        }, children: [_jsx("option", { value: "", children: "Select sprint\u2026" }), sprints.map((s) => (_jsxs("option", { value: s.sprintId, children: ["Sprint ", s.number] }, s.sprintId)))] }), graph && (_jsxs(_Fragment, { children: [_jsx("span", { className: "text-xs text-gray-600 truncate", children: graph.sprintGoal }), _jsx("span", { className: `text-[0.6rem] font-semibold px-1.5 py-0.5 rounded ${graph.status === "running"
                                    ? "bg-blue-100 text-blue-700"
                                    : graph.status === "completed"
                                        ? "bg-emerald-100 text-emerald-700"
                                        : graph.status === "failed"
                                            ? "bg-red-100 text-red-700"
                                            : "bg-gray-100 text-gray-700"}`, children: graph.status.toUpperCase() }), _jsxs("span", { className: "text-[0.6rem] text-gray-400", children: [graph.nodes.length, " nodes \u00B7 ", graph.edges.length, " edges"] })] }))] }), _jsx("div", { className: "flex-1 min-h-0", children: graph ? (_jsxs(ReactFlow, { nodes: nodes, edges: edges, onNodesChange: onNodesChange, onEdgesChange: onEdgesChange, onNodeClick: onNodeClick, onEdgeClick: onEdgeClick, nodeTypes: nodeTypes, edgeTypes: edgeTypes, fitView: true, minZoom: 0.2, maxZoom: 2, proOptions: { hideAttribution: true }, children: [_jsx(EdgeArrowMarker, {}), _jsx(Background, { color: "#e5e7eb", gap: 16 }), _jsx(Controls, { showInteractive: false }), _jsx(GraphLegend, {})] })) : (_jsx("div", { className: "flex items-center justify-center h-full text-gray-400 text-sm", children: selectedSprintId ? "Loading graph…" : "Select a sprint to view the execution graph." })) }), selectedNode && (_jsx(DebugDetailPanel, { node: selectedNode, onClose: () => setSelectedNode(null) })), selectedEdge && (_jsx(EdgeInfoPanel, { edge: selectedEdge, onClose: () => setSelectedEdge(null) }))] }));
}
