# `server/src/config.ts`

This guide explains [`server/src/config.ts`](/Users/divyansh/Arceus/server/src/config.ts) as the first real backend startup file.

If you want one sentence first:

`config.ts` is the file that turns messy runtime inputs into one trusted typed config object.

## 1. Why This File Exists

At process start, the backend does not yet have a reliable idea of its own runtime settings.

It has scattered inputs like:

- environment variables
- optional config-file values
- default paths
- string flags like `"true"` or `"false"`
- enum-like mode strings such as `"authenticated"` or `"local_trusted"`

That is not a safe shape for the rest of startup to consume directly.

`config.ts` exists to do the cleanup step.

After `loadConfig()` finishes, later startup code should not have to keep asking:

- "was this value in env or config file?"
- "is this a valid mode string?"
- "does this path still need defaulting?"
- "is this timeout missing or malformed?"

It should just read the resolved `Config` object.

## 2. The File Has Four Jobs

Read the file as four responsibilities:

1. load `.env` files
2. define the runtime config shape
3. resolve small special cases like Hippocampus mode
4. merge all inputs into the final `Config`

That is the whole file.

## 3. Top Section: Loading `.env` Files

At the very top:

```ts
const PAPERCLIP_ENV_FILE_PATH = resolvePaperclipEnvPath();
...
const CWD_ENV_PATH = resolve(process.cwd(), ".env");
```

The file tries to load environment variables from two locations:

- Paperclip's own env path
- the current working directory's `.env`

### Why two locations?

Because the process may be started from different contexts:

- a packaged/runtime-specific location
- a repo working directory during development

So the file supports both a Paperclip-aware env location and a normal local `.env`.

### Why check `isSameFile`?

This part matters:

```ts
const isSameFile = ...
if (!isSameFile && existsSync(CWD_ENV_PATH)) {
  loadDotenv(...)
}
```

The file avoids loading the same env file twice if both paths point to the same real file.

That is a small detail, but it shows good startup hygiene.

The file is trying to be careful about:

- duplicated loading
- accidental overrides
- environment ambiguity

### Why `override: false`?

`dotenv` is called with `override: false`.

That means:

- already-defined env vars win
- file-loaded values do not stomp on real process env

That is the right priority order for most deployment systems.

## 4. Type Section: The Config Shape

Then the file defines:

```ts
type DatabaseMode = "embedded-postgres" | "postgres";
export type HippocampusMode = "off" | "embedded";
```

and then the big:

```ts
export interface Config { ... }
```

## 4.1 How to read `Config`

Do not read `Config` as one long list.

Read it in groups.

### Deployment and network shape

- `deploymentMode`
- `deploymentExposure`
- `host`
- `port`
- `allowedHostnames`

This group answers:

"How exposed is this server, and where does it bind?"

### Auth shape

- `authBaseUrlMode`
- `authPublicBaseUrl`
- `authDisableSignUp`

This group answers:

"How should auth URLs and signup behavior work in this deployment?"

### Database shape

- `databaseMode`
- `databaseUrl`
- `embeddedPostgresDataDir`
- `embeddedPostgresPort`

This group answers:

"Are we using external Postgres or embedded Postgres, and where?"

### Backup shape

- `databaseBackupEnabled`
- `databaseBackupIntervalMinutes`
- `databaseBackupRetentionDays`
- `databaseBackupDir`

This group answers:

"If backups are enabled, what policy should startup run with?"

### UI serving shape

- `serveUi`
- `uiDevMiddleware`

This group answers:

"Should this backend also serve the UI, and if so, how?"

### Secrets and storage shape

- `secretsProvider`
- `secretsStrictMode`
- `secretsMasterKeyFilePath`
- `storageProvider`
- `storageLocalDiskBaseDir`
- S3 settings

This group answers:

"Where do secrets and assets live?"

### Background/system services

- `heartbeatSchedulerEnabled`
- `heartbeatSchedulerIntervalMs`
- `companyDeletionEnabled`

This group answers:

"Which process-level behaviors are on?"

### Hippocampus runtime shape

- `hippocampusMode`
- `hippocampusPythonBin`
- `hippocampusStartupTimeoutMs`
- `hippocampusRequestTimeoutMs`

This group answers:

"Should the memory runtime exist, and how should the Node process talk to it?"

That grouping is important because it reveals what startup cares about.

## 5. Small Helper: `resolveHippocampusMode()`

This function is tiny:

```ts
export function resolveHippocampusMode(): HippocampusMode {
  const configured = process.env.PAPERCLIP_HIPPOCAMPUS_MODE?.trim().toLowerCase();
  if (configured === "off" || configured === "embedded") {
    return configured;
  }
  return "off";
}
```

