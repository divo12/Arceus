"use client"

import * as React from "react"
import Link from "next/link"
import { usePathname, useParams } from "next/navigation"
import {
  LayoutDashboard,
  Users,
  ListTodo,
  MessageSquare,
  Ticket,
  DollarSign,
  Settings,
  ChevronDown,
  Rocket,
  Moon,
  Sun,
  BotMessageSquare,
} from "lucide-react"
import { useTheme } from "next-themes"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarGroupContent,
} from "@/components/ui/sidebar"
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

export function AppSidebar() {
  const pathname = usePathname()
  const params = useParams()
  const startupId = params.id as string
  const { theme, setTheme } = useTheme()

  const [startups, setStartups] = React.useState<Startup[]>([])
  const current = startups.find((s) => s.id === startupId)

  React.useEffect(() => {
    api.get<Startup[]>("/startups").then(setStartups).catch(console.error)
  }, [])

  const navItems = [
    { title: "Overview", href: `/startup/${startupId}`, icon: LayoutDashboard },
    { title: "CEO Chat", href: `/startup/${startupId}/ceo`, icon: BotMessageSquare },
    { title: "Employees", href: `/startup/${startupId}/employees`, icon: Users },
    { title: "Tasks", href: `/startup/${startupId}/tasks`, icon: ListTodo },
    { title: "Meetings", href: `/startup/${startupId}/meetings`, icon: MessageSquare },
    { title: "Activity Log", href: `/startup/${startupId}/activity`, icon: Ticket },
    { title: "Budget", href: `/startup/${startupId}/budget`, icon: DollarSign },
    { title: "Settings", href: `/startup/${startupId}/settings`, icon: Settings },
  ]

  return (
    <Sidebar className="border-r">
      <SidebarHeader className="border-b px-2 py-3">
        <div className="flex items-center justify-between">
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button variant="ghost" className="w-full justify-start gap-2 px-2">
                  <Rocket className="h-4 w-4" />
                  <span className="font-semibold truncate">{current?.name ?? "Loading..."}</span>
                  <ChevronDown className="ml-auto h-4 w-4 shrink-0 opacity-50" />
                </Button>
              }
            />
            <DropdownMenuContent align="start" className="w-56">
              {startups.map((s) => (
                <DropdownMenuItem key={s.id} render={<Link href={`/startup/${s.id}`} />}>
                  <Rocket className="mr-2 h-4 w-4" />
                  {s.name}
                </DropdownMenuItem>
              ))}
              <DropdownMenuItem render={<Link href="/" />}>
                <Rocket className="mr-2 h-4 w-4 text-muted-foreground" />
                <span className="text-muted-foreground">New Startup...</span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </SidebarHeader>

      <SidebarContent className="flex-1">
        <SidebarGroup>
          <SidebarGroupLabel>Startup</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {navItems.map((item) => {
                const isActive =
                  item.href === `/startup/${startupId}`
                    ? pathname === item.href
                    : pathname.startsWith(item.href)
                return (
                  <SidebarMenuItem key={item.title}>
                    <SidebarMenuButton isActive={isActive} render={<Link href={item.href} />}>
                      <item.icon className="h-4 w-4" />
                      <span>{item.title}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                )
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter className="border-t p-2">
        <div className="flex items-center justify-between">
          <span className="text-xs text-muted-foreground px-2">Arceus</span>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
          >
            <Sun className="h-4 w-4 rotate-0 scale-100 transition-all dark:-rotate-90 dark:scale-0" />
            <Moon className="absolute h-4 w-4 rotate-90 scale-0 transition-all dark:rotate-0 dark:scale-100" />
            <span className="sr-only">Toggle theme</span>
          </Button>
        </div>
      </SidebarFooter>
    </Sidebar>
  )
}
