# `server/src/app.ts`

This guide explains [`server/src/app.ts`](/Users/divyansh/Arceus/server/src/app.ts) as the file that assembles the HTTP application.

If you want one sentence first:

`app.ts` defines what the backend serves over HTTP and in what middleware order requests experience the system.

## 1. Why This File Matters

After `index.ts` has:

- loaded config
- prepared the database
- chosen deployment/auth mode

the process still does not yet have a live HTTP app.

`app.ts` is the file that answers:

- which middleware run first?
- where do `/api` routes come from?
- how do plugins attach?
- when is the UI served statically versus via Vite middleware?
- where does final error handling happen?

That is why `app.ts` should feel different from route files.

It is not one feature surface.

It is the file that composes the whole HTTP surface.

## 2. The Big Shape Of The File

Read the file as five layers:

1. imports and collaborators
2. `resolveViteHmrPort(...)`
3. `createApp(...)`
4. API route assembly
5. UI serving and process-adjacent cleanup

The majority of the file lives inside `createApp(...)`.

## 3. Imports Tell You The Story

The imports alone reveal the file's role.

You see:

- Express primitives
- route factories from many domains
- middleware like auth, logging, hostname guards, mutation guards
- plugin infrastructure
- UI-branding and Vite integration
- storage and deployment types

So before reading any logic, you can already tell this file is about:

- HTTP composition
- plugin composition
- UI composition

not about one domain like agents or issues.

## 4. Small Helper: `resolveViteHmrPort(...)`

This helper is tiny but practical:

```ts
export function resolveViteHmrPort(serverPort: number): number {
  if (serverPort <= 55_535) {
    return serverPort + 10_000;
  }
  return Math.max(1_024, serverPort - 10_000);
}
```

### What it does

It derives a likely-safe Vite HMR port from the main backend port.

### Why is this here?

Because in `vite-dev` mode, the backend is not just serving API routes.

It is also acting as the host process for UI development middleware, and HMR needs a port plan.

That is another clue that `app.ts` owns more than just Express routes.

## 5. Main Function: `createApp(...)`

This is the real center of the file.

Notice its inputs:

- `db`
- UI mode
- server port
- storage service
- deployment mode/exposure
- hostname rules
- auth readiness
- optional auth handler/session resolver

That tells you `createApp(...)` is not "just return express()."

It is a parameterized composition function.

It builds a different app shape depending on startup decisions that `index.ts` already made.

## 6. First Middleware Layer

The file starts app creation like this:

```ts
const app = express();

app.use(express.json(...));
app.use(httpLogger);
...
app.use(privateHostnameGuard(...));
app.use(actorMiddleware(...));
```

The order is important.

## 6.1 JSON parsing with raw body capture

This part:

```ts
app.use(express.json({
  verify: (req, _res, buf) => {
    (req as unknown as { rawBody: Buffer }).rawBody = buf;
  },
}));
```

does two things at once:

- parse JSON normally
- keep the raw request body attached to the request

That usually exists for cases where exact raw payloads matter, such as signed webhooks or auditing-sensitive flows.

So even this early middleware is doing more than the default.

## 6.2 HTTP logger

`httpLogger` is mounted very early so requests are observed consistently.

That makes sense because logging is cross-cutting, not route-specific.

## 6.3 Private hostname guard

This section:

```ts
const privateHostnameGateEnabled =
  opts.deploymentMode === "authenticated" && opts.deploymentExposure === "private";
```

and then:

```ts
app.use(privateHostnameGuard(...))
```

is a deployment-sensitive safety measure.

It means hostname enforcement is not blindly always-on.

The app shape depends on deployment mode and exposure mode.

That is a recurring design pattern in startup files.

## 6.4 Actor middleware

This is one of the most important middleware in the whole backend:

```ts
app.use(
  actorMiddleware(db, {
    deploymentMode: opts.deploymentMode,
    resolveSession: opts.resolveSession,
  }),
);
```

Why it matters:

Later route code assumes actor information is available on the request.

So `app.ts` is where that assumption becomes true.

That is why middleware ordering matters so much here.

If actor resolution came later, route files that read `req.actor` would be broken.

## 7. Auth Endpoints At The App Level

Then you see:

```ts
app.get("/api/auth/get-session", ...)
if (opts.betterAuthHandler) {
  app.all("/api/auth/*authPath", opts.betterAuthHandler);
}
```

This is important because it shows auth is partially composed before the general API router.

### Why not put this only in a normal route file?

Because authenticated mode may require tight wiring between:

- actor resolution
- Better Auth handler
- session introspection surface

So `app.ts` keeps that glue visible at the composition layer.

## 8. Route Composition Starts: `llmRoutes(db)`

Before building the main `/api` router, the file mounts:

