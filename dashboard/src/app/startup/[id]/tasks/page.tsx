"use client"

import { useEffect, useState } from "react"
import { useParams } from "next/navigation"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent } from "@/components/ui/card"
import { api } from "@/lib/api"
import { ListTodo } from "lucide-react"

interface Task {
  id: string
  title: string
  description: string | null
  status: string
  priority: string
  assigned_to_agent_id: string | null
  cost: number
}

const columns = [
  { key: "planned", label: "Backlog", color: "bg-muted" },
  { key: "in_progress", label: "In Progress", color: "bg-blue-500/10" },
  { key: "blocked", label: "Blocked", color: "bg-red-500/10" },
  { key: "completed", label: "Done", color: "bg-green-500/10" },
]

const priorityDot: Record<string, string> = {
  high: "bg-red-500",
  medium: "bg-amber-500",
  low: "bg-green-500",
  critical: "bg-purple-500",
}

export default function TasksPage() {
  const { id } = useParams<{ id: string }>()
  const [tasks, setTasks] = useState<Task[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    api.get<Task[]>(`/startups/${id}/tasks`).then(setTasks).finally(() => setLoading(false))
  }, [id])

  if (loading) return <div className="p-6 text-sm text-muted-foreground">Loading...</div>

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Tasks</h1>
        <p className="text-muted-foreground text-sm mt-1">
          Kanban view of all startup tasks
        </p>
      </div>

      {tasks.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-lg border border-dashed p-12 text-center">
          <ListTodo className="h-10 w-10 text-muted-foreground mb-3" />
          <p className="text-sm font-medium">No tasks yet</p>
          <p className="text-xs text-muted-foreground mt-1">Tasks will appear here as employees start working</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          {columns.map((col) => {
            const colTasks = tasks.filter((t) => t.status === col.key)
            return (
              <div key={col.key} className="space-y-3">
                <div className="flex items-center gap-2">
                  <h3 className="text-sm font-semibold">{col.label}</h3>
                  <Badge variant="secondary" className="text-xs">{colTasks.length}</Badge>
                </div>
                <div className="space-y-2">
                  {colTasks.map((task) => (
                    <Card key={task.id} className="cursor-pointer hover:border-primary/50 transition-colors">
                      <CardContent className="p-3">
                        <div className="flex items-start gap-2">
                          <div className={`h-2 w-2 rounded-full shrink-0 mt-1.5 ${priorityDot[task.priority] || "bg-gray-400"}`} />
                          <div>
                            <p className="text-sm font-medium leading-snug">{task.title}</p>
                            {task.assigned_to_agent_id && (
                              <p className="text-xs text-muted-foreground mt-1">{task.assigned_to_agent_id}</p>
                            )}
                          </div>
                        </div>
                      </CardContent>
                    </Card>
                  ))}
                  {colTasks.length === 0 && (
                    <div className="rounded-lg border border-dashed p-4 text-center text-xs text-muted-foreground">
                      No tasks
                    </div>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
