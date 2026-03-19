"use client"

import { useEffect, useState } from "react"
import { useParams } from "next/navigation"
import {
  CheckCircle2,
  MessageSquare,
  AlertCircle,
  Zap,
  Wrench,
  Activity,
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import { api } from "@/lib/api"

interface Ticket {
  id: string
  timestamp: string
  employee: string
  type: string
  title: string
  content: string
}

const typeIcon: Record<string, React.ReactNode> = {
  task_completed: <CheckCircle2 className="h-4 w-4 text-green-500" />,
  tool_call: <Wrench className="h-4 w-4 text-blue-500" />,
  meeting: <MessageSquare className="h-4 w-4 text-purple-500" />,
  approval: <AlertCircle className="h-4 w-4 text-amber-500" />,
  decision: <Zap className="h-4 w-4 text-cyan-500" />,
}

export default function ActivityPage() {
  const { id } = useParams<{ id: string }>()
  const [tickets, setTickets] = useState<Ticket[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    api.get<{ items: Ticket[] }>(`/startups/${id}/tickets`)
      .then((res) => setTickets(res.items))
      .finally(() => setLoading(false))
  }, [id])

  if (loading) return <div className="p-6 text-sm text-muted-foreground">Loading...</div>

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Activity Log</h1>
        <p className="text-muted-foreground text-sm mt-1">
          Immutable activity stream of all employee actions and decisions
        </p>
      </div>

      {tickets.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-lg border border-dashed p-12 text-center">
          <Activity className="h-10 w-10 text-muted-foreground mb-3" />
          <p className="text-sm font-medium">No activity yet</p>
          <p className="text-xs text-muted-foreground mt-1">Activity will stream in as employees take actions</p>
        </div>
      ) : (
        <div className="space-y-0">
          {tickets.map((ticket, i) => (
            <div key={ticket.id}>
              <div className="flex gap-4 py-4">
                <div className="mt-0.5 shrink-0">{typeIcon[ticket.type] || <Zap className="h-4 w-4 text-muted-foreground" />}</div>
                <div className="flex-1 min-w-0 space-y-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <p className="text-sm font-medium">{ticket.title}</p>
                    <Badge variant="outline" className="text-xs py-0 h-5">{ticket.employee}</Badge>
                  </div>
                  <p className="text-sm text-muted-foreground leading-relaxed">{ticket.content}</p>
                  <p className="text-xs text-muted-foreground">
                    {new Date(ticket.timestamp).toLocaleDateString()} at{" "}
                    {new Date(ticket.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                  </p>
                </div>
              </div>
              {i < tickets.length - 1 && <Separator />}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
