export function HierarchyEdgeLegend() {
  return (
    <div className="flex items-center gap-4 rounded-md border border-border bg-background/85 px-2.5 py-1.5 text-[10px] text-muted-foreground backdrop-blur">
      <span className="flex items-center gap-1.5">
        <svg width="20" height="2" aria-hidden="true">
          <line x1="0" y1="1" x2="20" y2="1" stroke="currentColor" strokeWidth="2" />
        </svg>
        Reports to
      </span>
      <span className="flex items-center gap-1.5">
        <svg width="20" height="2" aria-hidden="true">
          <line
            x1="0"
            y1="1"
            x2="20"
            y2="1"
            stroke="var(--chart-1)"
            strokeWidth="1.5"
            strokeDasharray="6,4"
            opacity="0.7"
          />
        </svg>
        Delegates to
      </span>
    </div>
  );
}
