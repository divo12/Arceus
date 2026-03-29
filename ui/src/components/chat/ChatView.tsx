import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { useChat } from "../../hooks/useChat";
import { useCompany } from "../../context/CompanyContext";
import { dashboardApi } from "../../api/dashboard";
import { queryKeys } from "../../lib/queryKeys";
import { ChatBubble } from "./ChatBubble";
import { ChatStreamingBubble } from "./ChatStreamingBubble";
import { ChatInput } from "./ChatInput";
import { Bot, MessageSquare, Users, ListChecks, DollarSign, AlertTriangle } from "lucide-react";

export function ChatView() {
  const {
    messages,
    isLoading,
    streaming,
    sendMessage,
    cancelStream,
    cardAction,
    isCardActionPending,
  } = useChat();

  const { selectedCompanyId } = useCompany();
  const companyId = selectedCompanyId ?? "";

  const { data: dashboard } = useQuery({
    queryKey: queryKeys.dashboard(companyId),
    queryFn: () => dashboardApi.summary(companyId),
    enabled: !!companyId,
  });

  const scrollRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom when new messages arrive or tokens stream in
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length, streaming.tokens]);

  function handleCardAction(messageId: string, action: string, editedData?: unknown) {
    cardAction({ messageId, action, editedData });
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Stats header bar */}
      {dashboard && <StatsHeader dashboard={dashboard} />}

      {/* Messages area */}
      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto">
        {isLoading ? (
          <div className="flex items-center justify-center h-full">
            <div className="flex items-center gap-2 text-muted-foreground text-sm">
              <Bot className="h-4 w-4 animate-pulse" />
              Loading conversation…
            </div>
          </div>
        ) : messages.length === 0 && !streaming.isStreaming ? (
          <EmptyChat onSuggestion={sendMessage} />
        ) : (
          <div className="max-w-3xl mx-auto py-4">
            {messages.map((msg) => (
              <ChatBubble
                key={msg.id}
                message={msg}
                onCardAction={handleCardAction}
                isCardActionPending={isCardActionPending}
              />
            ))}
            <ChatStreamingBubble streaming={streaming} />
            <div ref={bottomRef} />
          </div>
        )}
      </div>

      {/* Input area */}
      <ChatInput
        onSend={sendMessage}
        onCancel={cancelStream}
        isStreaming={streaming.isStreaming}
        disabled={isLoading}
      />
    </div>
  );
}

function EmptyChat({ onSuggestion }: { onSuggestion: (msg: string) => void }) {
  const suggestions = [
    "Give me a status briefing",
    "What tasks are open?",
    "Who's on the team?",
    "Propose a new task",
  ];

  return (
    <div className="flex flex-col items-center justify-center h-full px-4">
      <div className="bg-primary/5 p-5 rounded-2xl mb-6">
        <MessageSquare className="h-10 w-10 text-primary/60" />
      </div>
      <h2 className="text-lg font-semibold text-foreground mb-1">Chat with your CEO</h2>
      <p className="text-sm text-muted-foreground mb-8 text-center max-w-sm">
        Ask about company status, propose tasks, review org changes, or get a briefing.
      </p>
      <div className="grid grid-cols-2 gap-2 max-w-md">
        {suggestions.map((s) => (
          <button
            key={s}
            onClick={() => onSuggestion(s)}
            className="text-left text-sm px-4 py-2.5 rounded-xl border border-border bg-muted/30 hover:bg-muted/60 text-muted-foreground hover:text-foreground transition-colors"
          >
            {s}
          </button>
        ))}
      </div>
    </div>
  );
}

/* ---------- Stats header bar ---------- */

function StatsHeader({ dashboard }: { dashboard: import("@paperclipai/shared").DashboardSummary }) {
  const agentCount = dashboard.agents.active;
  const tasksDone = dashboard.tasks.done;
  const tasksTotal = dashboard.tasks.open + dashboard.tasks.inProgress + dashboard.tasks.blocked + dashboard.tasks.done;
  const budgetSpend = dashboard.costs.monthBudgetCents
    ? `$${(dashboard.costs.monthSpendCents / 100).toFixed(0)}/$${(dashboard.costs.monthBudgetCents / 100).toFixed(0)}`
    : `$${(dashboard.costs.monthSpendCents / 100).toFixed(0)}/∞`;
  const escalations = dashboard.pendingApprovals;

  const stats = [
    { icon: Users, label: "Agents", value: String(agentCount) },
    { icon: ListChecks, label: "Tasks", value: `${tasksDone}/${tasksTotal}` },
    { icon: DollarSign, label: "Budget", value: budgetSpend },
    { icon: AlertTriangle, label: "Escalations", value: String(escalations), warn: escalations > 0 },
  ];

  return (
    <div className="flex items-center gap-4 px-4 py-2 border-b border-border bg-muted/20 text-xs">
      <div className="flex items-center gap-4 max-w-3xl mx-auto w-full">
        {stats.map((s) => (
          <div
            key={s.label}
            className={`flex items-center gap-1.5 ${s.warn ? "text-amber-500" : "text-muted-foreground"}`}
          >
            <s.icon className="h-3.5 w-3.5" />
            <span className="font-medium">{s.label}</span>
            <span className="tabular-nums">{s.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
