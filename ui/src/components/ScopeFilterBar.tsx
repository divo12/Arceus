import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "../lib/utils";

export type MemoryScopeOption = "all" | "startup" | "employee" | "task";
export type MemoryTierOption = "static" | "dynamic" | "working";
export type MemoryVisibilityOption = "private" | "shared" | "board";

interface ScopeFilterBarProps {
  scope: MemoryScopeOption;
  onScopeChange: (value: MemoryScopeOption) => void;
  tiers: MemoryTierOption[];
  onTierToggle: (value: MemoryTierOption) => void;
  visibilities: MemoryVisibilityOption[];
  onVisibilityToggle: (value: MemoryVisibilityOption) => void;
  containerValue: string;
  onContainerValueChange: (value: string) => void;
  containerSuggestions?: string[];
}

const tierOptions: Array<{ value: MemoryTierOption; label: string }> = [
  { value: "static", label: "Static" },
  { value: "dynamic", label: "Dynamic" },
  { value: "working", label: "Working" },
];

const visibilityOptions: Array<{ value: MemoryVisibilityOption; label: string }> = [
  { value: "private", label: "Private" },
  { value: "shared", label: "Shared" },
  { value: "board", label: "Board" },
];

export function ScopeFilterBar({
  scope,
  onScopeChange,
  tiers,
  onTierToggle,
  visibilities,
  onVisibilityToggle,
  containerValue,
  onContainerValueChange,
  containerSuggestions = [],
}: ScopeFilterBarProps) {
  return (
    <div className="sticky top-0 z-10 rounded-lg border border-border bg-card/95 px-3 py-3 shadow-sm backdrop-blur supports-[backdrop-filter]:bg-card/80">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-muted-foreground">Scope</span>
            <Select value={scope} onValueChange={(value) => onScopeChange(value as MemoryScopeOption)}>
              <SelectTrigger size="sm" className="w-[140px]">
                <SelectValue placeholder="Select scope" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All</SelectItem>
                <SelectItem value="startup">Startup</SelectItem>
                <SelectItem value="employee">Employee</SelectItem>
                <SelectItem value="task">Task</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-medium text-muted-foreground">Tier</span>
            {tierOptions.map((option) => {
              const selected = tiers.includes(option.value);
              return (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => onTierToggle(option.value)}
                  className="rounded-full focus:outline-none focus:ring-2 focus:ring-ring/40"
                >
                  <Badge
                    variant={selected ? "default" : "outline"}
                    className={cn("cursor-pointer transition-colors", !selected && "hover:bg-accent/50")}
                  >
                    {option.label}
                  </Badge>
                </button>
              );
            })}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-medium text-muted-foreground">Visibility</span>
            {visibilityOptions.map((option) => {
              const selected = visibilities.includes(option.value);
              return (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => onVisibilityToggle(option.value)}
                  className="rounded-full focus:outline-none focus:ring-2 focus:ring-ring/40"
                >
                  <Badge
                    variant={selected ? "secondary" : "outline"}
                    className={cn("cursor-pointer transition-colors", !selected && "hover:bg-accent/50")}
                  >
                    {option.label}
                  </Badge>
                </button>
              );
            })}
          </div>
        </div>

        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-muted-foreground">Container</span>
          <Input
            value={containerValue}
            onChange={(event) => onContainerValueChange(event.target.value)}
            placeholder="Task id or full container"
            list="memory-container-suggestions"
            className="h-8 w-full min-w-[180px] text-xs lg:w-[220px]"
          />
          <datalist id="memory-container-suggestions">
            {containerSuggestions.map((suggestion) => (
              <option key={suggestion} value={suggestion} />
            ))}
          </datalist>
        </div>
      </div>
    </div>
  );
}
