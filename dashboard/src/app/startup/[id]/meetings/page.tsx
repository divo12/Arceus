"use client"

import { useEffect, useState } from "react"
import { useParams } from "next/navigation"
import { MessageSquare, Users } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent } from "@/components/ui/card"
import { api } from "@/lib/api"

interface Meeting {
  id: string
  type: string
  participants: string[]
  scheduledAt: string
  decisions: string[]
  learnings: string[]
  status: string
}

const typeBadge: Record<string, React.ReactNode> = {
  STANDUP: <Badge className="bg-purple-500/10 text-purple-500 border-purple-500/20 hover:bg-purple-500/10 text-xs">Standup</Badge>,
  ESCALATION: <Badge className="bg-amber-500/10 text-amber-500 border-amber-500/20 hover:bg-amber-500/10 text-xs">Escalation</Badge>,
  SYNC: <Badge className="bg-blue-500/10 text-blue-500 border-blue-500/20 hover:bg-blue-500/10 text-xs">Sync</Badge>,
}

export default function MeetingsPage() {
  const { id } = useParams<{ id: string }>()
  const [meetings, setMeetings] = useState<Meeting[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    api.get<Meeting[]>(`/startups/${id}/meetings`).then(setMeetings).finally(() => setLoading(false))
  }, [id])

  if (loading) return <div className="p-6 text-sm text-muted-foreground">Loading...</div>

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Meetings</h1>
        <p className="text-muted-foreground text-sm mt-1">
          Timeline of all standups, escalations, and sync meetings
        </p>
      </div>

      {meetings.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-lg border border-dashed p-12 text-center">
          <MessageSquare className="h-10 w-10 text-muted-foreground mb-3" />
          <p className="text-sm font-medium">No meetings yet</p>
          <p className="text-xs text-muted-foreground mt-1">Meetings will appear here as employees start collaborating</p>
        </div>
      ) : (
        <div className="relative space-y-0">
          <div className="absolute left-[19px] top-3 bottom-3 w-px bg-border" />

          {meetings.map((meeting) => (
            <div key={meeting.id} className="relative flex gap-4 pb-6">
              <div className="relative z-10 flex h-10 w-10 shrink-0 items-center justify-center rounded-full border bg-background">
                <MessageSquare className="h-4 w-4 text-muted-foreground" />
              </div>
              <Card className="flex-1">
                <CardContent className="p-4">
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <div className="flex items-center gap-2">
                      {typeBadge[meeting.type] || <Badge variant="outline" className="text-xs">{meeting.type}</Badge>}
                      <span className="text-xs text-muted-foreground">
                        {new Date(meeting.scheduledAt).toLocaleDateString()} at{" "}
                        {new Date(meeting.scheduledAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                      </span>
                    </div>
                    <Badge variant={meeting.status === "completed" ? "secondary" : "outline"} className="text-xs">
                      {meeting.status}
                    </Badge>
                  </div>

                  {meeting.participants.length > 0 && (
                    <div className="flex items-center gap-1 mt-2">
                      <Users className="h-3 w-3 text-muted-foreground" />
                      <span className="text-xs text-muted-foreground">{meeting.participants.join(", ")}</span>
                    </div>
                  )}

                  {meeting.decisions.length > 0 && (
                    <div className="mt-3">
                      <p className="text-xs font-medium text-muted-foreground mb-1">Decisions</p>
                      <ul className="space-y-1">
                        {meeting.decisions.map((d, i) => (
                          <li key={i} className="text-sm flex items-start gap-2">
                            <span className="text-green-500 mt-0.5">•</span>
                            {d}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {meeting.learnings.length > 0 && (
                    <div className="mt-2">
                      <p className="text-xs font-medium text-muted-foreground mb-1">Learnings</p>
                      <ul className="space-y-1">
                        {meeting.learnings.map((l, i) => (
                          <li key={i} className="text-sm flex items-start gap-2">
                            <span className="text-blue-500 mt-0.5">•</span>
                            {l}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
