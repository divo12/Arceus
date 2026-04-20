---
name: workspace-probe-checklist
description: Before declaring a task complete with a preview URL, probe the preview and confirm it actually serves the new build.
role: developer
trigger: about to set preview URL or mark an implementation task complete
---

# Workspace Probe Checklist

A preview URL that 404s or shows the old build wastes the tester's next beat. Probe first.

1. Call `workspace_probe_preview({ url })`. It returns status, title, and a content hash.
2. **Status must be 200** — anything else means the preview is broken.
3. **Title / hash should have changed** from the previous beat if you modified UI-visible code. Compare against `beat_read_last_progress` if unsure.
4. If the probe returns `{ status: "error", cause: "connection_refused" }`, the dev server isn't running — start it via `bash` and retry.
5. Only after a clean probe: `task_set_preview_url(url)` + `task_complete`.

**Rule:** a preview URL in task evidence that returns non-200 is a blocker for the next QA beat. Better to block your own task with "preview not responding" than to hand a broken URL to the tester.
