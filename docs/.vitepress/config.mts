import { defineConfig } from "vitepress";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const typedocSidebar = require("../reference/api/typedoc-sidebar.json");

export default defineConfig({
  title: "Arceus",
  description: "AI Company Operating System — Documentation",
  base: "/",
  themeConfig: {
    nav: [
      { text: "Guide", link: "/guide/overview" },
      { text: "Core Flows", link: "/flows/ceo-sprint" },
      { text: "Code Reference", link: "/reference/api/" },
      { text: "Specs", link: "/specs/" },
    ],
    sidebar: {
      "/guide/": [
        {
          text: "Guide",
          items: [
            { text: "Overview", link: "/guide/overview" },
            { text: "Architecture", link: "/guide/architecture" },
          ],
        },
      ],
      "/flows/": [
        {
          text: "Core Flows",
          items: [
            { text: "CEO Sprint Proposal", link: "/flows/ceo-sprint" },
            { text: "Task Assignment & Execution", link: "/flows/tasks" },
            { text: "Heartbeat Engine", link: "/flows/heartbeats" },
            { text: "Meeting Pipeline", link: "/flows/meetings" },
            { text: "Memory (Hippocampus)", link: "/flows/memory" },
            { text: "Preview Lifecycle", link: "/flows/preview" },
            { text: "Sprint Review & Verification", link: "/flows/sprint-review" },
            { text: "Execution Cycle", link: "/flows/execution-cycle" },
          ],
        },
      ],
      "/reference/": [
        {
          text: "API Reference",
          link: "/reference/api/",
          items: typedocSidebar,
        },
      ],
      "/specs/": [
        {
          text: "Specifications",
          items: [
            { text: "Index", link: "/specs/" },
            { text: "00 — System Architecture", link: "/specs/00-system-architecture" },
            { text: "01 — Onboarding to Kickoff", link: "/specs/01-onboarding-to-kickoff" },
            { text: "02 — Agent Execution", link: "/specs/02-agent-execution" },
            { text: "03 — Living Dashboard", link: "/specs/03-living-dashboard" },
            { text: "04 — Persistence", link: "/specs/04-persistence" },
            { text: "05a — Hippocampus Core", link: "/specs/05a-hippocampus-core" },
            { text: "05b — Hippocampus Intelligence", link: "/specs/05b-hippocampus-intelligence" },
            { text: "06 — Sprint Cycle", link: "/specs/06-sprint-cycle" },
            { text: "07 — Delegation & Memory", link: "/specs/07-delegation-memory" },
            { text: "08 — Product Storage", link: "/specs/08-product-storage" },
            { text: "09 — Product Verification", link: "/specs/09-product-verification" },
            { text: "10 — Budget & Cost Control", link: "/specs/10-budget-cost-control" },
            { text: "11 — Control Plane", link: "/specs/11-control-plane-sovereignty" },
            { text: "12 — Heartbeat Scheduling", link: "/specs/12-heartbeat-scheduling" },
            { text: "13 — Policy & Governance", link: "/specs/13-policy-governance-gateway" },
            { text: "13 — UI Redesign", link: "/specs/13-ui-redesign" },
            { text: "14 — Self-Evolution & Testing", link: "/specs/14-self-evolution-testing" },
            { text: "15 — Long-Horizon Execution", link: "/specs/15-long-horizon-execution" },
            { text: "18 — Automated Code Review", link: "/specs/18-automated-code-review" },
            { text: "18 — Meeting Pipeline", link: "/specs/18-meeting-pipeline" },
            { text: "21 — Sprint Verification QA", link: "/specs/21-sprint-verification-qa" },
            { text: "22 — Graph Execution Debug UI", link: "/specs/22-graph-execution-debug-ui" },
            { text: "23 — Skill Tool Integration", link: "/specs/23-skill-tool-integration" },
            { text: "24 — Agent Philosophy Refactor", link: "/specs/24-agent-philosophy-refactor" },
          ],
        },
      ],
    },
    socialLinks: [{ icon: "github", link: "https://github.com" }],
    search: { provider: "local" },
    outline: { level: [2, 3] },
  },
});
