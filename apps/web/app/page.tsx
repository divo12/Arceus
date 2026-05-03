"use client";

import { useState, useEffect, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { AgentNetworkVisual, MemoryTiersVisual, GovernanceVisual, EvolutionVisual } from "./feature-visuals";

const AUTH_KEY = "arceus_auth";

const HOW_IT_WORKS = [
  {
    step: "01",
    title: "Define your goal",
    body: "Write a product brief in plain language. Arceus handles the rest.",
  },
  {
    step: "02",
    title: "CEO plans the sprint",
    body: "The CEO agent breaks your goal into sprints and assigns work to the team.",
  },
  {
    step: "03",
    title: "Team builds & ships",
    body: "Developer writes code, Tester runs QA, Designer polishes — in a continuous heartbeat loop.",
  },
  {
    step: "04",
    title: "You govern",
    body: "Review decisions, approve proposals, and steer direction. No tickets, no standups.",
  },
] as const;

const EVOLUTION_PILLARS = [
  {
    label: "Pattern Detection",
    title: "Every task is a lesson",
    body: "After each task, agents extract execution vectors and cluster similar trajectories. Recurring patterns — same tool calls, same decision sequences — are automatically catalogued for habit candidacy.",
  },
  {
    label: "Habit Formation",
    title: "Patterns become instinct",
    body: "When a cluster hits 10 successful runs at 60%+ success rate, agents synthesize a habit: a trigger/action pair that loads at task start, cutting exploration overhead to zero.",
  },
  {
    label: "Skill Evolution",
    title: "Habits graduate to versioned skills",
    body: "Proven habits become governed, versioned skills. Agents propose mutations, dry-run them in isolation, pass them through automated review, and roll back failures — all without you lifting a finger.",
  },
] as const;

const FEATURES = [
  {
    label: "Autonomous Agents",
    title: "A full AI company, running 24/7",
    body: "CEO, CTO, PM, Developer, Tester, Designer — eight LLM-powered agents collaborating inside a heartbeat loop. They plan sprints, write code, run QA, and ship without you lifting a finger.",
    visual: <AgentNetworkVisual />,
  },
  {
    label: "Memory Engine",
    title: "Hippocampus: four-tier memory",
    body: "Static knowledge, dynamic context, procedural patterns, and priming signals. Agents remember what matters and forget the noise — so every decision is grounded, never hallucinated.",
    visual: <MemoryTiersVisual />,
  },
  {
    label: "Human Governance",
    title: "You're the board. Not the operator.",
    body: "Set goals, approve governance proposals, and read audit trails. The agents handle execution. Your job is to steer, not to manage tickets.",
    visual: <GovernanceVisual />,
  },
];

function LoginModal({
  onSuccess,
  onClose,
}: {
  onSuccess: () => void;
  onClose: () => void;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      if (res.ok) {
        localStorage.setItem(AUTH_KEY, "1");
        onSuccess();
      } else {
        const data = await res.json().catch(() => ({}));
        setError((data as { error?: string }).error ?? "Invalid email or password.");
      }
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      {/* Backdrop */}
      <div
        onClick={onClose}
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 200,
          backdropFilter: "blur(8px)",
          WebkitBackdropFilter: "blur(8px)",
          background: "rgba(0,0,0,0.35)",
        }}
      />

      {/* Modal */}
      <div
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 201,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "24px",
        }}
      >
        <div
          style={{
            background: "#ffffff",
            borderRadius: "16px",
            padding: "40px",
            width: "100%",
            maxWidth: "400px",
            boxShadow: "0 24px 64px rgba(0,0,0,0.18)",
          }}
        >
          {/* Logo */}
          <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "28px" }}>
            <svg viewBox="0 0 100 100" fill="currentColor" style={{ width: "20px", height: "20px" }}>
              <path d="M 39 18 C 34 22 24 18 19 11 C 14 16 8 30 7 50 C 8 70 14 84 19 89 C 24 82 34 78 39 82 C 42 72 38 60 40 50 C 38 40 42 28 39 18 Z" />
              <path d="M 61 18 C 66 22 76 18 81 11 C 86 16 92 30 93 50 C 92 70 86 84 81 89 C 76 82 66 78 61 82 C 58 72 62 60 60 50 C 62 40 58 28 61 18 Z" />
              <circle cx="50" cy="50" r="9" />
            </svg>
            <span style={{ fontWeight: 500, fontSize: "16px" }}>arceus</span>
          </div>

          <h2
            style={{
              fontFamily: "system-ui, -apple-system, 'SF Pro Rounded', sans-serif",
              fontSize: "22px",
              fontWeight: 500,
              marginBottom: "6px",
              color: "#000000",
            }}
          >
            Sign in
          </h2>
          <p style={{ fontSize: "14px", color: "#737373", marginBottom: "28px" }}>
            Enter your credentials to continue.
          </p>

          <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
            <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
              <label style={{ fontSize: "13px", fontWeight: 500, color: "#404040" }}>Email</label>
              <input
                type="email"
                value={email}
                onChange={(e) => { setEmail(e.target.value); setError(""); }}
                autoFocus
                style={{
                  padding: "10px 14px",
                  borderRadius: "8px",
                  border: "1px solid #d4d4d4",
                  fontSize: "15px",
                  outline: "none",
                  fontFamily: "inherit",
                }}
              />
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
              <label style={{ fontSize: "13px", fontWeight: 500, color: "#404040" }}>Password</label>
              <input
                type="password"
                value={password}
                onChange={(e) => { setPassword(e.target.value); setError(""); }}
                style={{
                  padding: "10px 14px",
                  borderRadius: "8px",
                  border: "1px solid #d4d4d4",
                  fontSize: "15px",
                  outline: "none",
                  fontFamily: "inherit",
                }}
              />
            </div>

            {error && (
              <p style={{ fontSize: "13px", color: "#dc2626", margin: 0 }}>{error}</p>
            )}

            <button
              type="submit"
              disabled={loading}
              style={{
                marginTop: "4px",
                background: "#000000",
                color: "#ffffff",
                border: "none",
                borderRadius: "9999px",
                padding: "12px",
                fontSize: "15px",
                fontWeight: 500,
                cursor: loading ? "not-allowed" : "pointer",
                opacity: loading ? 0.6 : 1,
                fontFamily: "inherit",
              }}
            >
              {loading ? "Signing in…" : "Sign in"}
            </button>
          </form>
        </div>
      </div>
    </>
  );
}

function LandingPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [showLogin, setShowLogin] = useState(false);
  const [pendingPath, setPendingPath] = useState("/home");
  const [isLoggedIn, setIsLoggedIn] = useState(false);

  useEffect(() => {
    const authed = localStorage.getItem(AUTH_KEY) === "1";
    setIsLoggedIn(authed);
    if (!authed && searchParams.get("login") === "1") {
      setShowLogin(true);
    }
  }, [searchParams]);

  function requireAuth(path: string) {
    if (isLoggedIn) {
      router.push(path);
    } else {
      setPendingPath(path);
      setShowLogin(true);
    }
  }

  function handleLoginSuccess() {
    setIsLoggedIn(true);
    setShowLogin(false);
    router.push(pendingPath);
  }

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "#ffffff",
        color: "#000000",
        fontFamily: "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
        fontSize: "16px",
        lineHeight: 1.5,
        WebkitFontSmoothing: "antialiased",
      }}
    >
      {showLogin && (
        <LoginModal
          onSuccess={handleLoginSuccess}
          onClose={() => setShowLogin(false)}
        />
      )}

      {/* ── Nav ── */}
      <nav
        style={{
          position: "sticky",
          top: 0,
          zIndex: 100,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "16px 40px",
          background: "rgba(255,255,255,0.95)",
          backdropFilter: "blur(12px)",
          borderBottom: "1px solid #e5e5e5",
        }}
      >
        <span
          style={{
            fontFamily: "system-ui, -apple-system, 'SF Pro Rounded', sans-serif",
            fontSize: "18px",
            fontWeight: 500,
            letterSpacing: "-0.3px",
            display: "flex",
            alignItems: "center",
            gap: "8px",
          }}
        >
          <svg
            viewBox="0 0 100 100"
            fill="currentColor"
            style={{ width: "22px", height: "22px" }}
          >
            <path d="M 39 18 C 34 22 24 18 19 11 C 14 16 8 30 7 50 C 8 70 14 84 19 89 C 24 82 34 78 39 82 C 42 72 38 60 40 50 C 38 40 42 28 39 18 Z" />
            <path d="M 61 18 C 66 22 76 18 81 11 C 86 16 92 30 93 50 C 92 70 86 84 81 89 C 76 82 66 78 61 82 C 58 72 62 60 60 50 C 62 40 58 28 61 18 Z" />
            <circle cx="50" cy="50" r="9" />
          </svg>
          arceus
        </span>

        <div style={{ display: "flex", gap: "32px", alignItems: "center" }}>
          {([["how it works", "#how-it-works"], ["features", "#features"]] as const).map(([label, href]) => (
            <a
              key={label}
              href={href}
              style={{ color: "#000000", fontSize: "16px", fontWeight: 400, textDecoration: "none" }}
            >
              {label}
            </a>
          ))}
          <button
            onClick={() => requireAuth("/home")}
            style={{
              background: "#000000",
              color: "#ffffff",
              padding: "10px 24px",
              borderRadius: "9999px",
              fontSize: "16px",
              fontWeight: 500,
              border: "none",
              cursor: "pointer",
              fontFamily: "inherit",
            }}
          >
            {isLoggedIn ? "Open app" : "Login"}
          </button>
        </div>
      </nav>

      {/* ── Hero ── */}
      <section
        style={{
          textAlign: "center",
          padding: "112px 40px 88px",
          maxWidth: "800px",
          margin: "0 auto",
        }}
      >
        <div
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "8px",
            background: "#f5f5f5",
            border: "1px solid #e5e5e5",
            borderRadius: "9999px",
            padding: "6px 16px",
            marginBottom: "40px",
            fontFamily: "ui-monospace, monospace",
            fontSize: "12px",
            color: "#737373",
            letterSpacing: "0.5px",
          }}
        >
          <span
            style={{
              width: "6px",
              height: "6px",
              borderRadius: "50%",
              background: "#22c55e",
              display: "inline-block",
            }}
          />
          AI company operating system
        </div>

        <h1
          style={{
            fontFamily: "system-ui, -apple-system, 'SF Pro Rounded', sans-serif",
            fontSize: "clamp(36px, 5vw, 56px)",
            fontWeight: 500,
            lineHeight: 1.05,
            letterSpacing: "-0.02em",
            marginBottom: "24px",
            color: "#000000",
          }}
        >
          Your AI company,<br />running autonomously
        </h1>

        <p
          style={{
            color: "#737373",
            fontSize: "18px",
            lineHeight: 1.6,
            marginBottom: "48px",
            maxWidth: "560px",
            margin: "0 auto 48px",
          }}
        >
          Arceus boots a team of LLM agents that plan sprints, write code, run QA,
          and ship — while you act as the board of directors.
        </p>

        <div style={{ display: "flex", gap: "12px", justifyContent: "center" }}>
          <button
            onClick={() => requireAuth("/home")}
            style={{
              background: "#000000",
              color: "#ffffff",
              padding: "12px 32px",
              borderRadius: "9999px",
              fontSize: "18px",
              fontWeight: 500,
              border: "none",
              cursor: "pointer",
              fontFamily: "inherit",
            }}
          >
            Start building
          </button>
          <button
            onClick={() => requireAuth("/dashboard")}
            style={{
              background: "#ffffff",
              color: "#404040",
              padding: "12px 32px",
              borderRadius: "9999px",
              fontSize: "18px",
              fontWeight: 400,
              border: "1px solid #d4d4d4",
              cursor: "pointer",
              fontFamily: "inherit",
            }}
          >
            View dashboard
          </button>
        </div>
      </section>

      {/* ── Centered statement ── */}
      <section
        style={{
          background: "#ffffff",
          padding: "120px 40px",
          textAlign: "center",
        }}
      >
        <h2
          style={{
            fontFamily: "Georgia, 'Times New Roman', serif",
            fontSize: "clamp(36px, 5vw, 62px)",
            fontWeight: 400,
            lineHeight: 1.1,
            letterSpacing: "-0.02em",
            color: "#111111",
            marginBottom: "24px",
          }}
        >
          From goal to{" "}
          <em style={{ fontStyle: "italic" }}>shipped</em>.
        </h2>
        <p
          style={{
            fontSize: "17px",
            color: "#737373",
            lineHeight: 1.7,
            maxWidth: "520px",
            margin: "0 auto",
          }}
        >
          Stop managing sprints. Start steering outcomes. Arceus runs the entire execution loop — planning, coding, testing, shipping — so you never have to.
        </p>
      </section>

      <hr style={{ border: "none", borderTop: "1px solid #e5e5e5", maxWidth: "1024px", margin: "0 auto" }} />

      {/* ── How it works ── */}
      <section
        id="how-it-works"
        style={{
          maxWidth: "1024px",
          margin: "0 auto",
          padding: "88px 40px",
        }}
      >
        <div style={{ marginBottom: "56px" }}>
          <div
            style={{
              fontFamily: "ui-monospace, monospace",
              fontSize: "12px",
              fontWeight: 400,
              textTransform: "uppercase",
              letterSpacing: "2px",
              color: "#737373",
              marginBottom: "12px",
            }}
          >
            How it works
          </div>
          <h2
            style={{
              fontFamily: "system-ui, -apple-system, 'SF Pro Rounded', sans-serif",
              fontSize: "30px",
              fontWeight: 500,
              lineHeight: 1.2,
              color: "#000000",
              maxWidth: "480px",
            }}
          >
            From goal to shipped product — without the management overhead
          </h2>
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(4, 1fr)",
            gap: "2px",
          }}
        >
          {HOW_IT_WORKS.map((s, i) => (
            <div
              key={s.step}
              style={{
                padding: "28px 24px",
                background: "#fafafa",
                border: "1px solid #e5e5e5",
                borderRadius: i === 0 ? "12px 0 0 12px" : i === HOW_IT_WORKS.length - 1 ? "0 12px 12px 0" : "0",
                marginLeft: i === 0 ? "0" : "-1px",
              }}
            >
              <div
                style={{
                  fontFamily: "ui-monospace, monospace",
                  fontSize: "11px",
                  fontWeight: 500,
                  color: "#a3a3a3",
                  marginBottom: "16px",
                  letterSpacing: "1px",
                }}
              >
                {s.step}
              </div>
              <div
                style={{
                  fontFamily: "system-ui, -apple-system, sans-serif",
                  fontSize: "15px",
                  fontWeight: 500,
                  color: "#000000",
                  marginBottom: "8px",
                  lineHeight: 1.3,
                }}
              >
                {s.title}
              </div>
              <p
                style={{
                  fontSize: "14px",
                  color: "#737373",
                  lineHeight: 1.6,
                  margin: 0,
                }}
              >
                {s.body}
              </p>
            </div>
          ))}
        </div>
      </section>

      <hr style={{ border: "none", borderTop: "1px solid #e5e5e5", maxWidth: "1024px", margin: "0 auto" }} />

      {/* ── Statement ── */}
      <section
        style={{
          maxWidth: "1024px",
          margin: "0 auto",
          padding: "100px 40px",
        }}
      >
        <div
          style={{
            fontFamily: "ui-monospace, monospace",
            fontSize: "11px",
            fontWeight: 500,
            textTransform: "uppercase",
            letterSpacing: "2.5px",
            color: "#a3a3a3",
            marginBottom: "20px",
          }}
        >
          Built for founders who move fast
        </div>
        <h2
          style={{
            fontFamily: "system-ui, -apple-system, 'SF Pro Rounded', sans-serif",
            fontSize: "clamp(40px, 5.5vw, 68px)",
            fontWeight: 500,
            lineHeight: 1.05,
            letterSpacing: "-0.025em",
            color: "#000000",
            maxWidth: "820px",
            marginBottom: "28px",
          }}
        >
          Set a goal. Ship a product.<br />Skip the team.
        </h2>
        <p
          style={{
            fontSize: "18px",
            color: "#737373",
            lineHeight: 1.65,
            maxWidth: "560px",
            margin: 0,
          }}
        >
          Arceus runs a full company of AI agents — they plan sprints, write code, run QA, and deploy — while you stay focused on what actually matters.
        </p>
      </section>

      <hr style={{ border: "none", borderTop: "1px solid #e5e5e5", maxWidth: "1024px", margin: "0 auto" }} />

      {/* ── Features ── */}
      <section
        id="features"
        style={{
          maxWidth: "1024px",
          margin: "0 auto",
          padding: "88px 40px",
        }}
      >
        <div style={{ marginBottom: "56px" }}>
          <div
            style={{
              fontFamily: "ui-monospace, monospace",
              fontSize: "12px",
              fontWeight: 400,
              textTransform: "uppercase",
              letterSpacing: "2px",
              color: "#737373",
              marginBottom: "12px",
            }}
          >
            Features
          </div>
          <h2
            style={{
              fontFamily: "system-ui, -apple-system, 'SF Pro Rounded', sans-serif",
              fontSize: "30px",
              fontWeight: 500,
              lineHeight: 1.2,
              color: "#000000",
              maxWidth: "480px",
            }}
          >
            Everything the company needs to run
          </h2>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: "24px" }}>
          {FEATURES.map((feature, i) => (
            <div
              key={feature.label}
              style={{
                display: "flex",
                flexDirection: i % 2 === 0 ? "row" : "row-reverse",
                alignItems: "center",
                gap: "0",
              }}
            >
              <div
                style={{
                  flex: "0 0 60%",
                  background: "#fafafa",
                  border: "1px solid #e5e5e5",
                  borderRadius: "14px",
                  padding: "40px",
                  display: "flex",
                  flexDirection: "column",
                  gap: "12px",
                }}
              >
                <div
                  style={{
                    fontFamily: "ui-monospace, monospace",
                    fontSize: "11px",
                    fontWeight: 400,
                    textTransform: "uppercase",
                    letterSpacing: "2px",
                    color: "#a3a3a3",
                  }}
                >
                  {String(i + 1).padStart(2, "0")} / {feature.label}
                </div>
                <h3
                  style={{
                    fontFamily: "system-ui, -apple-system, 'SF Pro Rounded', sans-serif",
                    fontSize: "20px",
                    fontWeight: 500,
                    lineHeight: 1.25,
                    color: "#000000",
                    margin: 0,
                  }}
                >
                  {feature.title}
                </h3>
                <p
                  style={{
                    fontSize: "14px",
                    color: "#737373",
                    lineHeight: 1.65,
                    margin: 0,
                  }}
                >
                  {feature.body}
                </p>
              </div>

              <div
                style={{
                  flex: "0 0 40%",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  padding: "24px",
                }}
              >
                {feature.visual}
              </div>
            </div>
          ))}
        </div>
      </section>

      <hr style={{ border: "none", borderTop: "1px solid #e5e5e5", maxWidth: "1024px", margin: "0 auto" }} />

      {/* ── Adaptive Intelligence ── */}
      <section
        id="evolution"
        style={{
          maxWidth: "1024px",
          margin: "0 auto",
          padding: "88px 40px",
        }}
      >
        <div style={{ marginBottom: "56px" }}>
          <div
            style={{
              fontFamily: "ui-monospace, monospace",
              fontSize: "12px",
              fontWeight: 400,
              textTransform: "uppercase",
              letterSpacing: "2px",
              color: "#737373",
              marginBottom: "12px",
            }}
          >
            Adaptive Intelligence
          </div>
          <h2
            style={{
              fontFamily: "system-ui, -apple-system, 'SF Pro Rounded', sans-serif",
              fontSize: "30px",
              fontWeight: 500,
              lineHeight: 1.2,
              color: "#000000",
              maxWidth: "520px",
            }}
          >
            Agents that get smarter every sprint
          </h2>
        </div>

        <div style={{ display: "flex", gap: "48px", alignItems: "center" }}>
          <div style={{ flex: "0 0 42%" }}>
            <EvolutionVisual />
          </div>

          <div style={{ flex: 1 }}>
            {EVOLUTION_PILLARS.map((p, i) => (
              <div
                key={p.label}
                style={{
                  padding: "24px",
                  background: "#fafafa",
                  border: "1px solid #e5e5e5",
                  borderRadius:
                    i === 0
                      ? "12px 12px 0 0"
                      : i === EVOLUTION_PILLARS.length - 1
                      ? "0 0 12px 12px"
                      : "0",
                  marginTop: i > 0 ? "-1px" : "0",
                }}
              >
                <div
                  style={{
                    fontFamily: "ui-monospace, monospace",
                    fontSize: "10px",
                    fontWeight: 500,
                    textTransform: "uppercase",
                    letterSpacing: "1.5px",
                    color: "#d97706",
                    marginBottom: "6px",
                  }}
                >
                  {p.label}
                </div>
                <div
                  style={{
                    fontFamily: "system-ui, -apple-system, sans-serif",
                    fontSize: "15px",
                    fontWeight: 500,
                    color: "#000000",
                    marginBottom: "6px",
                    lineHeight: 1.3,
                  }}
                >
                  {p.title}
                </div>
                <p
                  style={{
                    fontSize: "14px",
                    color: "#737373",
                    lineHeight: 1.6,
                    margin: 0,
                  }}
                >
                  {p.body}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <hr style={{ border: "none", borderTop: "1px solid #e5e5e5", maxWidth: "1024px", margin: "0 auto" }} />

      {/* ── CTA ── */}
      <section
        style={{
          textAlign: "center",
          padding: "88px 40px 112px",
        }}
      >
        <h2
          style={{
            fontFamily: "system-ui, -apple-system, 'SF Pro Rounded', sans-serif",
            fontSize: "clamp(28px, 4vw, 42px)",
            fontWeight: 500,
            lineHeight: 1.1,
            color: "#000000",
            marginBottom: "24px",
          }}
        >
          Ready to run your AI company?
        </h2>
        <p
          style={{
            color: "#737373",
            fontSize: "16px",
            lineHeight: 1.6,
            marginBottom: "40px",
          }}
        >
          Set a goal, meet your CEO agent, and watch the company take shape.
        </p>
        <button
          onClick={() => requireAuth("/home")}
          style={{
            background: "#000000",
            color: "#ffffff",
            padding: "12px 40px",
            borderRadius: "9999px",
            fontSize: "18px",
            fontWeight: 500,
            border: "none",
            cursor: "pointer",
            fontFamily: "inherit",
          }}
        >
          Start building
        </button>
      </section>

      {/* ── Footer ── */}
      <footer
        style={{
          borderTop: "1px solid #e5e5e5",
          padding: "24px 40px",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          maxWidth: "1024px",
          margin: "0 auto",
        }}
      >
        <span
          style={{
            fontFamily: "system-ui, -apple-system, sans-serif",
            fontSize: "14px",
            fontWeight: 500,
            color: "#000000",
          }}
        >
          arceus / co
        </span>
        <span
          style={{
            fontFamily: "ui-monospace, monospace",
            fontSize: "12px",
            color: "#a3a3a3",
          }}
        >
          v0.1 · AI company operating system
        </span>
      </footer>
    </div>
  );
}

export default function LandingPage() {
  return (
    <Suspense>
      <LandingPageInner />
    </Suspense>
  );
}
