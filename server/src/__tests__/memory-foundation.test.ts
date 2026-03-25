import { describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { handleMemoryError } from "../routes/memory.js";
import { HippocampusDisabledError } from "../services/hippocampus-contract.js";
import {
  GraphUnavailableError,
  MemoryNotFoundError,
  MemoryValidationError,
} from "../services/hippocampus-errors.js";
import {
  createEmptyMemoryServices,
  createMemoryServices,
  type MemoryServiceFactories,
} from "../services/memory-services.js";
import {
  DelegateSchema,
  GraphQuerySchema,
  InternalizeDelegationSchema,
  MeetingExtractSchema,
  ProfileQuerySchema,
  ScopedRecallSchema,
} from "../services/memory-schemas.js";

type MockResponse = {
  body: unknown;
  status(code: number): MockResponse;
  statusCode: number;
  json(payload: unknown): MockResponse;
};

function createResponse(): MockResponse {
  return {
    statusCode: 200,
    body: undefined,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
}

describe("memory foundation", () => {
  it("parses scoped recall and graph query defaults", () => {
    expect(
      ScopedRecallSchema.parse({
        query: "deploy",
        startupId: "startup-1",
        employeeId: "emp-1",
      }),
    ).toEqual({
      query: "deploy",
      startupId: "startup-1",
      employeeId: "emp-1",
      includeShared: true,
      topK: 10,
    });

    expect(
      GraphQuerySchema.parse({
        query: "auth",
        depth: "2",
      }),
    ).toEqual({
      query: "auth",
      container: "default",
      depth: 2,
    });
  });

  it("rejects malformed schema inputs", () => {
    expect(() => DelegateSchema.parse({
      toAgentId: "",
      startupId: "startup-1",
      taskId: "task-1",
      taskDescription: "desc",
    })).toThrow(ZodError);

    expect(() => InternalizeDelegationSchema.parse({
      startupId: "startup-1",
      learnings: [],
      quality: 0.5,
    })).toThrow(ZodError);

    expect(() => ProfileQuerySchema.parse({
      startupId: "startup-1",
      role: "",
    })).toThrow(ZodError);

    expect(() => MeetingExtractSchema.parse({
      meetingId: "meeting-1",
      transcript: "",
      participants: [],
    })).toThrow(ZodError);
  });

  it("creates empty memory services by default", () => {
    expect(createEmptyMemoryServices()).toEqual({
      scope: null,
      projections: null,
      profile: null,
      delegation: null,
    });
  });

  it("instantiates all memory services from a single bridge", () => {
    const bridge = { mode: "embedded" } as never;
    const seen: unknown[] = [];

    const factories: MemoryServiceFactories<string, string, string, string> = {
      createScope(input) {
        seen.push(input);
        return "scope";
      },
      createProjections(input) {
        seen.push(input);
        return "projections";
      },
      createProfile(input) {
        seen.push(input);
        return "profile";
      },
      createDelegation(input) {
        seen.push(input);
        return "delegation";
      },
    };

    expect(createMemoryServices(bridge, factories)).toEqual({
      scope: "scope",
      projections: "projections",
      profile: "profile",
      delegation: "delegation",
    });
    expect(seen).toEqual([bridge, bridge, bridge, bridge]);
  });

  it("maps typed memory errors to structured responses", () => {
    const res = createResponse();
    handleMemoryError(res, new MemoryValidationError("bad input", { field: "query" }));
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({
      error: "bad input",
      code: "MEMORY_VALIDATION_ERROR",
      details: { field: "query" },
    });

    const notFoundRes = createResponse();
    handleMemoryError(notFoundRes, new MemoryNotFoundError("memory", "mem-1"));
    expect(notFoundRes.statusCode).toBe(404);

    const graphRes = createResponse();
    handleMemoryError(graphRes, new GraphUnavailableError());
    expect(graphRes.statusCode).toBe(503);
    expect(graphRes.body).toEqual({
      error: "Graph store is not available",
      code: "GRAPH_UNAVAILABLE",
      details: undefined,
    });
  });

  it("maps zod, disabled, and unknown errors", () => {
    const disabledRes = createResponse();
    handleMemoryError(disabledRes, new HippocampusDisabledError());
    expect(disabledRes.statusCode).toBe(503);
    expect(disabledRes.body).toEqual({ error: "Memory system is disabled" });

    const zodRes = createResponse();
    let parseError: unknown;
    try {
      ScopedRecallSchema.parse({
        query: "",
        startupId: "startup-1",
        employeeId: "emp-1",
      });
    } catch (error) {
      parseError = error;
    }
    handleMemoryError(zodRes, parseError);
    expect(zodRes.statusCode).toBe(400);
    expect(zodRes.body).toEqual(expect.objectContaining({
      error: "Validation failed",
      code: "VALIDATION_ERROR",
    }));

    const unknownRes = createResponse();
    handleMemoryError(unknownRes, new Error("boom"));
    expect(unknownRes.statusCode).toBe(500);
    expect(unknownRes.body).toEqual({ error: "Internal server error" });
  });
});
