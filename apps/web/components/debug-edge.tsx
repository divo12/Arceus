"use client";

import { memo } from "react";
import { BaseEdge, getSmoothStepPath, type EdgeProps } from "@xyflow/react";

const EDGE_STYLES: Record<string, { stroke: string; strokeDasharray?: string; strokeWidth: number }> = {
  dependency: { stroke: "#6b7280", strokeWidth: 2 },
  artifact_flow: { stroke: "#3b82f6", strokeDasharray: "8 4", strokeWidth: 2 },
  rework: { stroke: "#f97316", strokeWidth: 2.5 },
  escalation: { stroke: "#ef4444", strokeDasharray: "4 4", strokeWidth: 2.5 },
};

function DebugEdgeComponent(props: EdgeProps) {
  const { sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data } = props;
  const edgeType = (data?.type as string) ?? "dependency";
  const style = EDGE_STYLES[edgeType] ?? EDGE_STYLES.dependency;

  const [edgePath] = getSmoothStepPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    borderRadius: 12,
  });

  return (
    <BaseEdge
      path={edgePath}
      style={{ ...style, cursor: "pointer" }}
      markerEnd="url(#arrowhead)"
      label={props.label}
      labelStyle={{ fontSize: "0.65rem", fill: "#6b7280", fontWeight: 500 }}
      labelBgStyle={{ fill: "white", fillOpacity: 0.85 }}
      labelBgPadding={[4, 6] as [number, number]}
      labelBgBorderRadius={4}
    />
  );
}

export const DebugEdge = memo(DebugEdgeComponent);

/** SVG marker definition — include this once in the React Flow container. */
export function EdgeArrowMarker() {
  return (
    <svg style={{ position: "absolute", width: 0, height: 0 }}>
      <defs>
        <marker
          id="arrowhead"
          viewBox="0 0 10 8"
          refX="8"
          refY="4"
          markerWidth="8"
          markerHeight="6"
          orient="auto-start-reverse"
        >
          <path d="M 0 0 L 10 4 L 0 8 Z" fill="#6b7280" />
        </marker>
      </defs>
    </svg>
  );
}
