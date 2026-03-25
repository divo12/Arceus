export class MemoryServiceError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly code: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "MemoryServiceError";
  }
}

export class MemoryValidationError extends MemoryServiceError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 400, "MEMORY_VALIDATION_ERROR", details);
    this.name = "MemoryValidationError";
  }
}

export class MemoryNotFoundError extends MemoryServiceError {
  constructor(entityType: string, id: string) {
    super(`${entityType} "${id}" not found`, 404, "MEMORY_NOT_FOUND");
    this.name = "MemoryNotFoundError";
  }
}

export class GraphUnavailableError extends MemoryServiceError {
  constructor() {
    super("Graph store is not available", 503, "GRAPH_UNAVAILABLE");
    this.name = "GraphUnavailableError";
  }
}
