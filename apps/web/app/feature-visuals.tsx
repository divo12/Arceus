// Animated SVG visuals for landing page feature cards

export function AgentNetworkVisual() {
  const cx = 130, cy = 120, r = 82;
  const agents = [
    { name: "CEO",    angle: -90 },
    { name: "CTO",    angle: -30 },
    { name: "PM",     angle:  30 },
    { name: "Dev",    angle:  90 },
    { name: "Tester", angle: 150 },
    { name: "Design", angle: 210 },
  ].map((a, i) => ({
    ...a,
    i,
    x: cx + r * Math.cos((a.angle * Math.PI) / 180),
    y: cy + r * Math.sin((a.angle * Math.PI) / 180),
  }));

  return (
    <>
      <style>{`
        @keyframes agentNodePulse {
          0%, 100% { opacity: 0.2; }
          50%       { opacity: 1;   }
        }
      `}</style>
      <svg viewBox="0 0 260 240" style={{ width: "100%", height: "auto" }}>
        {agents.map((a) => (
          <line
            key={`l-${a.name}`}
            x1={cx} y1={cy} x2={a.x} y2={a.y}
            stroke="#dde5ff" strokeWidth="1.5" strokeDasharray="4 3"
          />
        ))}

        <circle cx={cx} cy={cy} r="16" fill="#e0e7ff" stroke="#a5b4fc" strokeWidth="1.5" />
        <circle cx={cx} cy={cy} r="6" fill="#6366f1">
          <animate attributeName="r"       values="6;9;6"   dur="2s" repeatCount="indefinite" />
          <animate attributeName="opacity" values="1;0.4;1" dur="2s" repeatCount="indefinite" />
        </circle>

        {agents.map((a) => (
          <g
            key={a.name}
            style={{ animation: `agentNodePulse 2.7s ${a.i * 0.45}s infinite ease-in-out` }}
          >
            <rect
              x={a.x - 24} y={a.y - 13} width="48" height="26" rx="13"
              fill="#eef2ff" stroke="#a5b4fc" strokeWidth="1.5"
            />
            <text
              x={a.x} y={a.y + 5}
              textAnchor="middle"
              fontSize="9"
              fontFamily="ui-monospace, monospace"
              fill="#4f46e5"
            >
              {a.name}
            </text>
          </g>
        ))}
      </svg>
    </>
  );
}

export function MemoryTiersVisual() {
  const tiers = [
    { name: "static",     pct: 88, color: "#10b981", delay: "0s"   },
    { name: "dynamic",    pct: 63, color: "#34d399", delay: "0.3s" },
    { name: "procedural", pct: 47, color: "#6ee7b7", delay: "0.6s" },
    { name: "priming",    pct: 76, color: "#059669", delay: "0.9s" },
  ];
  const trackX = 82, trackW = 155;

  return (
    <svg viewBox="0 0 260 200" style={{ width: "100%", height: "auto" }}>
      {tiers.map((t, i) => {
        const y = 22 + i * 44;
        const barW = (t.pct / 100) * trackW;
        return (
          <g key={t.name}>
            <text x="0" y={y + 11} fontSize="10" fontFamily="ui-monospace, monospace" fill="#525252">
              {t.name}
            </text>
            <rect x={trackX} y={y} width={trackW} height="20" rx="10" fill="#f0fdf4" />
            <rect x={trackX} y={y} height="20" rx="10" fill={t.color} opacity="0.85">
              <animate
                attributeName="width"
                values={`0;${barW};${barW};0`}
                keyTimes="0;0.3;0.8;1"
                dur="4s" begin={t.delay} repeatCount="indefinite"
              />
            </rect>
            <text x={trackX + trackW + 8} y={y + 11} fontSize="9" fontFamily="ui-monospace, monospace" fill="#a3a3a3">
              {t.pct}%
            </text>
          </g>
        );
      })}
    </svg>
  );
}

export function GovernanceVisual() {
  const stages = [
    { label: "Proposal", sub: "sprint 4", bg: "#f0f9ff", border: "#bae6fd", text: "#0369a1" },
    { label: "Review",   sub: "board",    bg: "#fffbeb", border: "#fcd34d", text: "#92400e" },
    { label: "Approved", sub: "✓ signed", bg: "#f0fdf4", border: "#86efac", text: "#15803d" },
  ];
  const xs = [43, 130, 217];

  return (
    <>
      <style>{`
        @keyframes govStagePulse {
          0%, 10%  { opacity: 0.2; }
          25%, 70% { opacity: 1;   }
          90%, 100%{ opacity: 0.2; }
        }
      `}</style>
      <svg viewBox="0 0 260 190" style={{ width: "100%", height: "auto" }}>
        <defs>
          <marker id="govArrow" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto">
            <path d="M0,0 L0,6 L8,3 Z" fill="#d4d4d4" />
          </marker>
        </defs>

        {[0, 1].map((i) => (
          <line
            key={i}
            x1={xs[i] + 36} y1={95}
            x2={xs[i + 1] - 36} y2={95}
            stroke="#e5e5e5" strokeWidth="1.5"
            markerEnd="url(#govArrow)"
          />
        ))}

        {stages.map((s, i) => (
          <g
            key={s.label}
            style={{ animation: `govStagePulse 3.6s ${i * 0.9}s infinite ease-in-out` }}
          >
            <rect
              x={xs[i] - 36} y={68} width="72" height="54" rx="10"
              fill={s.bg} stroke={s.border} strokeWidth="1.5"
            />
            <text x={xs[i]} y={92} textAnchor="middle" fontSize="10" fontFamily="system-ui, sans-serif" fontWeight="500" fill={s.text}>
              {s.label}
            </text>
            <text x={xs[i]} y={108} textAnchor="middle" fontSize="8.5" fontFamily="ui-monospace, monospace" fill="#a3a3a3">
              {s.sub}
            </text>
          </g>
        ))}
      </svg>
    </>
  );
}
