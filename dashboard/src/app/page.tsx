"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { Plus, Rocket, Loader2, Sparkles, DollarSign, ArrowRight } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
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

export default function Home() {
  const router = useRouter()
  const [startups, setStartups] = React.useState<Startup[]>([])
  const [loading, setLoading] = React.useState(true)
  const [creating, setCreating] = React.useState(false)
  const [open, setOpen] = React.useState(false)
  const [name, setName] = React.useState("")
  const [coreIdea, setCoreIdea] = React.useState("")
  const [budget, setBudget] = React.useState("500")

  React.useEffect(() => {
    api.get<Startup[]>("/startups").then(setStartups).catch(console.error).finally(() => setLoading(false))
  }, [])

  async function handleCreate() {
    if (!name.trim() || !coreIdea.trim()) return
    setCreating(true)
    try {
      const s = await api.post<Startup>("/startups", {
        name: name.trim(),
        core_idea: coreIdea.trim(),
        budget: parseFloat(budget) || 500,
      })
      setOpen(false)
      router.push(`/startup/${s.id}/ceo`)
    } catch (e) {
      console.error(e)
    } finally {
      setCreating(false)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    )
  }

  const dialogContent = (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create a Startup</DialogTitle>
          <DialogDescription>
            Describe your idea. Arceus will spawn a CEO agent to refine it with you.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div>
            <label className="text-sm font-medium mb-1.5 block">Name</label>
            <Input
              placeholder="e.g. FoodDash, PetPal, CodeShip..."
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div>
            <label className="text-sm font-medium mb-1.5 block">Core Idea</label>
            <Textarea
              placeholder="An AI-powered platform that..."
              rows={3}
              value={coreIdea}
              onChange={(e) => setCoreIdea(e.target.value)}
            />
          </div>
          <div>
            <label className="text-sm font-medium mb-1.5 block">Budget ($)</label>
            <Input
              type="number"
              value={budget}
              onChange={(e) => setBudget(e.target.value)}
            />
          </div>
        </div>
        <DialogFooter>
          <Button onClick={handleCreate} disabled={creating || !name.trim() || !coreIdea.trim()}>
            {creating ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Rocket className="h-4 w-4 mr-2" />}
            Launch Startup
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )

  return (
    <div className="min-h-screen bg-background w-full">
      {dialogContent}

      {startups.length === 0 ? (
        /* ── Empty state: centered hero ── */
        <div className="flex flex-col items-center justify-center min-h-screen px-6">
          <div className="h-16 w-16 rounded-2xl bg-primary flex items-center justify-center mb-8">
            <Sparkles className="h-8 w-8 text-primary-foreground" />
          </div>
          <h1 className="text-5xl font-bold tracking-tight text-center">Arceus</h1>
          <p className="text-lg text-muted-foreground text-center mt-4 mb-10 max-w-lg leading-relaxed">
            Your AI-powered founding team. Describe an idea and watch
            AI agents build it — from CEO to code.
          </p>
          <Button size="lg" onClick={() => setOpen(true)} className="gap-2 text-base px-8 py-6">
            <Plus className="h-5 w-5" />
            Create Your First Startup
          </Button>
          <div className="flex items-center gap-8 mt-16 text-sm text-muted-foreground">
            <span className="flex items-center gap-2"><Rocket className="h-4 w-4" /> AI CEO spawned instantly</span>
            <span className="flex items-center gap-2"><Sparkles className="h-4 w-4" /> Autonomous employee hiring</span>
            <span className="flex items-center gap-2"><DollarSign className="h-4 w-4" /> Real-time budget tracking</span>
          </div>
        </div>
      ) : (
        /* ── Has startups: list view ── */
        <div className="mx-auto max-w-3xl px-6 py-16">
          <div className="flex items-center justify-between mb-8">
            <div>
              <h1 className="text-2xl font-bold tracking-tight">Your Startups</h1>
              <p className="text-muted-foreground text-sm mt-0.5">{startups.length} startup{startups.length !== 1 ? "s" : ""} running</p>
            </div>
            <Button onClick={() => setOpen(true)} className="gap-2">
              <Plus className="h-4 w-4" />
              New Startup
            </Button>
          </div>

          <div className="space-y-3">
            {startups.map((s) => (
              <div
                key={s.id}
                className="group flex items-center gap-4 rounded-lg border p-4 cursor-pointer transition-all hover:bg-muted/50 hover:border-foreground/20"
                onClick={() => router.push(`/startup/${s.id}`)}
              >
                <div className="h-10 w-10 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
                  <Rocket className="h-5 w-5 text-primary" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <h3 className="text-sm font-semibold">{s.name}</h3>
                    <Badge variant="secondary" className="text-xs capitalize">{s.status}</Badge>
                  </div>
                  <p className="text-sm text-muted-foreground line-clamp-1 mt-0.5">{s.core_idea}</p>
                </div>
                <div className="text-right shrink-0">
                  <p className="text-sm font-medium">${s.budget_spent.toFixed(0)} <span className="text-muted-foreground font-normal">/ ${s.budget_allocated.toFixed(0)}</span></p>
                </div>
                <ArrowRight className="h-4 w-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity shrink-0" />
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
