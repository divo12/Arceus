import React, { useCallback, useState } from "react";
import type { TabId } from "./contracts/view.js";
import { Sidebar } from "./components/Sidebar.js";
import { ErrorBanner } from "./components/primitives.js";
import { useAuditStream, useHeartbeat, useView } from "./lib/hooks.js";
import { api } from "./lib/api.js";
import type {
  RawAgent, RawAuditEvent, RawCompany, RawMeeting, RawMemory,
  RawSkill, RawSprint, RawTask, RawWorkspace,
} from "./lib/api.js";
import {
  deriveInbox, deriveLogs, deriveMeetings, deriveMemory, derivePreview,
  deriveSettings, deriveShell, deriveSkills, deriveSprint, deriveTeam, deriveToday,
} from "./lib/derive.js";
import { TodayPage } from "./views/Today.js";
import { SprintPage } from "./views/Sprint.js";
import { TeamPage } from "./views/Team.js";
import { MemoryPage } from "./views/Memory.js";
import { SkillsPage } from "./views/Skills.js";
import { MeetingsPage } from "./views/Meetings.js";
import { InboxPage } from "./views/Inbox.js";
import { PreviewPage } from "./views/Preview.js";
import { LogsPage } from "./views/Logs.js";
import { InspectorPage } from "./views/Inspector.js";
import { SettingsPage } from "./views/Settings.js";
import { AskBar } from "./components/AskBar.js";

export function App() {
  const [active, setActive] = useState<TabId>("today");
  const heartbeat = useHeartbeat();

  const bundle = useView(async () => {
    const safe = async <T,>(p: Promise<T>, fallback: T): Promise<T> => {
      try { return await p; } catch { return fallback; }
    };
    const [
      company, agentsRes, memories, sprints, tasks, skillsRes,
      meetings, audit, workspace, trust,
    ] = await Promise.all([
      safe(api.get<RawCompany>("/api/company"), {}),
      safe(api.get<{ id: string; name: string; role: string }[] | RawAgent[]>("/api/employees"), [] as RawAgent[]),
      safe(api.get<RawMemory[]>("/api/employee-memories"), [] as RawMemory[]),
      safe(api.get<RawSprint[]>("/api/sprints"), [] as RawSprint[]),
      safe(api.get<RawTask[]>("/api/tasks"), [] as RawTask[]),
      safe(api.get<{ skills: RawSkill[]; total: number }>("/api/skills"), { skills: [], total: 0 }),
      safe(api.get<RawMeeting[]>("/api/meetings"), [] as RawMeeting[]),
      safe(api.get<RawAuditEvent[]>("/api/audit/events?limit=200"), [] as RawAuditEvent[]),
      safe(api.get<RawWorkspace>("/api/workspace"), {}),
      safe(
        api.get<{ scores: { agentId: string; score: number; band: string }[] }>("/api/governance/trust-scores"),
        { scores: [] },
      ),
    ]);

    const agents = (agentsRes ?? []) as RawAgent[];
    const skills = skillsRes.skills ?? [];
    const auditEvents = audit ?? [];
    const auditTotal = auditEvents.length;

    const shell = deriveShell({
      company, sprints, agents, memories, skills, meetings,
      audit: { total: auditTotal },
      heartbeat,
    });

    return {
      shell,
      raw: { agents, tasks, audit: auditEvents, sprints, skills, meetings, memories },
      today:    deriveToday({ company, agents, memories, sprints, heartbeat, audit: auditEvents }),
      sprint:   deriveSprint({ sprints, tasks }),
      team:     deriveTeam({ agents }),
      memory:   deriveMemory({ memories }),
      skills:   deriveSkills({ skills }),
      meetings: deriveMeetings({ meetings, agents }),
      inbox:    deriveInbox({ audit: auditEvents }),
      preview:  derivePreview({ workspace }),
      logs:     deriveLogs({ audit: auditEvents }),
      settings: deriveSettings({ company, trustScores: trust.scores, heartbeat }),
    };
  }, [heartbeat.beatCount, heartbeat.running]);

  useAuditStream(useCallback(() => { bundle.refresh(); }, [bundle]));

  const onPromote = useCallback(async (skillId: string) => {
    try {
      await api.post(`/api/skills/${skillId}/promote`);
      bundle.refresh();
    } catch (e) {
      console.warn("[promote]", e);
    }
  }, [bundle]);

  const onToggleHeartbeat = useCallback(async () => {
    try {
      await api.post(heartbeat.running ? "/api/heartbeat/stop" : "/api/heartbeat/start");
      bundle.refresh();
    } catch (e) {
      console.warn("[heartbeat]", e);
    }
  }, [bundle, heartbeat.running]);

  const onReset = useCallback(async () => {
    try {
      await api.delete("/api/company");
      setActive("today");
      bundle.refresh();
    } catch (e) {
      console.warn("[reset]", e);
    }
  }, [bundle]);

  const data = bundle.data;

  if (!data) {
    return (
      <div className="shell">
        <div className="rail" />
        <main className="main">
          <div className="col">
            <div className="date">loading</div>
            <h1 className="sentence">The company is waking up.</h1>
            {bundle.error && <ErrorBanner message={bundle.error} />}
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="shell">
      <Sidebar shell={data.shell} active={active} onSelect={setActive} />
      {data.today.mode === "chat" && data.today.companyName && (
        <button
          className="top-reset"
          onClick={() => {
            if (window.confirm(`Wipe ${data.today.companyName}? This deletes the company, agents, sprints, and memory.`)) {
              onReset();
            }
          }}
          title="Reset company"
        >
          reset
        </button>
      )}
      <main className="main">
        {bundle.error && (
          <div className="col" style={{ paddingBottom: 0 }}>
            <ErrorBanner message={bundle.error} />
          </div>
        )}
        {active === "today"     && <TodayPage     v={data.today} pulse={data.shell.pulse} onRefresh={() => { bundle.refresh(); }} />}
        {active === "sprint"    && <SprintPage    v={data.sprint} tasks={data.raw.tasks} agents={data.raw.agents} />}
        {active === "team"      && <TeamPage      v={data.team} agents={data.raw.agents} audit={data.raw.audit} />}
        {active === "memory"    && <MemoryPage    v={data.memory} />}
        {active === "skills"    && <SkillsPage    v={data.skills} onPromote={onPromote} />}
        {active === "meetings"  && <MeetingsPage  v={data.meetings} />}
        {active === "inbox"     && <InboxPage     v={data.inbox} />}
        {active === "preview"   && <PreviewPage   v={data.preview} />}
        {active === "logs"      && <LogsPage      v={data.logs} audit={data.raw.audit} />}
        {active === "inspector" && <InspectorPage pulse={data.shell.pulse} agents={data.raw.agents} audit={data.raw.audit} heartbeatRunning={heartbeat.running} onToggleHeartbeat={onToggleHeartbeat} />}
        {active === "settings"  && <SettingsPage  v={data.settings} heartbeatRunning={heartbeat.running} onToggleHeartbeat={onToggleHeartbeat} onReset={onReset} />}
      </main>
      {data.today.mode === "chat" && data.today.companyName && (
        <AskBar companyName={data.today.companyName} onAfter={() => { bundle.refresh(); }} />
      )}
    </div>
  );
}
