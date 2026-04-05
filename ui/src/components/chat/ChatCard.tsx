import { Check, X, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface ChatCardProps {
  messageId: string;
  cardType: string;
  cardData: unknown;
  cardState: Record<string, unknown> | null;
  onAction?: (messageId: string, action: string, editedData?: unknown) => void;
  isActionPending?: boolean;
}

export function ChatCard({
  messageId,
  cardType,
  cardData,
  cardState,
  onAction,
  isActionPending,
}: ChatCardProps) {
  const data = cardData as Record<string, unknown>;
  const resolved = cardState?.action as string | undefined;

  const cardLabel = CARD_LABELS[cardType] ?? cardType;

  return (
    <div className="w-full max-w-md border border-border rounded-xl bg-card shadow-sm overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-border bg-muted/30">
        <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
          {cardLabel}
        </span>
        {resolved && (
          <span
            className={cn(
              "ml-auto text-xs font-medium px-2 py-0.5 rounded-full",
              resolved === "approved" && "bg-green-500/10 text-green-600",
              resolved === "rejected" && "bg-red-500/10 text-red-600",
              resolved === "dismissed" && "bg-muted text-muted-foreground",
            )}
          >
            {resolved}
          </span>
        )}
      </div>

      {/* Body */}
      <div className="px-4 py-3 text-sm space-y-1.5">
        <CardBody cardType={cardType} data={data} />
      </div>

      {/* Actions */}
      {!resolved && onAction && (
        <div className="flex items-center gap-2 px-4 py-2.5 border-t border-border bg-muted/20">
          <Button
            size="sm"
            variant="default"
            className="h-7 text-xs"
            disabled={isActionPending}
            onClick={() => onAction(messageId, "approved")}
          >
            <Check className="h-3.5 w-3.5 mr-1" />
            Approve
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs"
            disabled={isActionPending}
            onClick={() => onAction(messageId, "rejected")}
          >
            <X className="h-3.5 w-3.5 mr-1" />
            Reject
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 text-xs ml-auto"
            disabled={isActionPending}
            onClick={() => onAction(messageId, "dismissed")}
          >
            Dismiss
          </Button>
        </div>
      )}
    </div>
  );
}

const CARD_LABELS: Record<string, string> = {
  task_proposal: "Task Proposal",
  org_plan: "Organization Plan",
  issue: "Issue",
  budget_request: "Budget Request",
  status_report: "Status Report",
  escalation: "Escalation",
  hire_proposal: "Hire Proposal",
  decomposition_plan: "Task Breakdown",
};

function CardBody({ cardType, data }: { cardType: string; data: Record<string, unknown> }) {
  switch (cardType) {
    case "task_proposal":
      return (
        <>
          <div className="font-medium text-foreground">{String(data.title ?? "Untitled task")}</div>
          {data.description && (
            <p className="text-muted-foreground text-xs">{String(data.description)}</p>
          )}
          {(data.assigneeRole || data.assignee) && (
            <p className="text-xs">
              <span className="text-muted-foreground">Assignee:</span> {String(data.assigneeRole ?? data.assignee)}
            </p>
          )}
          {data.priority && (
            <p className="text-xs">
              <span className="text-muted-foreground">Priority:</span> {String(data.priority)}
            </p>
          )}
        </>
      );
    case "decomposition_plan": {
      const tasks = Array.isArray(data.tasks) ? (data.tasks as Array<{ title: string; description?: string; assigneeRole: string; priority: string }>) : [];
      return (
        <>
          <div className="font-medium text-foreground">{tasks.length} Tasks</div>
          <div className="space-y-2 mt-1">
            {tasks.map((t, i) => (
              <div key={i} className="border border-border/50 rounded-lg p-2 bg-background/50">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-foreground">{t.title}</span>
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">{t.priority}</span>
                </div>
                {t.description && <p className="text-[11px] text-muted-foreground mt-0.5">{t.description}</p>}
                <p className="text-[10px] text-muted-foreground mt-0.5">Assigned to: {t.assigneeRole}</p>
              </div>
            ))}
          </div>
        </>
      );
    }
    case "hire_proposal":
      return (
        <>
          <div className="font-medium text-foreground">{String(data.name ?? "Agent")} — {String(data.title ?? data.role ?? "Role")}</div>
          {data.justification && <p className="text-muted-foreground text-xs">{String(data.justification)}</p>}
          {data.delegationStyle && <p className="text-xs"><span className="text-muted-foreground">Style:</span> {String(data.delegationStyle)}</p>}
        </>
      );
    case "org_plan":
      return (
        <>
          <div className="font-medium text-foreground">
            {String(data.title ?? "Org Restructure")}
          </div>
          {data.summary && (
            <p className="text-muted-foreground text-xs">{String(data.summary)}</p>
          )}
          {Array.isArray(data.changes) && (
            <ul className="list-disc list-inside text-xs text-muted-foreground space-y-0.5">
              {(data.changes as Array<string | { description?: string }>).map((c, i) => (
                <li key={i}>{typeof c === "string" ? c : (c.description ?? JSON.stringify(c))}</li>
              ))}
            </ul>
          )}
        </>
      );
    case "budget_request":
      return (
        <>
          <div className="font-medium text-foreground">{String(data.title ?? "Budget Request")}</div>
          {data.amount !== undefined && (
            <p className="text-xs">
              <span className="text-muted-foreground">Amount:</span>{" "}
              <span className="font-mono">
                {typeof data.amount === "number" ? `$${data.amount.toLocaleString()}` : `$${String(data.amount)}`}
                {data.currency ? ` ${String(data.currency)}` : ""}
              </span>
            </p>
          )}
          {(data.justification || data.reason) && (
            <p className="text-muted-foreground text-xs">{String(data.justification ?? data.reason)}</p>
          )}
        </>
      );
    case "status_report":
      return (
        <>
          <div className="font-medium text-foreground">Status Report</div>
          {data.summary && <p className="text-muted-foreground text-xs">{String(data.summary)}</p>}
          {(data.agentCount !== undefined || data.openTasks !== undefined) && (
            <div className="grid grid-cols-2 gap-1 text-xs mt-1">
              {data.agentCount !== undefined && (
                <p><span className="text-muted-foreground">Agents:</span> {String(data.activeAgentCount ?? data.agentCount)}/{String(data.agentCount)} active</p>
              )}
              {data.openTasks !== undefined && (
                <p><span className="text-muted-foreground">Tasks:</span> {String(data.openTasks)} open, {String(data.completedTasks ?? 0)} done</p>
              )}
              {data.budgetSpent !== undefined && (
                <p><span className="text-muted-foreground">Budget:</span> ${String(data.budgetSpent)}{data.budgetLimit ? ` / $${String(data.budgetLimit)}` : ""}</p>
              )}
              {data.pendingEscalations !== undefined && Number(data.pendingEscalations) > 0 && (
                <p className="text-amber-500"><span className="text-muted-foreground">Escalations:</span> {String(data.pendingEscalations)}</p>
              )}
            </div>
          )}
          {Array.isArray(data.highlights) && (
            <ul className="list-disc list-inside text-xs text-muted-foreground space-y-0.5">
              {(data.highlights as string[]).map((h, i) => (
                <li key={i}>{h}</li>
              ))}
            </ul>
          )}
        </>
      );
    case "escalation":
      return (
        <>
          <div className="font-medium text-red-500">{String(data.title ?? data.agentName ?? "Escalation")}</div>
          {data.question && <p className="text-muted-foreground text-xs">{String(data.question)}</p>}
          {data.reason && <p className="text-muted-foreground text-xs">{String(data.reason)}</p>}
          {data.severity && (
            <p className="text-xs">
              <span className="text-muted-foreground">Severity:</span>{" "}
              <span className={cn(
                data.severity === "high" && "text-red-500",
                data.severity === "medium" && "text-amber-500",
                data.severity === "low" && "text-muted-foreground",
              )}>
                {String(data.severity)}
              </span>
            </p>
          )}
        </>
      );
    case "issue":
      return (
        <>
          <div className="font-medium text-foreground">{String(data.title ?? "Issue")}</div>
          {data.description && (
            <p className="text-muted-foreground text-xs">{String(data.description)}</p>
          )}
          {data.priority && (
            <p className="text-xs">
              <span className="text-muted-foreground">Priority:</span> {String(data.priority)}
            </p>
          )}
          {data.status && (
            <p className="text-xs">
              <span className="text-muted-foreground">Status:</span> {String(data.status)}
            </p>
          )}
        </>
      );
    default:
      return (
        <pre className="text-xs overflow-auto text-muted-foreground">
          {JSON.stringify(data, null, 2)}
        </pre>
      );
  }
}
