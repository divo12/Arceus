"use client"

import * as React from "react"
import { useParams } from "next/navigation"
import {
  Users,
  ListTodo,
  DollarSign,
  AlertCircle,
  Loader2,
  Play,
  Pause,
  Archive,
} from "lucide-react"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Progress } from "@/components/ui/progress"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { api } from "@/lib/api"

interface Startup {
  id: string
  name: string
  status: string
  core_idea: string
  current_direction: string
  budget_allocated: number
  budget_spent: number
}

interface Overview {
  startup_id: string
  employees_total: number
  employees_running: number
  tasks_open: number
  tasks_completed: number
  budget_spent: number
  budget_allocated: number
  pending_approvals: number
}

export default function OverviewPage() {
  const params = useParams()
  const startupId = params.id as string
  const [startup, setStartup] = React.useState<Startup | null>(null)
  const [overview, setOverview] = React.useState<Overview | null>(null)
  const [loading, setLoading] = React.useState(true)

  React.useEffect(() => {
    Promise.all([
      api.get<Startup>(`/startups/${startupId}`),
      api.get<Overview>(`/startups/${startupId}/overview`),
    ]).then(([s, o]) => {
      setStartup(s)
      setOverview(o)
    }).catch(console.error).finally(() => setLoading(false))
  }, [startupId])

  if (loading || !startup || !overview) {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  const budgetPct = overview.budget_allocated > 0
    ? Math.round((overview.budget_spent / overview.budget_allocated) * 100)
    : 0

  async function handleStatusChange(newStatus: string) {
    try {
      const updated = await api.patch<Startup>(`/startups/${startupId}/status`, { status: newStatus })
      setStartup(updated)
    } catch (e) {
      console.error("Failed to update status:", e)
    }
  }

  const isActive = startup.status === "active"
  const isPaused = startup.status === "paused"

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold tracking-tight">Overview</h1>
            <Badge variant={isActive ? "default" : isPaused ? "secondary" : "outline"} className="text-xs">
              {startup.status}
            </Badge>
          </div>
          <p className="text-muted-foreground text-sm mt-1">
            {startup.current_direction}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {isActive ? (
            <Button variant="outline" size="sm" className="gap-2" onClick={() => handleStatusChange("paused")}>
              <Pause className="h-4 w-4" />
              Pause Company
            </Button>
          ) : isPaused ? (
            <Button size="sm" className="gap-2" onClick={() => handleStatusChange("active")}>
              <Play className="h-4 w-4" />
              Start Company
            </Button>
          ) : null}
          {(isActive || isPaused) && (
            <Button variant="ghost" size="sm" className="gap-2 text-muted-foreground" onClick={() => handleStatusChange("archived")}>
              <Archive className="h-4 w-4" />
              Archive
            </Button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">Employees</CardTitle>
            <Users className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{overview.employees_total}</div>
            <p className="text-xs text-green-500 mt-1">{overview.employees_running} running</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">Tasks</CardTitle>
            <ListTodo className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{overview.tasks_open + overview.tasks_completed}</div>
            <div className="flex gap-2 mt-1">
              <span className="text-xs text-blue-500">{overview.tasks_open} open</span>
              <span className="text-xs text-green-500">{overview.tasks_completed} done</span>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">Budget</CardTitle>
            <DollarSign className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              ${overview.budget_spent.toFixed(0)}
              <span className="text-sm font-normal text-muted-foreground">
                /${overview.budget_allocated.toFixed(0)}
              </span>
            </div>
            <Progress value={budgetPct} className="mt-2 h-1.5" />
            <p className="text-xs text-muted-foreground mt-1">{budgetPct}% used</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">Approvals</CardTitle>
            <AlertCircle className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{overview.pending_approvals}</div>
            <p className="text-xs text-amber-500 mt-1">
              {overview.pending_approvals > 0 ? "Action required" : "All clear"}
            </p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Core Idea</CardTitle>
          <CardDescription>Immutable foundation</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm">{startup.core_idea}</p>
        </CardContent>
      </Card>
    </div>
  )
}
