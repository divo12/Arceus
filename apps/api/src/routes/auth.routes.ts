/**
 * Auth routes — user registration and login.
 * POST /api/auth/register — creates user + bootstraps their company, returns JWT.
 * POST /api/auth/login    — verifies credentials, returns JWT.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { observability } from "@arceus/contracts";
import { getDb } from "@arceus/db";
import * as usersRepo from "@arceus/db/src/repos/users.js";
import * as companiesRepo from "@arceus/db/src/repos/companies.js";
import { hashPassword, verifyPassword } from "../auth/password.js";
import { signJwt } from "../auth/jwt.js";
import { bootstrapCompanyWithWorkspace } from "../orchestration/bootstrap.js";

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8, "Password must be at least 8 characters"),
  displayName: z.string().optional(),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export default async function authRoutes(app: FastifyInstance) {
  app.post("/api/auth/register", async (request, reply) => {
    try {
      const result = registerSchema.safeParse(request.body);
      if (!result.success) {
        return reply.code(400).send({ error: result.error.errors[0]?.message ?? "Invalid input" });
      }
      const { email, password, displayName } = result.data;
      const db = getDb();

      const existing = await usersRepo.findUserByEmail(db, email);
      if (existing) {
        return reply.code(409).send({ error: "Email already registered" });
      }

      const passwordHash = await hashPassword(password);
      const user = await usersRepo.createUser(db, {
        email,
        displayName: displayName ?? email.split("@")[0],
        passwordHash,
      });

      // Bootstrap a private company for this user.
      const { snapshot } = await bootstrapCompanyWithWorkspace({
        companyName: displayName ?? email.split("@")[0] ?? "My Company",
        boardOwner: displayName ?? email,
        idea: "A new venture",
        budgetCents: 999_999_999,
        userId: user.id,
      });

      const companyId = snapshot.company.id;
      const token = await signJwt({ userId: user.id, companyId });
      return reply.code(201).send({ token, userId: user.id, companyId });
    } catch (err) {
      observability.logEvent({ event: "error", where: "auth.register", message: err instanceof Error ? err.message : String(err), stack: err instanceof Error ? err.stack : undefined, ts: Date.now() });
      return reply.code(500).send({ error: "Registration failed due to an internal error." });
    }
  });

  app.post("/api/auth/login", async (request, reply) => {
    try {
      const result = loginSchema.safeParse(request.body);
      if (!result.success) {
        return reply.code(400).send({ error: "Invalid input" });
      }
      const { email, password } = result.data;
      const db = getDb();

      const user = await usersRepo.findUserByEmail(db, email);
      if (!user?.passwordHash) {
        return reply.code(401).send({ error: "Invalid credentials" });
      }

      const ok = await verifyPassword(password, user.passwordHash);
      if (!ok) {
        return reply.code(401).send({ error: "Invalid credentials" });
      }

      let company = await companiesRepo.findCompanyByUserId(db, user.id);
      // Legacy users: no company linked yet — bootstrap one and link it now.
      if (!company) {
        const { snapshot } = await bootstrapCompanyWithWorkspace({
          companyName: user.displayName ?? user.email.split("@")[0] ?? "My Company",
          boardOwner: user.displayName ?? user.email,
          idea: "A new venture",
          budgetCents: 999_999_999,
          userId: user.id,
        });
        company = await companiesRepo.findCompanyByUserId(db, user.id) ?? null;
        if (!company) {
          // Fallback: use the snapshot id directly
          const companyId = snapshot.company.id;
          const token = await signJwt({ userId: user.id, companyId });
          return reply.code(200).send({ token, userId: user.id, companyId });
        }
      }
      const companyId = company.friendlyId ?? company.id;
      const token = await signJwt({ userId: user.id, companyId });
      return reply.code(200).send({ token, userId: user.id, companyId });
    } catch (err) {
      observability.logEvent({ event: "error", where: "auth.login", message: err instanceof Error ? err.message : String(err), stack: err instanceof Error ? err.stack : undefined, ts: Date.now() });
      return reply.code(500).send({ error: "Login failed due to an internal error." });
    }
  });
}
