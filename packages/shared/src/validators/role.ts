import { z } from "zod";
import {
  AGENT_ROLES,
  DELEGATION_STYLES,
  EMPLOYEE_ROLES,
} from "../constants.js";

export const spawnRuleConfigSchema = z.object({
  allowedAgentTypes: z.array(z.enum(AGENT_ROLES)).default([])
    .refine(
      (roles) => roles.every((role) => !(EMPLOYEE_ROLES as readonly string[]).includes(role)),
      { message: "Employee roles (ceo, cto, engineer, designer, pm) cannot be spawned" },
    ),
  maxConcurrentSpawns: z.number().int().min(0).max(20).default(0),
  spawnDepth: z.literal(1).default(1),
});

export const createRoleDefinitionSchema = z.object({
  slug: z.string().min(1).max(50).regex(/^[a-z][a-z0-9_-]*$/),
  label: z.string().min(1).max(100),
  systemPrompt: z.string().max(10000).default(""),
  tools: z.array(z.string()).default([]),
  skillsSeed: z.array(z.string()).default([]),
  canDelegateTo: z.array(z.enum(EMPLOYEE_ROLES)).default([]),
  delegationStyle: z.enum(DELEGATION_STYLES).default("collaborative"),
  spawnRules: spawnRuleConfigSchema.default({}),
});

export const updateRoleDefinitionSchema = z.object({
  label: z.string().min(1).max(100).optional(),
  systemPrompt: z.string().max(10000).optional(),
  tools: z.array(z.string()).optional(),
  skillsSeed: z.array(z.string()).optional(),
  canDelegateTo: z.array(z.enum(EMPLOYEE_ROLES)).optional(),
  delegationStyle: z.enum(DELEGATION_STYLES).optional(),
  spawnRules: spawnRuleConfigSchema.optional(),
}).refine((data) => Object.keys(data).length > 0, {
  message: "At least one field must be provided for update",
});

export type CreateRoleDefinition = z.infer<typeof createRoleDefinitionSchema>;
export type UpdateRoleDefinition = z.infer<typeof updateRoleDefinitionSchema>;
export type SpawnRuleConfigInput = z.infer<typeof spawnRuleConfigSchema>;
