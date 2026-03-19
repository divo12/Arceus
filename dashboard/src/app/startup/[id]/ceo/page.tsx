"use client"

import * as React from "react"
import { Send, Loader2, Users, Check, X, ChevronRight, ArrowRight, Sparkles } from "lucide-react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { api } from "@/lib/api"
import { useParams, useRouter } from "next/navigation"

interface ChatMessage {
  id: string
  role: "user" | "assistant"
  content: string
  created_at: string
}

interface ProposedRole {
  role: string
  title: string
  level: number
  reports_to: string
  responsibilities: string
}

interface HierarchyProposal {
  startup_id: string
  roles: ProposedRole[]
  reasoning: string
  estimated_monthly_cost: number
}

type Phase = "chatting" | "proposing" | "reviewing" | "approving" | "approved"

export default function CeoChatPage() {
  const params = useParams()
  const router = useRouter()
  const startupId = params.id as string

  const [messages, setMessages] = React.useState<ChatMessage[]>([])
  const [input, setInput] = React.useState("")
  const [isStreaming, setIsStreaming] = React.useState(false)
  const [isLoading, setIsLoading] = React.useState(true)
  const [phase, setPhase] = React.useState<Phase>("chatting")
  const [proposal, setProposal] = React.useState<HierarchyProposal | null>(null)
  const [editedRoles, setEditedRoles] = React.useState<ProposedRole[]>([])
  const [teamExists, setTeamExists] = React.useState(false)
  const scrollRef = React.useRef<HTMLDivElement>(null)

  function scrollToBottom() {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }
  React.useEffect(() => { scrollToBottom() }, [messages, phase])

  // Load chat history + check if team already exists
  React.useEffect(() => {
    async function init() {
      try {
        const [history, hierarchy] = await Promise.all([
          api.get<ChatMessage[]>(`/startups/${startupId}/chat/history`),
          api.get<{ nodes: { role: string }[] }>(`/startups/${startupId}/hierarchy`),
        ])
        setMessages(history)
        // If there are agents beyond CEO, team is already built
        const nonCeoAgents = hierarchy.nodes.filter(n => n.role !== "CEO")
        if (nonCeoAgents.length > 0) {
          setTeamExists(true)
          setPhase("approved")
        }
      } catch (e) {
        console.error("Failed to load:", e)
      } finally {
        setIsLoading(false)
      }
    }
    init()
  }, [startupId])

  async function handleSend() {
    const content = input.trim()
    if (!content || isStreaming) return

    const userMsg: ChatMessage = {
      id: `temp-${Date.now()}`,
      role: "user",
      content,
      created_at: new Date().toISOString(),
    }
    setMessages((prev) => [...prev, userMsg])
    setInput("")
    setIsStreaming(true)

    const assistantId = `stream-${Date.now()}`
    setMessages((prev) => [
      ...prev,
      { id: assistantId, role: "assistant", content: "", created_at: new Date().toISOString() },
    ])

    try {
      for await (const event of api.postStream(
        `/startups/${startupId}/chat/send`,
        { content }
      )) {
        if (event.event === "token") {
          const token = JSON.parse(event.data) as string
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantId ? { ...m, content: m.content + token } : m
            )
          )
          scrollToBottom()
        } else if (event.event === "done") {
          break
        } else if (event.event === "error") {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantId
                ? { ...m, content: `Error: ${event.data}` }
                : m
            )
          )
        }
      }
    } catch (e) {
      console.error("Stream error:", e)
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantId
            ? { ...m, content: "Failed to get response. Is the backend running?" }
            : m
        )
      )
    } finally {
      setIsStreaming(false)
    }
  }

  async function handleProposeTeam() {
    setPhase("proposing")
    try {
      const result = await api.post<HierarchyProposal>(
        `/startups/${startupId}/hierarchy/propose`,
        {}
      )
      setProposal(result)
      setEditedRoles(result.roles)
      setPhase("reviewing")
    } catch (e) {
      console.error("Proposal failed:", e)
      setPhase("chatting")
    }
  }

  function handleRemoveRole(index: number) {
    setEditedRoles((prev) => prev.filter((_, i) => i !== index))
  }

  async function handleApproveTeam() {
    if (!editedRoles.length) return
    setPhase("approving")
    try {
      await api.put(`/startups/${startupId}/hierarchy/approve`, {
        roles: editedRoles,
      })
      setPhase("approved")
      setTeamExists(true)
      // Reload chat history to get the persisted "Team assembled" message
      try {
        const history = await api.get<ChatMessage[]>(`/startups/${startupId}/chat/history`)
        setMessages(history)
      } catch {
        // Fallback: add a local message
        setMessages((prev) => [
          ...prev,
          {
            id: `sys-${Date.now()}`,
            role: "assistant",
            content: `**Team assembled!** I've onboarded ${editedRoles.length} new employees. Head to the **Employees** tab to see your team.`,
            created_at: new Date().toISOString(),
          },
        ])
      }
    } catch (e) {
      console.error("Approve failed:", e)
      setPhase("reviewing")
    }
  }

  const showBuildTeamButton = !teamExists && phase === "chatting" && messages.length >= 2 && !isStreaming

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">CEO Chat</h1>
          <p className="text-muted-foreground text-sm mt-1">
            {teamExists
              ? "Direct line to your AI CEO — delegate tasks and review progress"
              : "Discuss your idea with the CEO, then build your team"}
          </p>
        </div>
        {teamExists && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => router.push(`/startup/${startupId}/employees`)}
            className="gap-2"
          >
            <Users className="h-4 w-4" />
            View Team
          </Button>
        )}
      </div>

      <Card className="flex-1 flex flex-col overflow-hidden">
        <CardContent className="flex-1 flex flex-col p-0 overflow-hidden">
          <div className="flex-1 overflow-y-auto px-6 py-4" ref={scrollRef}>
            <div className="space-y-6 max-w-3xl mx-auto">
              {isLoading ? (
                <div className="flex items-center justify-center py-12 text-muted-foreground">
                  <Loader2 className="h-5 w-5 animate-spin mr-2" />
                  Loading conversation...
                </div>
              ) : messages.length === 0 ? (
                <div className="text-center py-12 text-muted-foreground">
                  <p className="text-lg font-medium">No messages yet</p>
                  <p className="text-sm mt-1">Create a startup first to start chatting with your CEO</p>
                </div>
              ) : (
                messages.map((msg) => (
                  <div key={msg.id} className={cn("flex gap-3", msg.role === "user" && "flex-row-reverse")}>
                    <Avatar className="h-8 w-8 shrink-0 mt-0.5">
                      <AvatarFallback className={cn(
                        "text-xs font-semibold",
                        msg.role === "assistant" ? "bg-primary text-primary-foreground" : "bg-muted"
                      )}>
                        {msg.role === "assistant" ? "CEO" : "You"}
                      </AvatarFallback>
                    </Avatar>
                    <div
                      className={cn(
                        "rounded-xl px-4 py-3 text-sm max-w-[75%]",
                        msg.role === "assistant"
                          ? "bg-muted text-foreground"
                          : "bg-primary text-primary-foreground"
                      )}
                    >
                      {msg.role === "assistant" ? (
                        <div className="prose prose-sm prose-neutral max-w-none leading-relaxed [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 [&_p]:my-2 [&_ul]:my-2 [&_ol]:my-2 [&_li]:my-0.5 [&_blockquote]:my-2 [&_blockquote]:border-l-2 [&_blockquote]:pl-3 [&_blockquote]:italic [&_code]:bg-background/50 [&_code]:px-1 [&_code]:rounded [&_h1]:text-base [&_h2]:text-sm [&_h3]:text-sm [&_h1]:font-bold [&_h2]:font-semibold [&_h3]:font-semibold [&_strong]:font-semibold">
                          <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.content}</ReactMarkdown>
                        </div>
                      ) : (
                        <p className="whitespace-pre-wrap leading-relaxed">{msg.content}</p>
                      )}
                      {msg.content && (
                        <p className={cn(
                          "text-[10px] mt-2 opacity-60",
                          msg.role === "assistant" ? "text-muted-foreground" : "text-primary-foreground"
                        )}>
                          {new Date(msg.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                        </p>
                      )}
                    </div>
                  </div>
                ))
              )}

              {/* ── Hierarchy Proposal Card ── */}
              {phase === "proposing" && (
                <div className="flex justify-center py-6">
                  <div className="flex items-center gap-3 text-muted-foreground">
                    <Loader2 className="h-5 w-5 animate-spin" />
                    <span className="text-sm">Analyzing your idea and proposing a team structure...</span>
                  </div>
                </div>
              )}

              {(phase === "reviewing" || phase === "approving") && proposal && (
                <div className="rounded-xl border-2 border-primary/20 bg-card p-5 space-y-4">
                  <div className="flex items-center gap-2">
                    <div className="h-8 w-8 rounded-lg bg-primary/10 flex items-center justify-center">
                      <Users className="h-4 w-4 text-primary" />
                    </div>
                    <div>
                      <h3 className="text-sm font-semibold">Proposed Team Structure</h3>
                      <p className="text-xs text-muted-foreground">Review and approve your startup&apos;s team</p>
                    </div>
                  </div>

                  {proposal.reasoning && (
                    <p className="text-xs text-muted-foreground bg-muted/50 rounded-lg px-3 py-2 italic">
                      {proposal.reasoning}
                    </p>
                  )}

                  {/* Org chart visualization */}
                  <div className="space-y-2">
                    {/* CEO (always present) */}
                    <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-primary/5 border border-primary/10">
                      <div className="h-6 w-6 rounded-full bg-primary flex items-center justify-center">
                        <Sparkles className="h-3 w-3 text-primary-foreground" />
                      </div>
                      <span className="text-sm font-medium">CEO</span>
                      <Badge variant="secondary" className="text-[10px] ml-auto">Level 0 · Already active</Badge>
                    </div>

                    {/* Proposed roles */}
                    {editedRoles.map((role, i) => (
                      <div key={i} className="flex items-center gap-2 px-3 py-2 rounded-lg border bg-background group">
                        <ChevronRight className="h-3 w-3 text-muted-foreground ml-2" />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-medium">{role.title}</span>
                            <Badge variant="outline" className="text-[10px]">Level {role.level}</Badge>
                            <ArrowRight className="h-3 w-3 text-muted-foreground" />
                            <span className="text-xs text-muted-foreground">{role.reports_to}</span>
                          </div>
                          <p className="text-xs text-muted-foreground mt-0.5 line-clamp-1">{role.responsibilities}</p>
                        </div>
                        {phase === "reviewing" && (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-6 w-6 opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
                            onClick={() => handleRemoveRole(i)}
                          >
                            <X className="h-3 w-3" />
                          </Button>
                        )}
                      </div>
                    ))}
                  </div>

                  {proposal.estimated_monthly_cost > 0 && (
                    <p className="text-xs text-muted-foreground">
                      Estimated monthly cost: <span className="font-medium">${proposal.estimated_monthly_cost.toFixed(0)}</span>
                    </p>
                  )}

                  {phase === "reviewing" && (
                    <div className="flex items-center gap-3 pt-2">
                      <Button onClick={handleApproveTeam} className="gap-2" disabled={editedRoles.length === 0}>
                        <Check className="h-4 w-4" />
                        Approve & Hire ({editedRoles.length} employees)
                      </Button>
                      <Button variant="outline" onClick={handleProposeTeam}>
                        Regenerate
                      </Button>
                      <Button variant="ghost" onClick={() => { setPhase("chatting"); setProposal(null) }}>
                        Cancel
                      </Button>
                    </div>
                  )}

                  {phase === "approving" && (
                    <div className="flex items-center gap-2 text-muted-foreground pt-2">
                      <Loader2 className="h-4 w-4 animate-spin" />
                      <span className="text-sm">Hiring team members...</span>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>

          <div className="border-t p-4">
            <div className="max-w-3xl mx-auto space-y-3">
              {/* Action bar — Build Team button */}
              {showBuildTeamButton && (
                <div className="flex items-center gap-2 px-1">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleProposeTeam}
                    className="gap-2 border-primary/30 text-primary hover:bg-primary/5"
                  >
                    <Users className="h-4 w-4" />
                    Build Team
                  </Button>
                  <span className="text-xs text-muted-foreground">
                    Ready to hire? Let AI propose the perfect team for your idea.
                  </span>
                </div>
              )}

              <div className="flex gap-3">
                <Textarea
                  placeholder={teamExists ? "Give your CEO a directive..." : "Discuss your idea with the CEO..."}
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  className="min-h-[2.5rem] max-h-[8rem] resize-none text-sm"
                  rows={1}
                  disabled={isStreaming || phase === "proposing" || phase === "approving"}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault()
                      handleSend()
                    }
                  }}
                />
                <Button
                  size="icon"
                  className="shrink-0 h-10 w-10"
                  disabled={isStreaming || !input.trim() || phase === "proposing" || phase === "approving"}
                  onClick={handleSend}
                >
                  {isStreaming ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Send className="h-4 w-4" />
                  )}
                </Button>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
