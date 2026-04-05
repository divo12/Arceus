import { z } from "zod";

export const actorTypeSchema = z.enum(["board", "agent", "system", "runtime"]);

export const eventEnvelopeSchema = z.object({
  eventId: z.string(),
  companyId: z.string(),
  entityType: z.string(),
  entityId: z.string(),
  eventType: z.string(),
  causationId: z.string().nullable(),
  correlationId: z.string(),
  actorType: actorTypeSchema,
  actorId: z.string(),
  occurredAt: z.string(),
  summary: z.string(),
  payload: z.record(z.string(), z.unknown())
});

export type EventEnvelope = z.infer<typeof eventEnvelopeSchema>;