```ts
app.use(llmRoutes(db));
```

That is a reminder that not everything is necessarily mounted through the same internal route tree pattern.

This file is the final authority on how the HTTP surface is attached.

## 9. The Main API Router

Now we reach the core:

```ts
const api = Router();
api.use(boardMutationGuard());
...
app.use("/api", api);
```

This is the most important composition section in the file.

## 9.1 `boardMutationGuard()`

Mounted at the top of the API router:

```ts
api.use(boardMutationGuard());
```

This means mutating requests are screened before they reach individual routes.

That is a classic cross-cutting middleware concern:

- origin safety
- board mutation protection
- route-agnostic enforcement

This is exactly the kind of thing that belongs at app-composition level.

## 9.2 Domain route mounting

Then the file mounts the main route surfaces:

- health
- companies
- company skills
- agents
- assets
- projects
- issues
- routines
- meetings
- execution workspaces
- goals
- approvals
- secrets
- costs
- activity
- dashboard
- sidebar badges
- instance settings
- roles
- hierarchy
- chat

This list is one of the best backend surface maps in the repo.

It tells you the actual product domains the HTTP server exposes.

## 9.3 Memory route wiring is especially interesting

This section matters:

```ts
const agentsSvc = agentService(db);
api.use(memoryRoutes({
  resolveAgentCompanyId: async (agentId) => {
    const agent = await agentsSvc.getById(agentId);
    return agent?.companyId;
  },
}));
```

This shows a very important Paperclip pattern:

some route modules need a small resolver or adapter from another service to enforce company scoping correctly.

So memory routing is not mounted as a totally isolated island.

It is composed with a lookup that maps an agent back to company scope.

That is a strong example of app-level dependency injection.

## 10. Plugin Infrastructure Lives Here Too

After the main domain routes, the file does a lot of plugin setup:

- worker manager
- plugin registry
- event bus
- job store
- lifecycle manager
- scheduler
- tool dispatcher
- job coordinator
- loader

This may feel surprising at first, but it makes sense.

Plugins are not one normal route.

They are part of the host platform.

So the place that assembles the host HTTP app is also a reasonable place to assemble plugin host services.

## 10.1 Why this section is important

It tells you Paperclip is more than a fixed REST app.

It is also a host runtime that loads extensible capabilities.

That is a major architectural signal.

## 11. Final API Mounting and API 404

Then:

```ts
app.use("/api", api);
app.use("/api", (_req, res) => {
  res.status(404).json({ error: "API route not found" });
});
```

This is small but clean.

It means:

- known API routes are centralized under `/api`
- unknown API paths still get a consistent JSON error instead of falling through into UI handling

That separation between API behavior and UI behavior is important.

## 12. Plugin UI Static Routes

Then:

```ts
app.use(pluginUiStaticRoutes(...));
```

This shows plugin UI assets are mounted outside the main API tree.

Again, `app.ts` is the file that decides the final HTTP shape.

## 13. UI Serving Modes

Now the file branches on `opts.uiMode`.

This is one of the most important high-level behaviors in `app.ts`.

## 13.1 Static UI mode

If `opts.uiMode === "static"`:

- it looks for built UI files
- applies branding to `index.html`
- serves static assets
- falls back to API-only mode if UI dist is missing

This is production-ish serving behavior.

## 13.2 Vite dev mode

If `opts.uiMode === "vite-dev"`:

- it creates a Vite server in middleware mode
- configures HMR host/port
- mounts Vite middleware into Express
- transforms `index.html` on request

This is development-time serving behavior.

So `app.ts` is the bridge between:

- backend API runtime
- frontend dev workflow

## 14. Final Error Handler

At the end:

```ts
app.use(errorHandler);
```

That placement is correct.

You want error handling after:

- middleware
- route mounting
- UI/static handling

so it can catch failures from the whole app stack.

## 15. Startup Side Effects After App Assembly

Even after most of the route tree is ready, the file still:

- starts plugin job coordination
- starts the plugin scheduler
- initializes tool dispatching
- loads ready plugins
- installs cleanup hooks

So `createApp(...)` is not only about assembling middleware and returning `app`.

It also bootstraps HTTP-adjacent host subsystems.

That is why this file is broader than a textbook Express example.

## 16. The Core Lesson

`app.ts` is where backend features become reachable.

Not just because routes are mounted, but because the file also decides:

- which guards run before routes
- which auth wiring exists
- which UI mode is served
- which plugin host capabilities are live

That is why this is one of the most important orientation files in the repo.

## Self-Check

- Why must `actorMiddleware(...)` run before route files are reached?
- Why is memory route mounting a good example of app-level dependency injection?
- What makes `app.ts` broader than a simple "register these routes" file?