But it is still worth noticing.

### What it does

It reads one env var, normalizes it, validates it against the supported values, and defaults safely to `"off"`.

### Why default to `"off"`?

Because Hippocampus is optional infrastructure.

At startup, the safe failure mode is:

- do not assume the Python memory runtime exists
- only enable it when explicitly configured

That is a good boot-time posture.

## 6. Main Function: `loadConfig()`

This is the heart of the file.

Read it as a merge pipeline, not as a random pile of assignments.

It is repeatedly doing the same pattern:

1. read from env if present
2. otherwise read from config file if present
3. otherwise fall back to a default
4. normalize into the right type

That pattern is almost the entire function.

## 6.1 First input: `readConfigFile()`

The function begins with:

```ts
const fileConfig = readConfigFile();
```

That means this file is not only env-based.

It also respects a structured config file and then lets env vars override it selectively.

That is the main source-merging strategy for the backend.

## 6.2 Database mode resolution

Early in the file:

```ts
const fileDatabaseMode =
  (fileConfig?.database.mode === "postgres" ? "postgres" : "embedded-postgres")
```

This is subtle:

- if the config file explicitly says `postgres`, use it
- otherwise default to `embedded-postgres`

That means local development naturally leans toward embedded Postgres unless external DB config is clearly provided.

Then:

```ts
const fileDbUrl =
  fileDatabaseMode === "postgres"
    ? fileConfig?.database.connectionString
    : undefined;
```

That prevents irrelevant DB URL usage when embedded mode is chosen.

## 6.3 Secrets provider resolution

This section is a good example of the whole file's design style.

It:

- checks env for provider
- validates against `SECRET_PROVIDERS`
- falls back to file config
- finally defaults to `"local_encrypted"`

This means later code can trust that `secretsProvider` is already one of the supported values.

It does not need to keep re-validating it.

## 6.4 Storage provider resolution

The storage section does the same thing for:

- provider selection
- local disk base dir
- S3 bucket/region/endpoint/prefix
- force-path-style behavior

Notice that local disk paths go through:

```ts
resolveHomeAwarePath(...)
```

That means path normalization is treated as part of config resolution, not as something to postpone.

That is a good pattern because path weirdness is a startup problem.

## 6.5 Deployment and auth resolution

This section is one of the most important parts of the file.

It resolves:

- deployment mode
- deployment exposure
- auth base URL mode
- public base URL
- signup disabling
- allowed hostnames

### Important subtle rule

This line matters:

```ts
const deploymentExposure: DeploymentExposure =
  deploymentMode === "local_trusted"
    ? "private"
    : ...
```

So even if some other input suggests otherwise, `local_trusted` forces private exposure.

That is not just config merging.

That is a startup invariant encoded during config resolution.

### Public URL hostname enrichment

Another subtle section:

```ts
const publicUrlHostname = authPublicBaseUrl ? ... new URL(...).hostname ... : null;
...
const allowedHostnames = Array.from(new Set([...]))
```

This means the config system automatically adds the public auth hostname to the allowed-hostnames set when possible.

That reduces the chance of auth + hostname configuration drifting apart.

## 6.6 Backup policy resolution

The backup section normalizes:

- enabled flag
- interval minutes
- retention days
- backup directory

Notice the use of `Math.max(...)`.

That means even if env/config values are malformed or too small, the file clamps them to sane minimums.

That is another example of startup protecting itself from bad inputs.

## 6.7 Final return object

The returned object is the payoff for the whole file.

At that point:

- ports are numbers
- booleans are booleans
- provider strings are validated
- paths are resolved
- mode decisions are finalized
- timeouts have minimum bounds

This is why other startup code can be simpler.

`index.ts` can call `loadConfig()` and move forward as if it has one coherent runtime contract.

## 7. The Real Design Lesson

This file is not "just configuration."

It is where the backend converts:

- uncertainty
- partial inputs
- optional files
- deployment differences

into certainty.

That is one of the most valuable startup jobs in the whole repo.

## 8. What To Remember

- `.env` loading is careful and layered
- the `Config` interface is grouped around actual runtime concerns
- `loadConfig()` is a repeated merge-and-normalize pipeline
- several startup invariants are encoded here, not later
- later files are simpler because this file does the cleanup first

## Self-Check

- Which values does this file allow env vars to override?
- Why does `local_trusted` force private exposure during config resolution?
- Why are path helpers and numeric clamps part of config loading instead of later startup code?
