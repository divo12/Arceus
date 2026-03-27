import { Router } from "express";
import type { Db } from "@paperclipai/db";
import {
  createMeetingSchema,
  updateMeetingSchema,
  addMeetingEventSchema,
  meetingParticipantContributionSchema,
  createEscalationMeetingSchema,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { logActivity, meetingService, heartbeatService } from "../services/index.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";
import { queueMeetingParticipantWakeup } from "../services/meeting-wakeup.js";

export function meetingRoutes(db: Db) {
  const router = Router();
  const svc = meetingService(db);
  const heartbeat = heartbeatService(db);

  // ------- Company-scoped collection -------

  router.get("/companies/:companyId/meetings", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const result = await svc.list(companyId, {
      type: req.query.type as string | undefined,
      status: req.query.status as string | undefined,
    });
    res.json(result);
  });

  router.post("/companies/:companyId/meetings", validate(createMeetingSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const created = await svc.create(companyId, req.body, {
      agentId: req.actor.type === "agent" ? req.actor.agentId : null,
      userId: req.actor.type === "board" ? req.actor.userId ?? "board" : null,
    });
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "meeting.created",
      entityType: "meeting",
      entityId: created.id,
      details: { title: created.title, type: created.type },
    });
    res.status(201).json(created);
  });

  router.post("/companies/:companyId/meetings/escalation", validate(createEscalationMeetingSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const created = await svc.createEscalation(companyId, req.body, {
      agentId: req.actor.type === "agent" ? req.actor.agentId : null,
      userId: req.actor.type === "board" ? req.actor.userId ?? "board" : null,
    });
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "meeting.escalation_created",
      entityType: "meeting",
      entityId: created.id,
      details: { title: created.title, blockerAgentId: req.body.blockerAgentId },
    });
    res.status(201).json(created);
  });

  // ------- Single meeting -------

  router.get("/meetings/:meetingId", async (req, res) => {
    const detail = await svc.getDetail(req.params.meetingId as string);
    if (!detail) {
      res.status(404).json({ error: "Meeting not found" });
      return;
    }
    assertCompanyAccess(req, detail.companyId);
    res.json(detail);
  });

  router.patch("/meetings/:meetingId", validate(updateMeetingSchema), async (req, res) => {
    const existing = await svc.get(req.params.meetingId as string);
    if (!existing) {
      res.status(404).json({ error: "Meeting not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    const updated = await svc.update(existing.id, req.body, {
      agentId: req.actor.type === "agent" ? req.actor.agentId : null,
      userId: req.actor.type === "board" ? req.actor.userId ?? "board" : null,
    });
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: existing.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "meeting.updated",
      entityType: "meeting",
      entityId: existing.id,
      details: { title: updated?.title ?? existing.title },
    });
    res.json(updated);
  });

  router.post("/meetings/:meetingId/start", async (req, res) => {
    const existing = await svc.get(req.params.meetingId as string);
    if (!existing) {
      res.status(404).json({ error: "Meeting not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    const started = await svc.start(existing.id, {
      agentId: req.actor.type === "agent" ? req.actor.agentId : null,
      userId: req.actor.type === "board" ? req.actor.userId ?? "board" : null,
    });
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: existing.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "meeting.started",
      entityType: "meeting",
      entityId: existing.id,
      details: { title: existing.title },
    });

    // Wake all participant agents so they can contribute
    const detail = await svc.getDetail(existing.id);
    if (detail) {
      void queueMeetingParticipantWakeup({
        heartbeat,
        meeting: { id: existing.id, title: existing.title, type: existing.type },
        participantAgentIds: detail.participants.map((p) => p.agentId),
        wakeReason: `Meeting started: ${existing.title}`,
        requestedByActorType: actor.actorType === "agent" ? "agent" : "user",
        requestedByActorId: actor.actorId,
      });
    }

    res.json(started);
  });

  router.post("/meetings/:meetingId/complete", async (req, res) => {
    const existing = await svc.get(req.params.meetingId as string);
    if (!existing) {
      res.status(404).json({ error: "Meeting not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    const notes = typeof req.body?.notes === "string" ? req.body.notes : null;
    const completed = await svc.complete(existing.id, notes, {
      agentId: req.actor.type === "agent" ? req.actor.agentId : null,
      userId: req.actor.type === "board" ? req.actor.userId ?? "board" : null,
    });
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: existing.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "meeting.completed",
      entityType: "meeting",
      entityId: existing.id,
      details: { title: existing.title },
    });
    res.json(completed);
  });

  router.post("/meetings/:meetingId/cancel", async (req, res) => {
    const existing = await svc.get(req.params.meetingId as string);
    if (!existing) {
      res.status(404).json({ error: "Meeting not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    const cancelled = await svc.cancel(existing.id, {
      agentId: req.actor.type === "agent" ? req.actor.agentId : null,
      userId: req.actor.type === "board" ? req.actor.userId ?? "board" : null,
    });
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: existing.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "meeting.cancelled",
      entityType: "meeting",
      entityId: existing.id,
      details: { title: existing.title },
    });
    res.json(cancelled);
  });

  // ------- Events -------

  router.get("/meetings/:meetingId/events", async (req, res) => {
    const meeting = await svc.get(req.params.meetingId as string);
    if (!meeting) {
      res.status(404).json({ error: "Meeting not found" });
      return;
    }
    assertCompanyAccess(req, meeting.companyId);
    const events = await svc.listEvents(meeting.id);
    res.json(events);
  });

  router.post("/meetings/:meetingId/events", validate(addMeetingEventSchema), async (req, res) => {
    const meeting = await svc.get(req.params.meetingId as string);
    if (!meeting) {
      res.status(404).json({ error: "Meeting not found" });
      return;
    }
    assertCompanyAccess(req, meeting.companyId);
    const event = await svc.addEvent(meeting.id, req.body);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: meeting.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "meeting.event_added",
      entityType: "meeting_event",
      entityId: event.id,
      details: { meetingId: meeting.id, kind: event.kind },
    });
    res.status(201).json(event);
  });

  // ------- Contributions -------

  router.post(
    "/meetings/:meetingId/participants/:agentId/contribution",
    validate(meetingParticipantContributionSchema),
    async (req, res) => {
      const meeting = await svc.get(req.params.meetingId as string);
      if (!meeting) {
        res.status(404).json({ error: "Meeting not found" });
        return;
      }
      assertCompanyAccess(req, meeting.companyId);
      const participant = await svc.submitContribution(
        meeting.id,
        req.params.agentId as string,
        req.body,
      );
      if (!participant) {
        res.status(404).json({ error: "Participant not found in this meeting" });
        return;
      }
      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId: meeting.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "meeting.contribution_submitted",
        entityType: "meeting_participant",
        entityId: participant.id,
        details: { meetingId: meeting.id, agentId: req.params.agentId },
      });
      res.json(participant);
    },
  );

  return router;
}
