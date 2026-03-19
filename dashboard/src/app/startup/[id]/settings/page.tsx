"use client"

import { useEffect, useState } from "react"
import { useParams } from "next/navigation"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
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

export default function SettingsPage() {
  const { id } = useParams<{ id: string }>()
  const [startup, setStartup] = useState<Startup | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    api.get<Startup>(`/startups/${id}`).then(setStartup).finally(() => setLoading(false))
  }, [id])

  if (loading) return <div className="p-6 text-sm text-muted-foreground">Loading...</div>
  if (!startup) return <div className="p-6 text-sm text-muted-foreground">Startup not found</div>

  return (
    <div className="space-y-6 max-w-2xl">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Settings</h1>
        <p className="text-muted-foreground text-sm mt-1">
          Manage your startup configuration
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Startup Info</CardTitle>
          <CardDescription>Basic startup details</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <label className="text-sm font-medium">Name</label>
            <Input defaultValue={startup.name} />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium">Core Idea</label>
            <Input defaultValue={startup.core_idea} disabled />
            <p className="text-xs text-muted-foreground">Core idea is immutable once set</p>
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium">Current Direction</label>
            <Input defaultValue={startup.current_direction} />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium">Status</label>
            <div>
              <Badge variant="secondary">{startup.status}</Badge>
            </div>
          </div>
          <Button>Save Changes</Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Budget</CardTitle>
          <CardDescription>Startup budget allocation</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex justify-between text-sm">
            <span className="text-muted-foreground">Allocated</span>
            <span className="font-medium">${startup.budget_allocated.toFixed(2)}</span>
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-muted-foreground">Spent</span>
            <span className="font-medium">${startup.budget_spent.toFixed(2)}</span>
          </div>
          <Separator />
          <div className="flex justify-between text-sm">
            <span className="text-muted-foreground">Remaining</span>
            <span className="font-bold">${(startup.budget_allocated - startup.budget_spent).toFixed(2)}</span>
          </div>
        </CardContent>
      </Card>

      <Card className="border-destructive/50">
        <CardHeader>
          <CardTitle className="text-base text-destructive">Danger Zone</CardTitle>
          <CardDescription>Irreversible actions</CardDescription>
        </CardHeader>
        <CardContent>
          <Button variant="destructive">Archive Startup</Button>
        </CardContent>
      </Card>
    </div>
  )
}
