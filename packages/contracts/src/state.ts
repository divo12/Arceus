import { z } from "zod";

import { companySchema, fundamentalIdeaSchema, strategyBriefSchema } from "./company";
import { hierarchyNodeSchema, agentIdentitySchema, sessionBindingSchema } from "./agents";
import { taskSchema, transitionSchema, feedbackRoundSchema } from "./tasks";
import { sprintSchema } from "./sprints";
import { meetingSchema, meetingScheduleSchema } from "./meetings";
import { approvalSchema } from "./approvals";
import { artifactSchema } from "./artifacts";
import { chatMessageSchema } from "./chat";
import { memorySummarySchema, memoryUnitSchema, habitSchema, primingStateSchema } from "./memory";
import { workspaceFileManifestEntrySchema } from "./workspace";

export const companySnapshotSchema = z.object({
  company: companySchema,
  idea: fundamentalIdeaSchema,
  strategy: strategyBriefSchema,
  sprints: z.array(sprintSchema),
  hierarchy: z.array(hierarchyNodeSchema),
  agents: z.array(agentIdentitySchema),
  sessions: z.array(sessionBindingSchema),
  tasks: z.array(taskSchema),
  artifacts: z.array(artifactSchema),
  chatMessages: z.array(chatMessageSchema),
  meetings: z.array(meetingSchema),
  meetingSchedules: z.array(meetingScheduleSchema).default([]),
  approvals: z.array(approvalSchema),
  memories: z.array(memorySummarySchema),
  memoryUnits: z.array(memoryUnitSchema),
  habits: z.array(habitSchema),
  priming: z.array(primingStateSchema),
  transitions: z.array(transitionSchema).default([]),
  feedbackRounds: z.array(feedbackRoundSchema).default([])
});

export const sprintSnapshotStatusSchema = z.enum(["active", "rolled_back"]);

export const sprintSnapshotSchema = z.object({
  id: z.string(),
  companyId: z.string(),
  sprintNumber: z.number().int().positive(),
  gitTag: z.string(),
  bundleKey: z.string().nullable(),
  bundleSha256: z.string().nullable(),
  bundleBytes: z.number().int().nonnegative().nullable(),
  snapshotData: z.lazy(() => companySnapshotSchema),
  fileManifest: z.array(workspaceFileManifestEntrySchema),
  status: sprintSnapshotStatusSchema,
  createdAt: z.string(),
});

export type CompanySnapshot = z.infer<typeof companySnapshotSchema>;
export type SprintSnapshot = z.infer<typeof sprintSnapshotSchema>;
