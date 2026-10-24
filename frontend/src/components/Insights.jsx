import { useMemo, useState } from "react";
import { api } from "../api";
import { COLUMNS, displayName } from "../lib";
import { Avatar, EmptyState, Markdown, Spinner } from "./ui";

const STATUS_COLOR = { created: "var(--col-todo)", pending: "var(--col-progress)", completed: "var(--col-done)", not_completed: "var(--col-notdone)" };

// Left-to-right map: tickets with no prerequisite on the left, each "waits for" arrow pointing right.
function DependencyMap({ tickets, columns }) {
  const W = 190, H = 54, GX = 56, GY = 14;
  const layout = useMemo(() => {
    const byId = Object.fromEntries(tickets.map((t) => [t.id, t]));
    const depthCache = {};
    const depth = (t, seen = new Set()) => {
      if (depthCache[t.id] !== undefined) return depthCache[t.id];
      const dep = byId[t.dependency];
      const d = dep && !seen.has(dep.id) ? depth(dep, new Set([...seen, t.id])) + 1 : 0;
      return (depthCache[t.id] = d);
    };
    const layers = [];
    tickets.forEach((t) => { (layers[depth(t)] ||= []).push(t); });
    const pos = {};
    layers.forEach((layer, x) => layer.forEach((t, y) => { pos[t.id] = { x: x * (W + GX), y: y * (H + GY) }; }));
    const rows = Math.max(...layers.map((l) => l.length));
    return { pos, width: layers.length * (W + GX) - GX, height: rows * (H + GY) - GY, byId };
  }, [tickets]);

  if (!tickets.some((t) => t.dependency)) {
    return <p className="muted-text">No ticket waits for another one yet. Set “Can't start until…” on a ticket to see the order here.</p>;
  }

  return (
    <div className="depmap-scroll">
      <svg width={layout.width + 4} height={layout.height + 4} className="depmap">
        <defs>
          <marker id="arrowhead" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
            <path d="M0,0 L8,4 L0,8 z" fill="var(--text-muted)" />
          </marker>
        </defs>
        {tickets.filter((t) => layout.pos[t.dependency]).map((t) => {
          const a = layout.pos[t.dependency], b = layout.pos[t.id];
          const x1 = a.x + W, y1 = a.y + H / 2, x2 = b.x - 4, y2 = b.y + H / 2;
          return <path key={t.id} d={`M${x1},${y1} C${x1 + GX / 2},${y1} ${x2 - GX / 2},${y2} ${x2},${y2}`} fill="none" stroke="var(--text-muted)" strokeWidth="1.5" markerEnd="url(#arrowhead)" />;
        })}
        {tickets.map((t) => {
          const p = layout.pos[t.id];
          const col = columns[t.id] || "created";
          const title = t.task.length > 24 ? `${t.task.slice(0, 23)}…` : t.task;
          return (
            <g key={t.id} transform={`translate(${p.x + 2},${p.y + 2})`}>
              <title>{`#${t.id} ${t.task}`}</title>
              <rect width={W} height={H} rx="10" fill="var(--bg-surface)" stroke={STATUS_COLOR[col]} strokeWidth="2" />
              <rect width="6" height={H} rx="3" fill={STATUS_COLOR[col]} />
              <text x="16" y="22" className="depmap-id">#{t.id} · {COLUMNS.find((c) => c.id === col).label}</text>
              <text x="16" y="40" className="depmap-title">{title}</text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

export default function Insights({ token, wsId, notify, tickets, columns, analytics, risks, setRisks, readOnly }) {
  const [standup, setStandup] = useState(null);
  const [riskSummary, setRiskSummary] = useState("");
  const [loading, setLoading] = useState("");

  const run = async (kind) => {
    setLoading(kind);
    try {
      if (kind === "standup") {
        const data = await api(`/ai/standup?workspace_id=${wsId}`, { token, method: "POST" });
        setStandup(data.summary);
      } else {
        const data = await api(`/ai/risk-analysis?workspace_id=${wsId}`, { token, method: "POST" });
        setRisks(data.risks || []);
        setRiskSummary(data.ai_summary || "");
        if (!data.risks?.length) notify("success", "No deadline risks found 🎉");
      }
    } catch (err) {
      notify("error", err.message);
    } finally {
      setLoading("");
    }
  };

  const total = analytics?.total_tickets || 0;

  return (
    <div className="insights">
      {analytics && total > 0 && (
        <div className="stats">
          <div className="stat"><span className="stat-value">{total}</span><span className="stat-label">Tickets in the team</span></div>
          <div className="stat"><span className="stat-value">{analytics.completion_pct}%</span><span className="stat-label">Done</span></div>
          <div className="stat"><span className="stat-value">{analytics.status.pending}</span><span className="stat-label">In progress</span></div>
          <div className="stat"><span className="stat-value">{analytics.status.created}</span><span className="stat-label">Not started</span></div>
        </div>
      )}

      {!readOnly && (
        <div className="ai-grid">
          <div className="panel">
            <div className="panel-head">
              <div><h3>Standup summary</h3><p className="muted-text">A written update of your board: done, in progress, blocked.</p></div>
              <button className="btn btn-primary" onClick={() => run("standup")} disabled={!!loading || !tickets.length}>
                {loading === "standup" ? <><Spinner small /> Writing…</> : standup ? "Regenerate" : "Write my standup"}
              </button>
            </div>
            {standup && <Markdown text={standup} />}
          </div>
          <div className="panel">
            <div className="panel-head">
              <div><h3>Deadline risks</h3><p className="muted-text">Finds tickets that are late, due soon or blocked, and marks them on the board.</p></div>
              <button className="btn btn-primary" onClick={() => run("risk")} disabled={!!loading || !tickets.length}>
                {loading === "risk" ? <><Spinner small /> Checking…</> : "Check risks"}
              </button>
            </div>
            {risks.length > 0 && (
              <ul className="risk-list">
                {risks.map((r) => (
                  <li key={r.ticket_id} className={`risk-row risk-${r.risk}`}>
                    <span className="risk-level">{r.risk}</span>
                    <span>#{r.ticket_id} {r.task}</span>
                    <span className="muted-text">{r.reason}</span>
                  </li>
                ))}
              </ul>
            )}
            {riskSummary && <Markdown text={riskSummary} />}
          </div>
        </div>
      )}

      {analytics?.team?.length > 0 && (
        <div className="panel">
          <h3>Team progress</h3>
          <div className="team-progress">
            {analytics.team.map((m) => (
              <div key={m.user_id} className="progress-row">
                <Avatar email={m.email} size={30} />
                <div className="progress-main">
                  <div className="progress-label">
                    <strong>{displayName(m.email)}</strong>
                    <span className="muted-text">{m.completed} of {m.total} done</span>
                  </div>
                  <div className="progress-track" title={`${m.completed} done · ${m.pending} in progress · ${m.created} to do`}>
                    {m.total > 0 && (
                      <>
                        <div style={{ width: `${(m.completed / m.total) * 100}%`, background: "var(--col-done)" }} />
                        <div style={{ width: `${(m.pending / m.total) * 100}%`, background: "var(--col-progress)" }} />
                      </>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
          <div className="legend">
            <span><i style={{ background: "var(--col-done)" }} />Done</span>
            <span><i style={{ background: "var(--col-progress)" }} />In progress</span>
            <span><i style={{ background: "var(--bg-inset)" }} />To do</span>
          </div>
        </div>
      )}

      <div className="panel">
        <h3>What waits for what</h3>
        {tickets.length ? <DependencyMap tickets={tickets} columns={columns} /> : <EmptyState title="No tickets yet" />}
      </div>
    </div>
  );
}
