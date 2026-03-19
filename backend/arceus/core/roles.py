"""Supported employee roles — the canonical catalog.

Both the CEO system prompt and the HierarchyService reference this
so proposals only contain roles the system can actually instantiate.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum


class RoleName(StrEnum):
    """Every role the system can instantiate."""
    CTO = "CTO"
    PM = "PM"
    FULL_STACK = "Full-stack Developer"
    BACKEND = "Backend Developer"
    FRONTEND = "Frontend Developer"
    ML_ENGINEER = "ML Engineer"
    DESIGNER = "Designer"
    DEVOPS = "DevOps Engineer"
    DATA_ENGINEER = "Data Engineer"
    QA_ENGINEER = "QA Engineer"


@dataclass(frozen=True, slots=True)
class Role:
    """Immutable definition of an employee role."""
    name: RoleName
    title: str
    level: int
    reports_to: RoleName | None  # None = reports to CEO
    description: str
    system_prompt: str

    @property
    def is_manager(self) -> bool:
        return self.level <= 1

    @property
    def reports_to_label(self) -> str:
        """Human-readable manager name ('CEO' when reports_to is None)."""
        return self.reports_to.value if self.reports_to else "CEO"

    @property
    def is_technical(self) -> bool:
        return self.name in (
            RoleName.CTO, RoleName.FULL_STACK, RoleName.BACKEND,
            RoleName.FRONTEND, RoleName.ML_ENGINEER, RoleName.DEVOPS,
            RoleName.DATA_ENGINEER, RoleName.QA_ENGINEER,
        )


# ── Role definitions ──────────────────────────────────────────────

CTO = Role(
    name=RoleName.CTO,
    title="Chief Technology Officer",
    level=1,
    reports_to=None,
    description="Technical architecture, stack decisions, engineering oversight",
    system_prompt=(
        "You are the CTO. You translate the CEO's strategic vision into technical architecture, "
        "choose the tech stack, and oversee all engineering work. You delegate to developers and engineers."
    ),
)

PM = Role(
    name=RoleName.PM,
    title="Product Manager",
    level=1,
    reports_to=None,
    description="User stories, backlog prioritization, product roadmap",
    system_prompt=(
        "You are the Product Manager. You break down the product vision into user stories and tasks, "
        "prioritize the backlog, and ensure the team builds the right thing. You work closely with the CTO and developers."
    ),
)

FULL_STACK = Role(
    name=RoleName.FULL_STACK,
    title="Full-stack Developer",
    level=2,
    reports_to=RoleName.CTO,
    description="End-to-end feature implementation: frontend, backend, DB, tests",
    system_prompt=(
        "You are a Full-stack Developer. You implement features end-to-end: frontend UI, backend APIs, "
        "database schemas, and tests. You follow the CTO's architecture decisions and PM's task priorities."
    ),
)

BACKEND = Role(
    name=RoleName.BACKEND,
    title="Backend Developer",
    level=2,
    reports_to=RoleName.CTO,
    description="APIs, services, database models, server-side logic",
    system_prompt=(
        "You are a Backend Developer. You build APIs, services, database models, and server-side logic. "
        "You follow the CTO's architecture decisions and write clean, tested code."
    ),
)

FRONTEND = Role(
    name=RoleName.FRONTEND,
    title="Frontend Developer",
    level=2,
    reports_to=RoleName.CTO,
    description="UI components, state management, UX implementation",
    system_prompt=(
        "You are a Frontend Developer. You build user interfaces, implement designs, handle state management, "
        "and ensure great UX. You work with the PM on requirements and the CTO on architecture."
    ),
)

ML_ENGINEER = Role(
    name=RoleName.ML_ENGINEER,
    title="ML Engineer",
    level=2,
    reports_to=RoleName.CTO,
    description="Model design, training, data pipelines, ML integration",
    system_prompt=(
        "You are an ML Engineer. You design, train, and deploy machine learning models. "
        "You handle data pipelines, model evaluation, and integration with the product."
    ),
)

DESIGNER = Role(
    name=RoleName.DESIGNER,
    title="UI/UX Designer",
    level=2,
    reports_to=RoleName.PM,
    description="UI/UX design, wireframes, prototypes, visual polish",
    system_prompt=(
        "You are a Designer. You create UI/UX designs, wireframes, and prototypes. "
        "You ensure the product is intuitive and visually polished."
    ),
)

DEVOPS = Role(
    name=RoleName.DEVOPS,
    title="DevOps Engineer",
    level=2,
    reports_to=RoleName.CTO,
    description="CI/CD, infrastructure, deployment, monitoring",
    system_prompt=(
        "You are a DevOps Engineer. You manage CI/CD pipelines, infrastructure, deployment, "
        "monitoring, and reliability. You ensure the system is stable and scalable."
    ),
)

DATA_ENGINEER = Role(
    name=RoleName.DATA_ENGINEER,
    title="Data Engineer",
    level=2,
    reports_to=RoleName.CTO,
    description="Data pipelines, ETL, warehousing, analytics infrastructure",
    system_prompt=(
        "You are a Data Engineer. You build data pipelines, ETL processes, and analytics infrastructure. "
        "You ensure data flows reliably from source to consumption."
    ),
)

QA_ENGINEER = Role(
    name=RoleName.QA_ENGINEER,
    title="QA Engineer",
    level=2,
    reports_to=RoleName.CTO,
    description="Testing strategy, test automation, quality assurance",
    system_prompt=(
        "You are a QA Engineer. You define testing strategy, write automated tests, "
        "and ensure code quality across the product."
    ),
)


# ── Catalog & helpers ─────────────────────────────────────────────

ALL_ROLES: tuple[Role, ...] = (
    CTO, PM, FULL_STACK, BACKEND, FRONTEND,
    ML_ENGINEER, DESIGNER, DEVOPS, DATA_ENGINEER, QA_ENGINEER,
)

ROLE_CATALOG: dict[str, Role] = {r.name.value: r for r in ALL_ROLES}
"""Lookup by role name string → Role object."""

SUPPORTED_ROLES: list[str] = [r.name.value for r in ALL_ROLES]
"""Flat list of supported role name strings (for validation)."""


def get_role(name: str) -> Role | None:
    """Get a Role by its string name."""
    return ROLE_CATALOG.get(name)


def roles_summary_for_prompt() -> str:
    """Generate a concise roles summary suitable for embedding in LLM system prompts."""
    lines = ["Available employee roles (ONLY propose from this list):"]
    for role in ALL_ROLES:
        manager = role.reports_to.value if role.reports_to else "CEO"
        lines.append(
            f"  - {role.name} (Level {role.level}, reports to {manager}): "
            f"{role.description}"
        )
    lines.append("")
    lines.append("Budget guidelines for team size:")
    lines.append("  - $200–$400: 2–3 employees (e.g. CTO + Full-stack Developer)")
    lines.append("  - $401–$800: 3–5 employees (e.g. CTO + PM + 2 Developers)")
    lines.append("  - $800+: 5–7 employees (e.g. CTO + PM + 3 Developers + Designer)")
    return "\n".join(lines)
