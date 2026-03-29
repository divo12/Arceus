import { Router } from "express";
import type { Db } from "@paperclipai/db";
import {
  createRoleDefinitionSchema,
  updateRoleDefinitionSchema,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { roleDefinitionService } from "../services/index.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";

export function roleRoutes(db: Db) {
  const router = Router();
  const roleDefinitions = roleDefinitionService(db);

  router.get("/companies/:companyId/roles", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const roles = await roleDefinitions.list(companyId);
    res.json(roles);
  });

  router.get("/companies/:companyId/roles/:slug", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const role = await roleDefinitions.getBySlug(companyId, req.params.slug as string);
    res.json(role);
  });

  router.post(
    "/companies/:companyId/roles",
    validate(createRoleDefinitionSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertBoard(req);
      assertCompanyAccess(req, companyId);
      const created = await roleDefinitions.create(companyId, req.body);
      res.status(201).json(created);
    },
  );

  router.patch("/roles/:roleId", validate(updateRoleDefinitionSchema), async (req, res) => {
    assertBoard(req);
    const existing = await roleDefinitions.getById(req.params.roleId as string);
    assertCompanyAccess(req, existing.companyId);
    const updated = await roleDefinitions.update(existing.id, req.body);
    res.json(updated);
  });

  router.get("/roles/:roleId/authority-matrix", async (req, res) => {
    const role = await roleDefinitions.getById(req.params.roleId as string);
    assertCompanyAccess(req, role.companyId);
    res.json({
      canDelegateTo: role.canDelegateTo,
      delegationStyle: role.delegationStyle,
      spawnRules: role.spawnRules,
    });
  });

  return router;
}
