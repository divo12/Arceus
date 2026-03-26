import { startTransition, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Core, ElementDefinition } from "cytoscape";
import { GitBranch, Network, RefreshCw, Search } from "lucide-react";
import { type GraphNode, type MemoryListItem, memoryApi } from "../api/memory";
import { cn } from "../lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";

interface MemoryGraphExplorerProps {
  agentId: string;
  container?: string;
}

const NODE_MIN_SIZE = 20;
const NODE_MAX_SIZE = 50;
const MOBILE_BREAKPOINT_QUERY = "(max-width: 1023px)";

let coseBilkentRegistered = false;

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function scaleNodeSize(mentionCount: number) {
  const normalizedMentions = clamp(mentionCount || 1, 1, 18);
  return NODE_MIN_SIZE + ((normalizedMentions - 1) / 17) * (NODE_MAX_SIZE - NODE_MIN_SIZE);
}

function resolveCssColor(variableName: string, fallback: string) {
  if (typeof window === "undefined") {
    return fallback;
  }

  const styles = window.getComputedStyle(document.documentElement);
  const seen = new Set<string>();
  let currentVariable = variableName;

  while (currentVariable) {
    if (seen.has(currentVariable)) {
      break;
    }
    seen.add(currentVariable);

    const value = styles.getPropertyValue(currentVariable).trim();
    if (!value) {
      break;
    }

    const alias = value.match(/^var\((--[^),\s]+)\)$/);
    if (alias) {
      currentVariable = alias[1];
      continue;
    }

    return value;
  }

  return fallback;
}

function getNodeColor(entityType: string) {
  switch (entityType) {
    case "static":
      return resolveCssColor("--memory-static", "oklch(0.7 0.17 162)");
    case "dynamic":
      return resolveCssColor("--memory-dynamic", "oklch(0.65 0.24 270)");
    case "working":
      return resolveCssColor("--memory-working", "oklch(0.65 0.2 330)");
    case "procedural":
      return resolveCssColor("--memory-procedural", "oklch(0.75 0.16 85)");
    case "pattern":
      return resolveCssColor("--chart-3", "oklch(0.65 0.2 330)");
    case "habit":
      return resolveCssColor("--chart-4", "oklch(0.75 0.16 85)");
    case "concept":
      return resolveCssColor("--memory-priming", "oklch(0.65 0.18 200)");
    default:
      return resolveCssColor("--muted-foreground", "oklch(0.55 0 0)");
  }
}

function tokenize(text: string) {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .filter((token) => token.length >= 3);
}

function scoreRelatedMemory(memory: MemoryListItem, contextTokens: string[], primaryLabel: string) {
  const content = memory.content.toLowerCase();
  let score = 0;

  if (content.includes(primaryLabel.toLowerCase())) {
    score += 5;
  }

  for (const token of contextTokens) {
    if (content.includes(token)) {
      score += 1;
    }
  }

  score += memory.confidence * 2;
  score += memory.relevance_score;
  return score;
}

function isMobileViewport() {
  return typeof window !== "undefined" && window.matchMedia(MOBILE_BREAKPOINT_QUERY).matches;
}

