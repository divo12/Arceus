import type { Task } from "@arceus/contracts";
import { productDir } from "../orchestration/state.js";
import { getLocalPreviewState } from "../workspace/preview.js";
import { resolveIncomingArtifacts } from "./artifacts.js";

export function buildSpecialistTaskPrompt(task: Task) {
  const preview = getLocalPreviewState();
  const profileHints = [
    `# Task`,
    `Role: ${task.assignedRole}`,
    `Title: ${task.title}`,
    `Description: ${task.description}`,
    `Problem statement: ${task.problemStatement}`,
    `Deliverable: ${task.deliverable}`,
    `Definition of done:`,
    ...task.definitionOfDone.map((item) => `- ${item}`),
    "",
    `# Company context`,
    `Workspace root: ${productDir}`,
    `Product workspace: ${productDir}`,
    `Current preview URL: ${preview.url ?? "not available"}`,
    `Current preview entry URL: ${preview.entryUrl ?? "not available"}`,
    `Current preview validation URL: ${preview.validationUrl ?? "not available"}`,
    `Current preview validation strategy: ${preview.validationStrategy ?? "not available"}`,
    `Current preview target kind: ${preview.targetKind ?? "not available"}`,
    `Current preview runtime: ${preview.runtime ?? "not available"}`,
    `Current preview framework: ${preview.framework ?? "not available"}`,
    `Current preview status: ${preview.status}`,
  ];

  if (task.assignedRole === "tester") {
    profileHints.push(
      "",
      "# Verification rules — YOU HAVE TOOLS, USE THEM",
      "Treat this as a verification assignment, not a build assignment.",
      "You are an agent with full tool access. You MUST:",
      "",
      "1. READ the actual source files in the product workspace using your file-read tools",
      `   - Start with the entry file (e.g. ${productDir}/src/App.tsx or equivalent)`,
      "   - Verify it IMPORTS and RENDERS the product-specific components",
      "   - If the entry file is scaffold boilerplate that doesn't import product modules, the task FAILS",
      "",
      "2. CHECK the import chain: entry file → components → data/lib modules",
      "   - Files existing on disk is NOT sufficient — they must be connected via imports",
      "",
      "3. If a preview URL is available, verify it serves actual product content",
      `   - Preview URL: ${preview.validationUrl ?? preview.entryUrl ?? preview.url ?? "not available"}`,
      "",
      "4. Produce a verdict with evidence from the files you actually read",
      "   - Cite specific file paths and import statements you verified",
      "   - Do NOT write a theoretical report — verify by reading actual code",
      "",
      "FAIL the task if: entry file doesn't import product modules, components are orphaned (exist but unused), or the product is scaffold-only.",
    );
  }

  if (task.assignedRole === "skills_lead") {
    profileHints.push(
      "",
      "# Skill authoring rules",
      "Turn repeated company execution patterns into reusable internal skill guidance.",
      "Make the output durable and operational: include trigger conditions, workflow steps, evidence expectations, and downstream consumers.",
      "Prefer skill content that can be applied by Developer, Tester, UI Designer, or Marketing in future cycles.",
    );
  }

  // Inject upstream artifacts from task's incomingArtifactIds.
  const upstreamContext = resolveIncomingArtifacts(task);
  if (upstreamContext.length > 0) {
    profileHints.push(...upstreamContext);
  }

  // ── Role-specific output requirements ──
  if (task.assignedRole === "pm") {
    profileHints.push(
      "",
      "# Output requirements — Product Manager",
      "You MUST produce a structured specification document, NOT a generic status update.",
      "Do NOT write vague prose like 'clarified scope'. Write the ACTUAL spec.",
      "Your output is the primary input for the Developer — if it's vague, the product will be wrong.",
      "",
      "Required sections (include ALL of these with CONCRETE content):",
      "",
      "## 1. User Stories",
      "Write 3–8 user stories in the format: 'As a [user], I want [action] so that [benefit]'.",
      "Each story MUST have numbered acceptance criteria (Given/When/Then or checkbox format).",
      "",
      "## 2. Functional Requirements",
      "List every feature the developer must implement. Be specific:",
      "- BAD: 'Users can manage notes'",
      "- GOOD: 'Users can create a new note with a title (max 200 chars) and body (Markdown supported). Notes persist across page reloads via localStorage. Each note has a created_at timestamp.'",
      "",
      "## 3. UI/UX Requirements",
      "Describe the screens/views, layout structure, key interactions, and navigation flow.",
      "Name specific components (sidebar, note list, editor pane, tag picker, etc.).",
      "",
      "## 4. Non-functional Requirements",
      "Performance targets, browser support, accessibility level, data persistence strategy.",
      "",
      "## 5. Out of Scope (Non-goals)",
      "Explicitly list what is NOT part of this sprint.",
      "",
      "## 6. Definition of Done",
      "Measurable checklist of what 'done' means for the developer.",
      "",
      "# IMPORTANT: Write your spec to disk",
      `After producing the spec, write it as a Markdown file to ${productDir}/docs/pm-acceptance-spec.md using your file tools.`,
      "This ensures the developer and other agents can read it directly from the workspace.",
    );
  } else if (task.assignedRole === "ui_designer") {
    profileHints.push(
      "",
      "# Output requirements — UI Designer",
      "You MUST produce actionable design specifications that a developer can directly implement.",
      "Do NOT write vague prose like 'designed intuitive layouts'. Provide EXACT specs.",
      "",
      "Required sections (include ALL with CONCRETE values):",
      "",
      "## 1. Layout Structure",
      "Describe the page layout using CSS terms: grid template, flex direction, sidebar width, main content area.",
      "Example: 'Two-column layout: fixed 260px sidebar on left, flexible main area. Sidebar has logo area (64px height), search input, folder list, tag cloud.'",
      "",
      "## 2. Component Hierarchy",
      "List every React component the developer should create, with props and children:",
      "- AppShell → Sidebar + MainContent",
      "- Sidebar → SearchInput + FolderList + TagCloud",
      "- MainContent → NoteListHeader + NoteList | NoteEditor",
      "- NoteEditor → TitleInput + MarkdownEditor + TagPicker",
      "",
      "## 3. Design Tokens",
      "Provide EXACT values the developer must use:",
      "- Colors: background, surface, text-primary, text-secondary, accent, border (hex codes)",
      "- Typography: font-family, size scale (h1–body–caption), line heights, weights",
      "- Spacing: base unit (e.g. 8px), padding/margin for key elements",
      "- Border radius, shadow values",
      "- Breakpoints for responsive behavior",
      "",
      "## 4. Component States",
      "For each interactive component, specify: default, hover, active, focus, disabled, loading, empty, error states.",
      "",
      "## 5. Interactions & Animations",
      "Describe transitions, hover effects, and micro-interactions with duration and easing.",
      "Example: 'Note list item: hover scales to 1.01 with 150ms ease-out, background shifts to surface-hover color.'",
      "",
      "## 6. Responsive Behavior",
      "How does the layout adapt at mobile (<640px), tablet (640–1024px), and desktop (>1024px)?",
    );
  } else if (task.assignedRole === "marketing") {
    profileHints.push(
      "",
      "# Output requirements — Marketing",
      "Return a concise execution artifact with these sections:",
      "1. Target audience and messaging strategy",
      "2. Concrete deliverables produced (copy, assets, channel plans)",
      "3. Key messages and value propositions",
      "4. Distribution channels and timeline",
      "5. Success metrics and next steps",
    );
  } else {
    profileHints.push(
      "",
      "# Output requirements",
      "Return a concise execution artifact with these sections:",
      "1. Objective alignment",
      "2. What you did (be specific — name files, tools, concrete actions)",
      "3. Evidence or concrete results",
      "4. Open issues or blockers",
      "5. Recommendation for next steps",
    );
  }

  return profileHints.join("\n");
}
