# Evidence Templates by Task Kind

## `implementation` tasks (developer)

```json
{
  "artifactIds": ["art_code_xxx"],
  "filesModified": ["src/Foo.tsx", "src/Foo.test.tsx"],
  "testsPassed": true,
  "commandsRun": ["npm test", "npm run build"],
  "previewUrl": "http://localhost:3000"
}
```

## `acceptance_spec` / `service_validation` tasks (tester)

```json
{
  "artifactIds": ["art_qa_report_xxx"],
  "testsRun": ["E2E-login", "E2E-signup"],
  "testsPassed": true,
  "bugsFound": 0,
  "browserProbed": "chromium@headless"
}
```

## `technical_plan` tasks (cto)

```json
{
  "artifactIds": ["art_plan_xxx"],
  "tasksProposed": 5,
  "risksIdentified": ["db-migration-locks"],
  "estimateSprintDays": 2
}
```

## `distribution_campaign` tasks (marketing)

```json
{
  "artifactIds": ["art_campaign_xxx"],
  "channels": ["twitter", "linkedin"],
  "approvalRequested": true,
  "approvalId": "apr_xxx"
}
```