function NodeDetails({
  orderedNodes,
  relatedMemories,
  relatedMemoriesQueryPending,
  selectedConnections,
  selectedNode,
}: {
  orderedNodes: GraphNode[];
  relatedMemories: MemoryListItem[];
  relatedMemoriesQueryPending: boolean;
  selectedConnections: Array<{
    relation_type: string;
    source_id: string;
    target_id: string;
    weight: number;
  }>;
  selectedNode: GraphNode | null;
}) {
  if (!selectedNode) {
    return (
      <div className="flex min-h-[280px] flex-col items-center justify-center gap-3 text-center text-muted-foreground">
        <Network className="h-8 w-8" />
        <p className="max-w-xs text-sm">
          Search the graph and click a node to inspect its links and related memories.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="rounded-md border border-border bg-muted/20 p-3">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <Badge>{selectedNode.entity_type}</Badge>
          <Badge variant="outline">{selectedNode.mention_count} mentions</Badge>
          <Badge variant="outline">{selectedConnections.length} links</Badge>
        </div>
        <h4 className="text-base font-semibold text-foreground">{selectedNode.name}</h4>
        {selectedNode.created_at ? (
          <p className="mt-1 text-xs text-muted-foreground">
            Created {new Date(selectedNode.created_at).toLocaleString()}
          </p>
        ) : null}
      </div>

      <div>
        <h5 className="mb-2 text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
          Relationships
        </h5>
        {!selectedConnections.length ? (
          <p className="text-sm text-muted-foreground">No linked edges for this node yet.</p>
        ) : (
          <div className="space-y-2">
            {selectedConnections.slice(0, 6).map((edge, index) => {
              const otherId = edge.source_id === selectedNode.id ? edge.target_id : edge.source_id;
              const otherNode = orderedNodes.find((node) => node.id === otherId);
              return (
                <div
                  key={`${edge.source_id}-${edge.target_id}-${index}`}
                  className="rounded-md border border-border px-3 py-2 text-sm"
                >
                  <div className="flex items-center justify-between gap-3">
                    <span className="truncate font-medium text-foreground">
                      {otherNode?.name ?? otherId}
                    </span>
                    <div className="flex items-center gap-2">
                      <Badge variant="outline">{edge.relation_type}</Badge>
                      <span className="text-xs text-muted-foreground">
                        {Math.round(edge.weight * 100)}%
                      </span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div>
        <h5 className="mb-2 text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
          Related Memories
        </h5>
        {relatedMemoriesQueryPending ? (
          <div className="space-y-2">
            {Array.from({ length: 3 }).map((_, index) => (
              <Skeleton key={index} className="h-14 rounded-md" />
            ))}
          </div>
        ) : relatedMemories.length ? (
          <div className="space-y-2">
            {relatedMemories.map((memory) => (
              <div key={memory.id} className="rounded-md border border-border px-3 py-2">
                <div className="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
                  <Badge variant="outline">{memory.memory_type ?? "memory"}</Badge>
                  <span>{Math.round(memory.confidence * 100)}%</span>
                </div>
                <p className="line-clamp-2 text-sm text-foreground">{memory.content}</p>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            No related memory snippets were found for this node in the selected container.
          </p>
        )}
      </div>
    </div>
  );
}

export function MemoryGraphExplorer({
  agentId,
  container,
}: MemoryGraphExplorerProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const cyRef = useRef<Core | null>(null);
  const lastTapRef = useRef<{ id: string; at: number } | null>(null);

  const [draftQuery, setDraftQuery] = useState("");
  const [query, setQuery] = useState("");
  const [depth, setDepth] = useState(2);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [mobileDetailOpen, setMobileDetailOpen] = useState(false);

  const {
    data,
    isLoading,
    isFetching,
    error,
    refetch,
  } = useQuery({
    queryKey: ["agents", "memory", "graph", agentId, query, container ?? "__all__", depth],
    queryFn: () => memoryApi.graphView(agentId, query, container, depth),
    enabled: query.trim().length > 0,
    retry: 1,
    staleTime: 15_000,
  });

  const orderedNodes = useMemo(() => {
    if (!data?.nodes?.length) {
      return [] as GraphNode[];
    }

    return data.center_node
      ? [data.center_node, ...data.nodes.filter((node) => node.id !== data.center_node?.id)]
      : data.nodes;
  }, [data?.center_node, data?.nodes]);

  const nodeById = useMemo(() => {
    return new Map(orderedNodes.map((node) => [node.id, node] as const));
  }, [orderedNodes]);

  const elements = useMemo(() => {
    return [
      ...orderedNodes.map((node) => ({
        data: {
          id: node.id,
          label: node.name,
          entityType: node.entity_type,
          mentionCount: node.mention_count,
          color: getNodeColor(node.entity_type),
          size: scaleNodeSize(node.mention_count),
        },
      })),
      ...(data?.edges ?? []).map((edge, index) => ({
        data: {
          id: `${edge.source_id}-${edge.target_id}-${index}`,
          source: edge.source_id,
          target: edge.target_id,
          label: edge.relation_type,
          weight: clamp(edge.weight || 0.2, 0.15, 1.5),
        },
      })),
    ] satisfies ElementDefinition[];
  }, [data?.edges, orderedNodes]);

  const selectedNode = useMemo(() => {
    if (!orderedNodes.length) {
      return null;
    }

    return orderedNodes.find((node) => node.id === selectedNodeId) ?? data?.center_node ?? orderedNodes[0];
  }, [data?.center_node, orderedNodes, selectedNodeId]);

  const selectedConnections = useMemo(() => {
    if (!selectedNode || !data?.edges?.length) {
      return [];
    }

    return data.edges.filter((edge) => (
      edge.source_id === selectedNode.id || edge.target_id === selectedNode.id
    ));
  }, [data?.edges, selectedNode]);

  const relatedMemoriesQuery = useQuery({
    queryKey: ["agents", "memory", "graph", "related", agentId, container ?? "__all__", selectedNode?.id ?? "__none__"],
    queryFn: () => memoryApi.memoryExplorer(agentId, container ?? "default", undefined, 25),
    enabled: Boolean(selectedNode && container),
    retry: 1,
    staleTime: 15_000,
  });

  const relatedMemories = useMemo(() => {
    if (!selectedNode) {
      return [] as MemoryListItem[];
    }

    const contextTokens = Array.from(new Set([
      ...tokenize(selectedNode.name),
      ...selectedConnections.flatMap((edge) => {
        const otherId = edge.source_id === selectedNode.id ? edge.target_id : edge.source_id;
        return tokenize(nodeById.get(otherId)?.name ?? "");
      }),
    ]));

    return [...(relatedMemoriesQuery.data?.items ?? [])]
      .map((memory) => ({
        memory,
        score: scoreRelatedMemory(memory, contextTokens, selectedNode.name),
      }))
      .filter(({ score }) => score > 0)
      .sort((left, right) => right.score - left.score)
      .slice(0, 5)
      .map(({ memory }) => memory);
  }, [nodeById, relatedMemoriesQuery.data?.items, selectedConnections, selectedNode]);

  useEffect(() => {
    if (!orderedNodes.length) {
      setSelectedNodeId(null);
      setMobileDetailOpen(false);
      return;
    }

    if (!selectedNodeId || !nodeById.has(selectedNodeId)) {
      setSelectedNodeId(data?.center_node?.id ?? orderedNodes[0]?.id ?? null);
    }
  }, [data?.center_node?.id, nodeById, orderedNodes, selectedNodeId]);

  useEffect(() => {
    if (!containerRef.current || !elements.length) {
      cyRef.current?.destroy();
      cyRef.current = null;
      return;
    }

    let cancelled = false;

    async function renderGraph() {
      const [{ default: cytoscape }, coseBilkentModule] = await Promise.all([
        import("cytoscape"),
        import("cytoscape-cose-bilkent"),
      ]);

      if (!coseBilkentRegistered) {
        cytoscape.use(coseBilkentModule.default);
        coseBilkentRegistered = true;
      }

      if (cancelled || !containerRef.current) {
        return;
      }

      const borderColor = resolveCssColor("--border", "oklch(0.37 0 0)");
      const mutedColor = resolveCssColor("--muted-foreground", "oklch(0.55 0 0)");
      const textColor = resolveCssColor("--foreground", "oklch(0.97 0 0)");
      const primaryColor = resolveCssColor("--primary", "oklch(0.7 0.17 162)");
      const backgroundColor = resolveCssColor("--card", "oklch(0.2 0 0)");

      const cy = cytoscape({
        container: containerRef.current,
        elements,
        layout: {
          name: "cose-bilkent",
          animate: true,
          animationDuration: 300,
          fit: true,
          padding: 36,
          randomize: false,
          nodeRepulsion: 4500,
          idealEdgeLength: 90,
          edgeElasticity: 0.3,
        } as never,
        style: ([
          {
            selector: "core",
            style: {
              "active-bg-opacity": 0,
              "outside-texture-bg-opacity": 0,
              "selection-box-opacity": 0,
              "background-color": backgroundColor,
            },
          },
          {
            selector: "node",
            style: {
              label: "data(label)",
              "background-color": "data(color)",
              width: "data(size)",
              height: "data(size)",
              "border-width": 1.5,
              "border-color": borderColor,
              color: textColor,
              "font-size": 10,
              "font-weight": 600,
              "text-wrap": "wrap",
              "text-max-width": 90,
              "text-valign": "bottom",
              "text-margin-y": 10,
              "text-halign": "center",
            },
          },
          {
            selector: "node.is-selected",
            style: {
              "border-width": 3,
              "border-color": primaryColor,
            },
          },
          {
            selector: "edge",
            style: {
              width: "mapData(weight, 0.15, 1.5, 1.5, 6)",
              "line-color": borderColor,
              "target-arrow-color": borderColor,
              "curve-style": "bezier",
              opacity: 0.7,
              label: "data(label)",
              color: mutedColor,
              "font-size": 8,
              "text-opacity": 0,
              "text-background-opacity": 0,
              "text-rotation": "autorotate",
            },
          },
          {
            selector: "edge.is-hovered",
            style: {
              "text-opacity": 1,
              "text-background-opacity": 0.92,
              "text-background-color": backgroundColor,
              "text-background-padding": 2,
              "text-border-opacity": 0,
            },
          },
        ]) as never,
      });

      cy.on("tap", "node", (event) => {
        const nodeId = String(event.target.id());
        setSelectedNodeId(nodeId);

        if (isMobileViewport()) {
          setMobileDetailOpen(true);
        }

        const lastTap = lastTapRef.current;
        const now = Date.now();
        if (lastTap && lastTap.id === nodeId && now - lastTap.at < 300) {
          cy.animate({
            center: { eles: event.target },
            zoom: Math.max(cy.zoom(), 1.05),
            duration: 250,
          });
        }
        lastTapRef.current = { id: nodeId, at: now };
      });

      cy.on("mouseover", "edge", (event) => {
        event.target.addClass("is-hovered");
      });

      cy.on("mouseout", "edge", (event) => {
        event.target.removeClass("is-hovered");
      });

      cyRef.current?.destroy();
      cyRef.current = cy;
    }

    void renderGraph();

    return () => {
      cancelled = true;
      cyRef.current?.destroy();
      cyRef.current = null;
    };
  }, [elements]);

  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) {
      return;
    }

    cy.batch(() => {
      cy.nodes().removeClass("is-selected");
      if (selectedNodeId) {
        cy.getElementById(selectedNodeId).addClass("is-selected");
      }
    });
  }, [selectedNodeId]);

  function submitSearch() {
    const nextQuery = draftQuery.trim();
    startTransition(() => {
      setQuery(nextQuery);
      setSelectedNodeId(null);
      setMobileDetailOpen(false);
    });
  }

  return (
    <div className="grid gap-4 xl:grid-cols-[1.5fr_0.95fr]">
      <div className="rounded-lg border border-border bg-card shadow-sm">
        <div className="flex flex-col gap-3 border-b border-border px-4 py-3 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <h3 className="text-sm font-medium">Memory Graph</h3>
            <p className="text-xs text-muted-foreground">
              Explore memory entities, relationships, and versioned knowledge clusters.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              value={draftQuery}
              onChange={(event) => setDraftQuery(event.target.value)}
              onKeyDown={(event) => event.key === "Enter" && submitSearch()}
              placeholder="Search entity or concept..."
              className="h-8 w-[220px] text-xs"
            />
            <select
              value={String(depth)}
              onChange={(event) => setDepth(Number(event.target.value))}
              className="h-8 rounded-md border border-border bg-background px-2 text-xs"
            >
              <option value="1">1 hop</option>
              <option value="2">2 hops</option>
              <option value="3">3 hops</option>
            </select>
            <Button size="sm" variant="outline" onClick={submitSearch} disabled={!draftQuery.trim()}>
              <Search className="mr-1.5 h-3.5 w-3.5" />
              Search
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => refetch()}
              disabled={!query || isFetching}
            >
              <RefreshCw className={cn("h-3.5 w-3.5", isFetching && "animate-spin")} />
            </Button>
          </div>
        </div>

        {!query ? (
          <div className="flex min-h-[420px] flex-col items-center justify-center gap-3 px-6 py-10 text-center text-muted-foreground">
            <Network className="h-10 w-10" />
            <div>
              <h4 className="text-sm font-medium text-foreground">Search the knowledge graph</h4>
              <p className="mt-1 max-w-md text-sm">
                Enter a concept, memory phrase, or entity name to build a graph-centered view.
              </p>
            </div>
          </div>
        ) : isLoading ? (
          <div className="space-y-3 p-4">
            <Skeleton className="h-[420px] rounded-lg" />
          </div>
        ) : data?.nodes?.length ? (
          <div className="p-4">
            <div className="mb-3 flex flex-wrap gap-2">
              {Array.from(new Set(orderedNodes.map((node) => node.entity_type))).map((entityType) => (
                <span
                  key={entityType}
                  className="inline-flex items-center gap-1.5 rounded-full border border-border px-2 py-1 text-[10px] text-muted-foreground"
                >
                  <span
                    className="h-2 w-2 rounded-full"
                    style={{ backgroundColor: getNodeColor(entityType) }}
                  />
                  {entityType}
                </span>
              ))}
            </div>
            <div
              ref={containerRef}
              className="h-[420px] overflow-hidden rounded-lg border border-border bg-muted/20"
            />
          </div>
        ) : (
          <div className="flex min-h-[420px] flex-col items-center justify-center gap-3 px-6 py-10 text-center text-muted-foreground">
            <GitBranch className="h-10 w-10" />
            <div>
              <h4 className="text-sm font-medium text-foreground">Knowledge graph not yet populated</h4>
              <p className="mt-1 max-w-md text-sm">
                No graph view matched this query yet. Try a broader concept or wait for graph projections to land.
              </p>
            </div>
            {error ? (
              <p className="text-xs">
                The graph projection endpoint may still be unavailable in this environment.
              </p>
            ) : null}
          </div>
        )}
      </div>

      <div className="hidden rounded-lg border border-border bg-card p-4 shadow-sm xl:block">
        <div className="mb-3 flex items-center gap-2">
          <GitBranch className="h-4 w-4 text-[var(--memory-priming)]" />
          <h3 className="text-sm font-medium">Node Detail</h3>
        </div>
        <NodeDetails
          orderedNodes={orderedNodes}
          relatedMemories={relatedMemories}
          relatedMemoriesQueryPending={relatedMemoriesQuery.isLoading}
          selectedConnections={selectedConnections}
          selectedNode={selectedNode}
        />
      </div>

      <Sheet open={mobileDetailOpen && Boolean(selectedNode)} onOpenChange={setMobileDetailOpen}>
        <SheetContent side="bottom" className="max-h-[82dvh] overflow-y-auto pb-[env(safe-area-inset-bottom)] xl:hidden">
          <SheetHeader>
            <SheetTitle className="text-sm">Node Detail</SheetTitle>
          </SheetHeader>
          <div className="mt-4">
            <NodeDetails
              orderedNodes={orderedNodes}
              relatedMemories={relatedMemories}
              relatedMemoriesQueryPending={relatedMemoriesQuery.isLoading}
              selectedConnections={selectedConnections}
              selectedNode={selectedNode}
            />
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}
