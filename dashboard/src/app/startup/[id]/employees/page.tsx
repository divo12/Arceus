"use client"

import { useEffect, useState } from "react"
import { useParams } from "next/navigation"
import { api } from "@/lib/api"
import { Users } from "lucide-react"

interface Agent {
  id: string
  name: string
  role: string
  agent_type: string
  status: string
  level: number
  total_tasks_completed: number
  total_cost: number
}

export default function EmployeesPage() {
  const { id } = useParams<{ id: string }>()
  const [agents, setAgents] = useState<Agent[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    api.get<Agent[]>(`/startups/${id}/agents`).then(setAgents).finally(() => setLoading(false))
  }, [id])

  if (loading) return <div className="p-6 text-sm text-muted-foreground">Loading...</div>

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Employees</h1>
        <p className="text-muted-foreground text-sm mt-1">
          Your AI workforce and their current status
        </p>
      </div>

      {agents.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-lg border border-dashed p-12 text-center">
          <Users className="h-10 w-10 text-muted-foreground mb-3" />
          <p className="text-sm font-medium">No employees yet</p>
          <p className="text-xs text-muted-foreground mt-1">The CEO will hire employees as the startup grows</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {agents.map((agent) => (
            <div
              key={agent.id}
              className="flex items-center gap-4 rounded-lg border p-4 transition-colors hover:bg-muted/50 cursor-pointer"
            >
              <div className="relative">
                <div className="h-10 w-10 rounded-full bg-muted flex items-center justify-center text-sm font-semibold">
                  {agent.role.charAt(0).toUpperCase()}
                </div>
                <div
                  className={`absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-background ${
                    agent.status === "running" ? "bg-green-500" : agent.status === "idle" ? "bg-yellow-500" : "bg-red-500"
                  }`}
                />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium">{agent.name}</p>
                <p className="text-xs text-muted-foreground">{agent.role} · Level {agent.level}</p>
              </div>
              <div className="text-right">
                <p className="text-sm font-medium">{agent.total_tasks_completed} tasks</p>
                <p className="text-xs text-muted-foreground">${agent.total_cost.toFixed(2)}</p>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
