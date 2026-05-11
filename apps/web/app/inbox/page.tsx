"use client";

import { useEffect, useState } from "react";
import { PageShell } from "../../components/layout/page-shell";
import { fetchWithAuth } from "../../lib/api";
import { useAuth } from "../../contexts/auth-context";
import { Bell, CheckCircle, XCircle, Clock, MessageSquare, GitPullRequest } from "lucide-react";

type Approval = {
  id: string;
  type: string;
  status: "pending" | "approved" | "rejected";
  summary: string;
  requestedBy: string;
  createdAt?: string;
};

type ChatMessage = {
  id: string;
  role: string;
  content: string;
  createdAt: string;
  cardType: string | null;
};

type Meeting = {
  id: string;
  type: string;
  summary: string;
  status: string;
  createdAt: string;
  participants?: string[];
};

type InboxItem = {
  kind: "approval" | "message" | "meeting";
  id: string;
  title: string;
  detail: string;
  status: string;
  time: string;
};

function formatTime(iso: string) {
  try {
    const d = new Date(iso);
    const now = Date.now();
    const diffMs = now - d.getTime();
    if (diffMs < 60_000) return "just now";
    if (diffMs < 3600_000) return `${Math.floor(diffMs / 60_000)}m ago`;
    if (diffMs < 86400_000) return `${Math.floor(diffMs / 3600_000)}h ago`;
    return d.toLocaleDateString();
  } catch {
    return "";
  }
}

function ItemIcon({ kind, status }: { kind: string; status: string }) {
  if (kind === "approval") {
    if (status === "approved") return <CheckCircle className="h-4 w-4" style={{ color: "var(--status-success)" }} />;
    if (status === "rejected") return <XCircle className="h-4 w-4" style={{ color: "var(--status-error)" }} />;
    return <Clock className="h-4 w-4" style={{ color: "var(--status-warning)" }} />;
  }
  if (kind === "meeting") return <GitPullRequest className="h-4 w-4" style={{ color: "var(--role-cto)" }} />;
  return <MessageSquare className="h-4 w-4" style={{ color: "var(--role-ceo)" }} />;
}

export default function InboxPage() {
  const { token } = useAuth();
  const [items, setItems] = useState<InboxItem[]>([]);
  const [filter, setFilter] = useState<"all" | "approvals" | "messages" | "meetings">("all");

  useEffect(() => {
    let active = true;
    async function load() {
      try {
        const [snapRes, meetingsRes] = await Promise.all([
          fetchWithAuth("/company", token, { cache: "no-store" }),
          fetchWithAuth("/meetings", token, { cache: "no-store" }),
        ]);
        if (!active) return;

        const inbox: InboxItem[] = [];

        if (snapRes.ok) {
          const snapshot = await snapRes.json();

          // Approvals
          for (const a of snapshot.approvals ?? []) {
            inbox.push({
              kind: "approval",
              id: a.id,
              title: a.summary || `Approval: ${a.type}`,
              detail: `Requested by ${a.requestedBy || "system"}`,
              status: a.status,
              time: a.createdAt || "",
            });
          }

          // Recent board/CEO messages (last 20)
          const msgs = (snapshot.chatMessages ?? []).slice(-20).reverse();
          for (const m of msgs) {
            inbox.push({
              kind: "message",
              id: m.id,
              title: m.role === "board" ? "Board message" : m.cardType ? `CEO: ${m.cardType}` : "CEO response",
              detail: (m.content || "").slice(0, 160),
              status: m.role,
              time: m.createdAt || "",
            });
          }
        }

        if (meetingsRes.ok) {
          const meetings: Meeting[] = await meetingsRes.json();
          for (const m of meetings.slice(0, 15)) {
            inbox.push({
              kind: "meeting",
              id: m.id,
              title: `Meeting: ${m.type}`,
              detail: m.summary.slice(0, 160),
              status: m.status,
              time: m.createdAt || "",
            });
          }
        }

        // Sort by time descending
        inbox.sort((a, b) => {
          if (!a.time && !b.time) return 0;
          if (!a.time) return 1;
          if (!b.time) return -1;
          return new Date(b.time).getTime() - new Date(a.time).getTime();
        });

        setItems(inbox);
      } catch { /* ignore */ }
    }
    load();
    const id = setInterval(load, 3000);
    return () => { active = false; clearInterval(id); };
  }, [token]);

  const filtered = filter === "all" ? items : items.filter((i) =>
    filter === "approvals" ? i.kind === "approval" :
    filter === "messages" ? i.kind === "message" :
    i.kind === "meeting"
  );

  const pendingCount = items.filter((i) => i.kind === "approval" && i.status === "pending").length;

  return (
    <PageShell title="Inbox" description="Approvals, messages, and meeting notifications">
      {/* Filter bar */}
      <div className="mb-4 flex items-center gap-2">
        {(["all", "approvals", "messages", "meetings"] as const).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`px-3 py-1.5 text-[0.75rem] font-medium transition-colors border ${
              filter === f
                ? "border-[var(--text-muted)] bg-[var(--bg-tertiary)] text-[var(--text-primary)]"
                : "border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text-secondary)]"
            }`}
          >
            {f === "all" ? "All" : f.charAt(0).toUpperCase() + f.slice(1)}
            {f === "approvals" && pendingCount > 0 && (
              <span className="ml-1.5 inline-flex h-4 w-4 items-center justify-center text-[0.5625rem] font-bold rounded-full" style={{ backgroundColor: "var(--status-warning)", color: "#000" }}>
                {pendingCount}
              </span>
            )}
          </button>
        ))}
        <span className="ml-auto text-[0.75rem] text-[var(--text-muted)]">{filtered.length} items</span>
      </div>

      {filtered.length === 0 ? (
        <div className="flex h-48 items-center justify-center text-[var(--text-muted)]">
          <div className="text-center">
            <Bell className="mx-auto h-8 w-8 mb-2 opacity-30" />
            <p className="text-sm">Inbox is empty</p>
          </div>
        </div>
      ) : (
        <div className="space-y-1">
          {filtered.map((item) => (
            <div
              key={`${item.kind}-${item.id}`}
              className={`flex items-start gap-3 border bg-[var(--bg-secondary)] px-4 py-3 ${
                item.kind === "approval" && item.status === "pending"
                  ? "border-[var(--status-warning)]"
                  : "border-[var(--border)]"
              }`}
            >
              <div className="mt-0.5 shrink-0">
                <ItemIcon kind={item.kind} status={item.status} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-[0.8125rem] font-medium text-[var(--text-primary)]">{item.title}</span>
                  <span
                    className="inline-flex px-1.5 py-px text-[0.5625rem] font-semibold uppercase tracking-wider"
                    style={{
                      backgroundColor:
                        item.status === "pending" ? "var(--status-warning)" :
                        item.status === "approved" || item.status === "completed" ? "var(--status-success)" :
                        item.status === "rejected" ? "var(--status-error)" :
                        "var(--bg-tertiary)",
                      color: item.status === "pending" || item.status === "approved" || item.status === "completed" || item.status === "rejected" ? "#000" : "var(--text-muted)",
                    }}
                  >
                    {item.status}
                  </span>
                </div>
                <p className="mt-0.5 text-[0.75rem] text-[var(--text-muted)] line-clamp-2">{item.detail}</p>
              </div>
              {item.time && (
                <span className="shrink-0 text-[0.6875rem] text-[var(--text-muted)]">{formatTime(item.time)}</span>
              )}
            </div>
          ))}
        </div>
      )}
    </PageShell>
  );
}
