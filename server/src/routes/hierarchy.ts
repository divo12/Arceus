import { Router } from "express";
import type { Db } from "@paperclipai/db";
import {
  proposeHierarchyChangeSchema,
  resolveHierarchyProposalSchema,
} from "@paperclipai/shared";
import { forbidden } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { agentService, hierarchyService } from "../services/index.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";

export function hierarchyRoutes(db: Db) {
  const router = Router();
  const hierarchy = hierarchyService(db);
  const agents = agentService(db);

  router.get("/companies/:companyId/hierarchy", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const active = await hierarchy.getCurrentActive(companyId);
    if (!active) {
      res.json(null);
      return;
    }
    const edges = await hierarchy.getEdges(active.id);
    res.json({ ...active, edges });
  });

  router.get("/companies/:companyId/hierarchy/proposals", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const proposals = await hierarchy.listProposals(companyId);
    res.json(proposals);
  });

  router.post(
    "/companies/:companyId/hierarchy/proposals",
    validate(proposeHierarchyChangeSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);

      if (req.actor.type === "agent" && req.actor.agentId) {
        const agent = await agents.getById(req.actor.agentId);
        if (!agent || agent.role !== "ceo") {
          throw forbidden("Only CEO agents can propose hierarchy changes");
        }
      }

      const actor = getActorInfo(req);
      const snapshot = await hierarchy.propose(companyId, {
        edges: req.body.edges,
        description: req.body.description,
        proposedByAgentId: actor.agentId ?? undefined,
        proposedByUserId: actor.actorType === "user" ? actor.actorId : undefined,
      });
      res.status(201).json(snapshot);
    },
  );

  router.get("/hierarchy/:snapshotId", async (req, res) => {
    const snapshotId = req.params.snapshotId as string;
    const snapshot = await hierarchy.getById(snapshotId);
    assertCompanyAccess(req, snapshot.companyId);
    const edges = await hierarchy.getEdges(snapshotId);
    res.json({ ...snapshot, edges });
  });

  router.get("/hierarchy/:snapshotId/diff", async (req, res) => {
    const snapshotId = req.params.snapshotId as string;
    const snapshot = await hierarchy.getById(snapshotId);
    assertCompanyAccess(req, snapshot.companyId);

    const active = await hierarchy.getCurrentActive(snapshot.companyId);
    if (!active) {
      const edges = await hierarchy.getEdges(snapshotId);
      res.json({ added: edges, removed: [] });
      return;
    }

    const diff = await hierarchy.diffSnapshots(active.id, snapshotId);
    res.json(diff);
  });

  router.post("/hierarchy/:snapshotId/approve", async (req, res) => {
    assertBoard(req);
    const snapshot = await hierarchy.getById(req.params.snapshotId as string);
    assertCompanyAccess(req, snapshot.companyId);
    const actor = getActorInfo(req);
    const updated = await hierarchy.approve(snapshot.id, actor.actorId);
    res.json(updated);
  });

  router.post("/hierarchy/:snapshotId/activate", async (req, res) => {
    assertBoard(req);
    const snapshot = await hierarchy.getById(req.params.snapshotId as string);
    assertCompanyAccess(req, snapshot.companyId);
    const activated = await hierarchy.activate(snapshot.id);
    res.json(activated);
  });

  router.post(
    "/hierarchy/:snapshotId/reject",
    validate(resolveHierarchyProposalSchema),
    async (req, res) => {
      assertBoard(req);
      const snapshot = await hierarchy.getById(req.params.snapshotId as string);
      assertCompanyAccess(req, snapshot.companyId);
      const actor = getActorInfo(req);
      const updated = await hierarchy.reject(
        snapshot.id,
        actor.actorId,
        req.body.reason,
      );
      res.json(updated);
    },
  );

  return router;
}
