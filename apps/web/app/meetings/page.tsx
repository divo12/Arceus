"use client";

import { useEffect, useState } from "react";
import { CheckCircle2, Clock3, GitBranch, Lightbulb, MessageSquareQuote, Users } from "lucide-react";
import type { CompanySnapshot } from "@arceus/contracts";
import { Badge } from "../../components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../components/ui/card";
import { fetchWithAuth } from "../../lib/api";
import { PageShell } from "../../components/layout/page-shell";
import { useAuth } from "../../contexts/auth-context";

export default function MeetingsPage() {
  const { token } = useAuth();
  const [snapshot, setSnapshot] = useState<CompanySnapshot | null>(null);
  const [selectedMeetingId, setSelectedMeetingId] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      try {
        const response = await fetchWithAuth("/company", token, { cache: "no-store" });
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
  }, [token]);

  const agentsById = new Map((snapshot?.agents ?? []).map((agent) => [agent.id, agent]));
  const meetings = snapshot?.meetings ?? [];
  const approvals = snapshot?.approvals ?? [];
  const pendingApprovals = approvals.filter((approval) => approval.status === "pending");
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
    <PageShell title="Meetings" description="Daily syncs, eval-triggered meetings, and escalations.">
      <div className="space-y-6">

        <div className="grid grid-cols-4 gap-px border border-[var(--swiss-gray-100)]">
          <div className="bg-[var(--swiss-white)] p-4">
            <div className="swiss-caption text-[var(--swiss-gray-300)]">Meetings</div>
            <div className="mt-1 text-2xl font-semibold">{meetings.length}</div>
          </div>
          <div className="bg-[var(--swiss-white)] p-4">
            <div className="swiss-caption text-[var(--swiss-gray-300)]">Escalations</div>
            <div className="mt-1 text-2xl font-semibold">{meetings.filter((meeting) => meeting.type === "escalation").length}</div>
          </div>
          <div className="bg-[var(--swiss-white)] p-4">
            <div className="swiss-caption text-[var(--swiss-gray-300)]">Daily syncs</div>
            <div className="mt-1 text-2xl font-semibold">{meetings.filter((meeting) => meeting.type === "daily_sync").length}</div>
          </div>
          <div className="bg-[var(--swiss-white)] p-4">
            <div className="swiss-caption text-[var(--swiss-gray-300)]">Pending approvals</div>
            <div className="mt-1 text-2xl font-semibold">{pendingApprovals.length}</div>
          </div>
        </div>

        <div className="grid gap-4 xl:grid-cols-[340px_minmax(0,1fr)]">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Timeline rail</CardTitle>
              <CardDescription>Chronological flow of company meetings.</CardDescription>
            </CardHeader>
            <CardContent>
              {meetings.length === 0 ? (
                <p className="text-sm text-[var(--swiss-gray-300)]">No meetings recorded yet.</p>
              ) : (
                <div className="relative space-y-2 before:absolute before:bottom-0 before:left-[14px] before:top-0 before:w-px before:bg-[var(--swiss-gray-100)]">
                  {meetings.map((meeting) => {
                    const selected = meeting.id === selectedMeeting?.id;
                    return (
                      <button
                        key={meeting.id}
                        type="button"
                        onClick={() => setSelectedMeetingId(meeting.id)}
                        className={`relative flex w-full items-start gap-3 border p-3 text-left transition ${selected ? "border-[var(--swiss-black)] bg-[var(--swiss-black)] text-[var(--swiss-white)]" : "border-[var(--swiss-gray-100)] bg-[var(--swiss-white)] hover:border-[var(--swiss-gray-200)]"}`}
                      >
                        <div className={`relative z-10 mt-1 h-7 w-7 border-4 ${selected ? "border-[var(--swiss-black)] bg-[var(--swiss-gray-200)]" : "border-[var(--swiss-gray-50)] bg-[var(--swiss-gray-200)]"}`} />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center justify-between gap-2">
                            <div className={`text-sm font-semibold capitalize ${selected ? "text-[var(--swiss-white)]" : ""}`}>{meeting.type.replace(/_/g, " ")}</div>
                            <Badge variant={selected ? "secondary" : "outline"} className="text-[10px]">{meeting.participantAgentIds.length} people</Badge>
                          </div>
                          <div className={`mt-1 swiss-caption ${selected ? "text-[var(--swiss-gray-200)]" : "text-[var(--swiss-gray-300)]"}`}>{new Date(meeting.completedAt ?? meeting.createdAt).toLocaleString()}</div>
                          <div className={`mt-2 line-clamp-2 text-xs leading-5 ${selected ? "text-[var(--swiss-gray-200)]" : "text-[var(--swiss-gray-400)]"}`}>{meeting.title}</div>
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              {selectedMeeting ? (
                <>
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <CardTitle className="text-xl capitalize">{selectedMeeting.type.replace(/_/g, " ")}</CardTitle>
                      <CardDescription className="mt-1 max-w-3xl text-sm leading-6">{selectedMeeting.title}</CardDescription>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Badge variant="outline">{selectedMeeting.status}</Badge>
                      <Badge variant="outline">{new Date(selectedMeeting.completedAt ?? selectedMeeting.createdAt).toLocaleString()}</Badge>
                    </div>
                  </div>
                  <div className="mt-4 flex flex-wrap gap-2">
                    {selectedMeeting.participantAgentIds.map((participantId) => {
                      const participant = agentsById.get(participantId);
                      return (
                        <Badge key={participantId} variant="secondary">
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
                  <div className="grid gap-px border border-[var(--swiss-gray-100)] lg:grid-cols-2 xl:grid-cols-4">
                    <div className="bg-[var(--swiss-white)] p-4">
                      <div className="swiss-caption text-[var(--swiss-gray-300)]">Participants</div>
                      <div className="mt-2 text-2xl font-semibold">{selectedMeeting.participantAgentIds.length}</div>
                    </div>
                    <div className="bg-[var(--swiss-white)] p-4">
                      <div className="swiss-caption text-[var(--swiss-gray-300)]">Contributions</div>
                      <div className="mt-2 text-2xl font-semibold">{selectedMeeting.contributions.length}</div>
                    </div>
                    <div className="bg-[var(--swiss-white)] p-4">
                      <div className="swiss-caption text-[var(--swiss-gray-300)]">Conflicts</div>
                      <div className="mt-2 text-2xl font-semibold">{selectedMeeting.synthesis?.conflicts.length ?? 0}</div>
                    </div>
                    <div className="bg-[var(--swiss-white)] p-4">
                      <div className="swiss-caption text-[var(--swiss-gray-300)]">Decisions</div>
                      <div className="mt-2 text-2xl font-semibold">{selectedMeeting.resolutions?.decisions.length ?? 0}</div>
                    </div>
                  </div>

                  <div className="relative space-y-5 before:absolute before:bottom-0 before:left-4 before:top-0 before:w-px before:bg-[var(--swiss-gray-100)]">
                    {/* Contributions */}
                    <div className="relative pl-12">
                      <div className="absolute left-0 top-1 flex h-8 w-8 items-center justify-center bg-[var(--swiss-black)] text-[var(--swiss-white)]"><MessageSquareQuote className="h-4 w-4" /></div>
                      <div className="border border-[var(--swiss-gray-100)] p-4">
                        <div className="text-sm font-semibold">Contributions</div>
                        <div className="mt-3 space-y-3">
                          {selectedMeeting.contributions.length === 0 ? (
                            <div className="border border-dashed border-[var(--swiss-gray-100)] p-3 text-sm text-[var(--swiss-gray-300)]">No contributions recorded.</div>
                          ) : (
                            selectedMeeting.contributions.map((c) => (
                              <div key={c.agentId} className="border border-[var(--swiss-gray-100)] bg-[var(--swiss-gray-50)] p-3">
                                <div className="flex flex-wrap items-center gap-2">
                                  <div className="font-medium">{c.agentName}</div>
                                  <Badge variant="outline">{c.agentRole}</Badge>
                                </div>
                                {c.contribution.whatIDid ? <div className="mt-2 text-sm leading-6 text-[var(--swiss-gray-400)]"><strong>Done:</strong> {c.contribution.whatIDid}</div> : null}
                                {c.contribution.whatImDoing ? <div className="mt-1 text-sm leading-6 text-[var(--swiss-gray-400)]"><strong>Doing:</strong> {c.contribution.whatImDoing}</div> : null}
                                {c.contribution.blockers ? <div className="mt-1 text-sm leading-6 text-[var(--swiss-red)]"><strong>Blockers:</strong> {c.contribution.blockers}</div> : null}
                                {c.contribution.learnings ? <div className="mt-1 text-sm leading-6 text-[var(--swiss-gray-400)]"><strong>Learnings:</strong> {c.contribution.learnings}</div> : null}
                                {c.contribution.questionsForTeam ? <div className="mt-1 text-sm leading-6 text-[var(--swiss-gray-400)]"><strong>Questions:</strong> {c.contribution.questionsForTeam}</div> : null}
                              </div>
                            ))
                          )}
                        </div>
                      </div>
                    </div>

                    {/* Synthesis */}
                    {selectedMeeting.synthesis ? (
                      <div className="relative pl-12">
                        <div className="absolute left-0 top-1 flex h-8 w-8 items-center justify-center bg-[var(--swiss-black)] text-[var(--swiss-white)]"><Lightbulb className="h-4 w-4" /></div>
                        <div className="border border-[var(--swiss-gray-100)] p-4">
                          <div className="text-sm font-semibold">Synthesis</div>
                          <div className="mt-3 space-y-3">
                            {selectedMeeting.synthesis.conflicts.map((c) => (
                              <div key={c.id} className="border border-[var(--swiss-red)]/30 bg-red-50 p-3 text-sm leading-6">
                                <Badge variant="outline" className="mb-1">{c.severity} conflict</Badge>
                                <div>{c.description}</div>
                              </div>
                            ))}
                            {selectedMeeting.synthesis.blockers.map((b) => (
                              <div key={b.id} className="border border-yellow-300 bg-yellow-50 p-3 text-sm leading-6">
                                <Badge variant="outline" className="mb-1">blocker</Badge>
                                <div>{b.description}</div>
                              </div>
                            ))}
                            {selectedMeeting.synthesis.highlights.map((h, i) => (
                              <div key={i} className="border border-[var(--swiss-gray-100)] bg-[var(--swiss-gray-50)] p-3 text-sm leading-6">
                                <Badge variant="outline" className="mb-1">{h.type}</Badge>
                                <div>{h.description}</div>
                              </div>
                            ))}
                            {selectedMeeting.synthesis.conflicts.length === 0 && selectedMeeting.synthesis.blockers.length === 0 && selectedMeeting.synthesis.highlights.length === 0 ? (
                              <div className="border border-dashed border-[var(--swiss-gray-100)] p-3 text-sm text-[var(--swiss-gray-300)]">No issues detected.</div>
                            ) : null}
                          </div>
                        </div>
                      </div>
                    ) : null}

                    {/* Resolutions */}
                    <div className="relative pl-12">
                      <div className="absolute left-0 top-1 flex h-8 w-8 items-center justify-center bg-[var(--swiss-black)] text-[var(--swiss-white)]"><CheckCircle2 className="h-4 w-4" /></div>
                      <div className="border border-[var(--swiss-gray-100)] p-4">
                        <div className="text-sm font-semibold">Decisions</div>
                        <div className="mt-3 space-y-3">
                          {!selectedMeeting.resolutions || selectedMeeting.resolutions.decisions.length === 0 ? (
                            <div className="border border-dashed border-[var(--swiss-gray-100)] p-3 text-sm text-[var(--swiss-gray-300)]">No decisions were recorded.</div>
                          ) : (
                            selectedMeeting.resolutions.decisions.map((d, i) => (
                              <div key={i} className="border border-[var(--swiss-gray-100)] bg-[var(--swiss-gray-50)] p-3">
                                <div className="flex flex-wrap items-center gap-2">
                                  <Badge variant="outline">{d.action.replace(/_/g, " ")}</Badge>
                                </div>
                                <div className="mt-2 text-sm leading-6 text-[var(--swiss-gray-400)]">{d.decision}</div>
                              </div>
                            ))
                          )}
                        </div>
                      </div>
                    </div>

                    {/* Brief */}
                    {selectedMeeting.brief ? (
                      <div className="relative pl-12">
                        <div className="absolute left-0 top-1 flex h-8 w-8 items-center justify-center bg-[var(--swiss-black)] text-[var(--swiss-white)]"><Users className="h-4 w-4" /></div>
                        <div className="border border-[var(--swiss-gray-100)] p-4">
                          <div className="text-sm font-semibold">Daily sync brief</div>
                          <div className="mt-3 text-sm leading-6 text-[var(--swiss-gray-400)]">{selectedMeeting.brief.companyStatus}</div>
                          {selectedMeeting.brief.activeBlockers.length > 0 ? (
                            <div className="mt-2">
                              <div className="swiss-caption text-[var(--swiss-gray-300)]">Active blockers</div>
                              {selectedMeeting.brief.activeBlockers.map((b, i) => (
                                <div key={i} className="mt-1 text-sm text-[var(--swiss-red)]">{b}</div>
                              ))}
                            </div>
                          ) : null}
                        </div>
                      </div>
                    ) : null}

                    {/* Approval requests */}
                    <div className="relative pl-12">
                      <div className="absolute left-0 top-1 flex h-8 w-8 items-center justify-center bg-[var(--swiss-black)] text-[var(--swiss-white)]"><CheckCircle2 className="h-4 w-4" /></div>
                      <div className="border border-[var(--swiss-gray-100)] p-4">
                        <div className="text-sm font-semibold">Approval requests</div>
                        <div className="mt-3 space-y-3">
                          {selectedMeetingApprovals.length === 0 ? (
                            <div className="border border-dashed border-[var(--swiss-gray-100)] p-3 text-sm text-[var(--swiss-gray-300)]">No approval requests were linked to this meeting.</div>
                          ) : (
                            selectedMeetingApprovals.map((approval) => {
                              const requester = agentsById.get(approval.requestedByAgentId);
                              return (
                                <div key={approval.id} className={`border p-3 ${approval.status === "pending" ? "border-[var(--swiss-red)]" : "border-[var(--swiss-gray-100)] bg-[var(--swiss-gray-50)]"}`}>
                                  <div className="flex flex-wrap items-center gap-2">
                                    <div className="font-medium">{approval.title}</div>
                                    <Badge variant={approval.status === "pending" ? "warning" : "outline"}>{approval.status}</Badge>
                                    <Badge variant="outline">{approval.type.replace(/_/g, " ")}</Badge>
                                  </div>
                                  <div className="mt-2 text-sm leading-6 text-[var(--swiss-gray-400)]">{approval.description}</div>
                                  <div className="mt-2 swiss-caption text-[var(--swiss-gray-300)]">Requested by {requester?.name ?? approval.requestedByAgentId}</div>
                                  {approval.resolutionSummary ? <div className="mt-2 text-sm leading-6 text-[var(--swiss-gray-400)]">{approval.resolutionSummary}</div> : null}
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
    </PageShell>
  );
}
