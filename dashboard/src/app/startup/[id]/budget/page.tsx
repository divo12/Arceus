"use client"

import { useEffect, useState } from "react"
import { useParams } from "next/navigation"
import { DollarSign, TrendingUp, TrendingDown } from "lucide-react"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Progress } from "@/components/ui/progress"
import { api } from "@/lib/api"

interface BudgetData {
  startup_id: string
  allocated: number
  spent: number
  remaining: number
}

interface BreakdownData {
  by_agent: { name: string; cost: number; calls: number; tokens: string }[]
  by_model: unknown[]
  by_task: unknown[]
}

export default function BudgetPage() {
  const { id } = useParams<{ id: string }>()
  const [budget, setBudget] = useState<BudgetData | null>(null)
  const [breakdown, setBreakdown] = useState<BreakdownData | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    Promise.all([
      api.get<BudgetData>(`/startups/${id}/budget`),
      api.get<BreakdownData>(`/startups/${id}/budget/breakdown`),
    ])
      .then(([b, br]) => {
        setBudget(b)
        setBreakdown(br)
      })
      .finally(() => setLoading(false))
  }, [id])

  if (loading) return <div className="p-6 text-sm text-muted-foreground">Loading...</div>
  if (!budget) return <div className="p-6 text-sm text-muted-foreground">Budget data unavailable</div>

  const pct = budget.allocated > 0 ? (budget.spent / budget.allocated) * 100 : 0

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Budget</h1>
        <p className="text-muted-foreground text-sm mt-1">
          Token usage, API costs, and per-agent spend breakdown
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">Total Spent</CardTitle>
            <DollarSign className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">${budget.spent.toFixed(2)}</div>
            <p className="text-xs text-muted-foreground mt-1">of ${budget.allocated.toFixed(0)} allocated</p>
            <Progress value={pct} className="mt-2 h-1.5" />
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">Remaining</CardTitle>
            <TrendingDown className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">${budget.remaining.toFixed(2)}</div>
            <p className="text-xs text-muted-foreground mt-1">{(100 - pct).toFixed(1)}% of budget remaining</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">Budget Used</CardTitle>
            <TrendingUp className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{pct.toFixed(1)}%</div>
            <p className="text-xs text-muted-foreground mt-1">of total allocation</p>
          </CardContent>
        </Card>
      </div>

      {breakdown && breakdown.by_agent.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Cost by Employee</CardTitle>
            <CardDescription>Breakdown of spend per employee</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {breakdown.by_agent.map((agent) => {
                const agentPct = budget.spent > 0 ? (agent.cost / budget.spent) * 100 : 0
                return (
                  <div key={agent.name} className="space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-medium">{agent.name}</span>
                      <span className="text-sm font-bold">${agent.cost.toFixed(2)}</span>
                    </div>
                    <div className="flex items-center gap-4">
                      <Progress value={agentPct} className="flex-1 h-1.5" />
                      <span className="text-xs text-muted-foreground w-16 text-right">{agentPct.toFixed(1)}%</span>
                    </div>
                  </div>
                )
              })}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
