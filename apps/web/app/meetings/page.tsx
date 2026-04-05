"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Building2, CalendarDays, CheckCircle2, Clock3, GitBranch, Lightbulb, MessageSquareQuote, Users } from "lucide-react";
import type { CompanySnapshot } from "@arceus/contracts";
import { Badge } from "../../components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../components/ui/card";

const API_BASE = "/backend/api";

export default function MeetingsPage() {
  const [snapshot, setSnapshot] = useState<CompanySnapshot | null>(null);
  const [selectedMeetingId, setSelectedMeetingId] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      try {
        const response = await fetch(`${API_BASE}/company`, { cache: "no-store" });
        if (response.ok) {
          setSnapshot((await response.json()) as CompanySnapshot);
        }
      } catch {
        /* ignore */
      }
    }

    void load();
    const interval = setInterval(() => void load(), 1500);
    return () => clearInterval(interval);
  }, []);

  const agentsById = new Map((snapshot?.agents ?? []).map((agent) => [agent.id, agent]));
  const meetings = snapshot?.meetings ?? [];
  const approvals = snapshot?.approvals ?? [];
  const pendingApprovals = approvals.filter((approval) => approval.status === "pending");
  const resolvedApprovals = approvals.filter((approval) => ["approved", "applied", "rejected"].includes(approval.status));
  const selectedMeeting = meetings.find((meeting) => meeting.id === selectedMeetingId) ?? meetings[0] ?? null;
  const selectedMeetingApprovals = selectedMeeting ? approvals.filter((approval) => approval.meetingId === selectedMeeting.id) : [];

  useEffect(() => {
    if (!selectedMeetingId && meetings[0]) {
      setSelectedMeetingId(meetings[0].id);
      return;
    }

    if (selectedMeetingId && !meetings.some((meeting) => meeting.id === selectedMeetingId)) {
      setSelectedMeetingId(meetings[0]?.id ?? null);
    }
  }, [meetings, selectedMeetingId]);

  return (
    <main className="min-h-screen bg-slate-50 px-4 py-4 md:px-8">
      <div className="mx-auto max-w-[1400px] space-y-4">
        <div className="flex items-center justify-between gap-4 rounded-xl border border-slate-200 bg-white px-4 py-3">
          <div className="space-y-0.5">
            <div className="flex items-center gap-2 text-sm font-medium text-slate-500">
              <Building2 className="h-4 w-4" />
              Arceus board workspace
            </div>
            <div className="flex items-center gap-2 text-lg font-semibold text-slate-900">
              <CalendarDays className="h-5 w-5" />
              Meetings
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Link href="/" className="rounded-md border border-slate-200 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50">Board</Link>
            <Link href="/tasks" className="rounded-md border border-slate-200 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50">Tasks</Link>
            <Link href="/activity" className="rounded-md border border-slate-200 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50">Activity</Link>
            <Link href="/employees" className="rounded-md border border-slate-200 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50">Employees</Link>
            <Link href="/workspace" className="rounded-md border border-slate-200 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50">Workspace</Link>
          </div>
        </div>

        <Card className="overflow-hidden border-slate-200 bg-gradient-to-br from-white via-amber-50/50 to-rose-50/40">
          <CardContent className="flex flex-col gap-4 p-5 lg:flex-row lg:items-end lg:justify-between">
            <div className="space-y-2">
              <div className="inline-flex items-center gap-2 rounded-full border border-amber-200 bg-white/80 px-3 py-1 text-xs font-medium text-amber-800">
                <CalendarDays className="h-3.5 w-3.5" />
                Company meeting flow
              </div>
              <div className="text-2xl font-semibold text-slate-900">Meetings are the official handoff surface.</div>
              <p className="max-w-2xl text-sm leading-6 text-slate-600">Scrum, handoff, escalation, and ad-hoc meetings form the communication chain across the company. Select any meeting on the left to inspect agenda, decisions, and memory updates.</p>
            </div>
            <div className="grid grid-cols-3 gap-2 text-xs sm:w-[340px]">
              <div className="rounded-xl border border-white/70 bg-white/80 p-3">
                <div className="text-slate-500">Meetings</div>
                <div className="mt-1 text-xl font-semibold text-slate-900">{meetings.length}</div>
              </div>
              <div className="rounded-xl border border-white/70 bg-white/80 p-3">
                <div className="text-slate-500">Escalations</div>
                <div className="mt-1 text-xl font-semibold text-slate-900">{meetings.filter((meeting) => meeting.type === "escalation").length}</div>
              </div>
              <div className="rounded-xl border border-white/70 bg-white/80 p-3">
                <div className="text-slate-500">Handoffs</div>
                <div className="mt-1 text-xl font-semibold text-slate-900">{meetings.filter((meeting) => meeting.type === "handoff").length}</div>
              </div>
              <div className="rounded-xl border border-white/70 bg-white/80 p-3">
                <div className="text-slate-500">Pending approvals</div>
                <div className="mt-1 text-xl font-semibold text-slate-900">{pendingApprovals.length}</div>
              </div>
            </div>
          </CardContent>
        </Card>

        <div className="grid gap-4 xl:grid-cols-[340px_minmax(0,1fr)]">
          <Card className="border-slate-200">
            <CardHeader>
              <CardTitle className="text-base">Timeline rail</CardTitle>
              <CardDescription>Chronological flow of company meetings.</CardDescription>
            </CardHeader>
            <CardContent>
              {meetings.length === 0 ? (
                <p className="text-sm text-slate-500">No meetings recorded yet.</p>
              ) : (
                <div className="relative space-y-3 before:absolute before:bottom-0 before:left-[14px] before:top-0 before:w-px before:bg-slate-200">
                  {meetings.map((meeting) => {
                    const selected = meeting.id === selectedMeeting?.id;
                    return (
                      <button
                        key={meeting.id}
                        type="button"
                        onClick={() => setSelectedMeetingId(meeting.id)}
                        className={`relative flex w-full items-start gap-3 rounded-2xl border p-3 text-left transition ${selected ? "border-slate-900 bg-slate-900 text-white shadow-lg shadow-slate-900/10" : "border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50"}`}
                      >
                        <div className={`relative z-10 mt-1 h-7 w-7 rounded-full border-4 ${selected ? "border-slate-900 bg-amber-300" : "border-slate-50 bg-slate-300"}`} />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center justify-between gap-2">
                            <div className={`text-sm font-semibold capitalize ${selected ? "text-white" : "text-slate-900"}`}>{meeting.type.replace(/_/g, " ")}</div>
                            <Badge variant={selected ? "secondary" : "outline"} className="text-[10px]">{meeting.participants.length} people</Badge>
                          </div>
                          <div className={`mt-1 text-[11px] uppercase tracking-[0.14em] ${selected ? "text-slate-300" : "text-slate-500"}`}>{new Date(meeting.completedAt ?? meeting.scheduledAt).toLocaleString()}</div>
                          <div className={`mt-2 line-clamp-2 text-xs leading-5 ${selected ? "text-slate-200" : "text-slate-600"}`}>{meeting.summary}</div>
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>

          <Card className="border-slate-200">
            <CardHeader>
              {selectedMeeting ? (
                <>
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <CardTitle className="text-xl capitalize">{selectedMeeting.type.replace(/_/g, " ")}</CardTitle>
                      <CardDescription className="mt-1 max-w-3xl text-sm leading-6">{selectedMeeting.summary}</CardDescription>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Badge variant="outline">{selectedMeeting.status}</Badge>
                      <Badge variant="outline">{new Date(selectedMeeting.completedAt ?? selectedMeeting.scheduledAt).toLocaleString()}</Badge>
                    </div>
                  </div>
                  <div className="mt-4 flex flex-wrap gap-2">
                    {selectedMeeting.participants.map((participantId) => {
                      const participant = agentsById.get(participantId);
                      return (
                        <Badge key={participantId} variant="secondary" className="rounded-full px-3 py-1">
                          {participant?.name ?? participantId} · {participant?.title ?? "employee"}
                        </Badge>
                      );
                    })}
                  </div>
                </>
              ) : (
                <>
                  <CardTitle>No meeting selected</CardTitle>
                  <CardDescription>Select a meeting from the rail to inspect it.</CardDescription>
                </>
              )}
            </CardHeader>
            <CardContent>
              {selectedMeeting ? (
                <div className="space-y-6">
                  <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-4">
                    <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                      <div className="flex items-center gap-2 text-sm font-medium text-slate-700"><Users className="h-4 w-4" /> Participants</div>
                      <div className="mt-2 text-2xl font-semibold text-slate-900">{selectedMeeting.participants.length}</div>
                    </div>
                    <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                      <div className="flex items-center gap-2 text-sm font-medium text-slate-700"><MessageSquareQuote className="h-4 w-4" /> Agenda</div>
                      <div className="mt-2 text-2xl font-semibold text-slate-900">{selectedMeeting.agenda.length}</div>
                    </div>
                    <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                      <div className="flex items-center gap-2 text-sm font-medium text-slate-700"><CheckCircle2 className="h-4 w-4" /> Decisions</div>
                      <div className="mt-2 text-2xl font-semibold text-slate-900">{selectedMeeting.decisions.length}</div>
                    </div>
                    <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                      <div className="flex items-center gap-2 text-sm font-medium text-slate-700"><Lightbulb className="h-4 w-4" /> Learnings</div>
                      <div className="mt-2 text-2xl font-semibold text-slate-900">{selectedMeeting.learnings.length}</div>
                    </div>
                    <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                      <div className="flex items-center gap-2 text-sm font-medium text-slate-700"><GitBranch className="h-4 w-4" /> Mutations</div>
                      <div className="mt-2 text-2xl font-semibold text-slate-900">{selectedMeeting.taskModifications.length + selectedMeeting.memoryModifications.length}</div>
                    </div>
                    <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                      <div className="flex items-center gap-2 text-sm font-medium text-slate-700"><CheckCircle2 className="h-4 w-4" /> Linked approvals</div>
                      <div className="mt-2 text-2xl font-semibold text-slate-900">{selectedMeetingApprovals.length}</div>
                    </div>
                  </div>

                  <div className="relative space-y-5 before:absolute before:bottom-0 before:left-4 before:top-0 before:w-px before:bg-slate-200">
                    <div className="relative pl-12">
                      <div className="absolute left-0 top-1 flex h-8 w-8 items-center justify-center rounded-full bg-slate-900 text-white"><Clock3 className="h-4 w-4" /></div>
                      <div className="rounded-2xl border border-slate-200 p-4">
                        <div className="text-sm font-semibold text-slate-900">Agenda flow</div>
                        <div className="mt-3 space-y-3">
                          {selectedMeeting.agenda.map((item) => (
                            <div key={item.id} className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                              <div className="flex flex-wrap items-center gap-2">
                                <div className="font-medium text-slate-900">{item.topic}</div>
                                <Badge variant="outline">{item.type}</Badge>
                                {item.needsBoardApproval ? <Badge variant="warning">board approval</Badge> : null}
                              </div>
                              <div className="mt-2 text-sm leading-6 text-slate-700">{item.content}</div>
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>

                    <div className="relative pl-12">
                      <div className="absolute left-0 top-1 flex h-8 w-8 items-center justify-center rounded-full bg-emerald-600 text-white"><CheckCircle2 className="h-4 w-4" /></div>
                      <div className="rounded-2xl border border-slate-200 p-4">
                        <div className="text-sm font-semibold text-slate-900">Decisions made</div>
                        <div className="mt-3 space-y-3">
                          {selectedMeeting.decisions.length === 0 ? (
                            <div className="rounded-xl border border-dashed border-slate-200 p-3 text-sm text-slate-500">No explicit decisions were recorded in this meeting.</div>
                          ) : (
                            selectedMeeting.decisions.map((decision) => (
                              <div key={decision.id} className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-sm leading-6 text-slate-700">{decision.description}</div>
                            ))
                          )}
                        </div>
                      </div>
                    </div>

                    <div className="relative pl-12">
                      <div className="absolute left-0 top-1 flex h-8 w-8 items-center justify-center rounded-full bg-amber-500 text-white"><Lightbulb className="h-4 w-4" /></div>
                      <div className="rounded-2xl border border-slate-200 p-4">
                        <div className="text-sm font-semibold text-slate-900">Learnings and memory updates</div>
                        <div className="mt-3 space-y-3">
                          {selectedMeeting.learnings.length === 0 ? (
                            <div className="rounded-xl border border-dashed border-slate-200 p-3 text-sm text-slate-500">No learnings were promoted into employee memory here.</div>
                          ) : (
                            selectedMeeting.learnings.map((learning) => {
                              const agent = agentsById.get(learning.agentId);
                              return (
                                <div key={learning.id} className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                                  <div className="text-sm font-medium text-slate-900">{agent?.name ?? learning.agentId}</div>
                                  <div className="mt-1 text-sm leading-6 text-slate-700">{learning.content}</div>
                                </div>
                              );
                            })
                          )}
                        </div>
                      </div>
                    </div>

                    <div className="relative pl-12">
                      <div className="absolute left-0 top-1 flex h-8 w-8 items-center justify-center rounded-full bg-sky-600 text-white"><Users className="h-4 w-4" /></div>
                      <div className="rounded-2xl border border-slate-200 p-4">
                        <div className="text-sm font-semibold text-slate-900">Memory mutations applied</div>
                        <div className="mt-3 space-y-3">
                          {selectedMeeting.memoryModifications.length === 0 ? (
                            <div className="rounded-xl border border-dashed border-slate-200 p-3 text-sm text-slate-500">This meeting did not apply any explicit memory changes.</div>
                          ) : (
                            selectedMeeting.memoryModifications.map((modification) => {
                              const agent = agentsById.get(modification.agentId);
                              return (
                                <div key={modification.id} className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                                  <div className="flex flex-wrap items-center gap-2">
                                    <Badge variant="outline">{modification.modificationType.replace(/_/g, " ")}</Badge>
                                    <span className="text-xs uppercase tracking-[0.14em] text-slate-500">{agent?.name ?? modification.agentId}</span>
                                  </div>
                                  <div className="mt-2 text-sm leading-6 text-slate-700">{modification.content}</div>
                                </div>
                              );
                            })
                          )}
                        </div>
                      </div>
                    </div>

                    <div className="relative pl-12">
                      <div className="absolute left-0 top-1 flex h-8 w-8 items-center justify-center rounded-full bg-violet-600 text-white"><GitBranch className="h-4 w-4" /></div>
                      <div className="rounded-2xl border border-slate-200 p-4">
                        <div className="text-sm font-semibold text-slate-900">Task changes</div>
                        <div className="mt-3 space-y-3">
                          {selectedMeeting.taskModifications.length === 0 ? (
                            <div className="rounded-xl border border-dashed border-slate-200 p-3 text-sm text-slate-500">This meeting did not directly modify tasks.</div>
                          ) : (
                            selectedMeeting.taskModifications.map((modification) => (
                              <div key={modification.id} className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                                <div className="flex flex-wrap items-center gap-2">
                                  <Badge variant="outline">{modification.modificationType.replace(/_/g, " ")}</Badge>
                                  <span className="text-xs uppercase tracking-[0.14em] text-slate-500">task {modification.taskId.slice(-6)}</span>
                                  {modification.assignedRole ? <Badge variant="outline">{modification.assignedRole}</Badge> : null}
                                  {modification.priority ? <Badge variant="outline">{modification.priority}</Badge> : null}
                                  {modification.resultingStatus ? <Badge variant="outline">{modification.resultingStatus.replace(/_/g, " ")}</Badge> : null}
                                </div>
                                <div className="mt-2 text-sm leading-6 text-slate-700">{modification.details}</div>
                              </div>
                            ))
                          )}
                        </div>
                      </div>
                    </div>

                    <div className="relative pl-12">
                      <div className="absolute left-0 top-1 flex h-8 w-8 items-center justify-center rounded-full bg-amber-600 text-white"><CheckCircle2 className="h-4 w-4" /></div>
                      <div className="rounded-2xl border border-slate-200 p-4">
                        <div className="text-sm font-semibold text-slate-900">Approval requests</div>
                        <div className="mt-3 space-y-3">
                          {selectedMeetingApprovals.length === 0 ? (
                            <div className="rounded-xl border border-dashed border-slate-200 p-3 text-sm text-slate-500">No approval requests were linked to this meeting.</div>
                          ) : (
                            selectedMeetingApprovals.map((approval) => {
                              const requester = agentsById.get(approval.requestedByAgentId);
                              return (
                                <div key={approval.id} className={`rounded-xl border p-3 ${approval.status === "pending" ? "border-amber-200 bg-amber-50" : "border-slate-200 bg-slate-50"}`}>
                                  <div className="flex flex-wrap items-center gap-2">
                                    <div className="font-medium text-slate-900">{approval.title}</div>
                                    <Badge variant={approval.status === "pending" ? "warning" : "outline"}>{approval.status}</Badge>
                                    <Badge variant="outline">{approval.type.replace(/_/g, " ")}</Badge>
                                  </div>
                                  <div className="mt-2 text-sm leading-6 text-slate-700">{approval.description}</div>
                                  <div className="mt-2 text-xs uppercase tracking-[0.14em] text-slate-500">Requested by {requester?.name ?? approval.requestedByAgentId}</div>
                                  {approval.resolutionSummary ? <div className="mt-2 text-sm leading-6 text-slate-600">{approval.resolutionSummary}</div> : null}
                                </div>
                              );
                            })
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              ) : null}
            </CardContent>
          </Card>
        </div>
      </div>
    </main>
  );
}
