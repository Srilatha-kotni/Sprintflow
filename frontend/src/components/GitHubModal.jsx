import { useEffect, useState } from "react";
import { api } from "../api";
import { STATUS_LABEL } from "../lib";
import { Modal, Spinner } from "./ui";

// Connect a repo, let the AI match recent commits to tickets, then apply the chosen updates.
export default function GitHubModal({ token, wsId, notify, onApplied, onClose }) {
  const [status, setStatus] = useState(null);
  const [repo, setRepo] = useState("");
  const [pat, setPat] = useState("");
  const [busy, setBusy] = useState("");
  const [result, setResult] = useState(null);
  const [chosen, setChosen] = useState({});

  useEffect(() => {
    api("/github/status", { token })
      .then((s) => { setStatus(s); setRepo(s.repo || ""); })
      .catch((e) => notify("error", e.message));
  }, [token, notify]);

  const act = async (kind, fn) => {
    setBusy(kind);
    try { await fn(); } catch (e) { notify("error", e.message); } finally { setBusy(""); }
  };

  const connect = (e) => {
    e.preventDefault();
    act("connect", async () => {
      const res = await api("/github/connect", { token, method: "POST", body: { pat: pat.trim(), repo: repo.trim() } });
      setStatus({ connected: true, github_username: res.github_username, repo: res.repo });
      setPat("");
      notify("success", res.message);
    });
  };

  const analyze = () => act("analyze", async () => {
    const res = await api(`/github/analyze?workspace_id=${wsId}`, { token, method: "POST", body: { repo: repo.trim() || undefined } });
    setResult(res);
    setChosen(Object.fromEntries((res.matches || []).map((_, i) => [i, true])));
  });

  const apply = () => act("apply", async () => {
    const changes = result.matches.filter((_, i) => chosen[i]).map((m) => ({ ticket_id: m.ticket_id, new_status: m.suggested_status }));
    const res = await api(`/github/apply?workspace_id=${wsId}`, { token, method: "POST", body: { changes } });
    notify(res.skipped?.length ? "info" : "success", res.message);
    onApplied();
    onClose();
  });

  const disconnect = () => act("disconnect", async () => {
    await api("/github/disconnect", { token, method: "POST" });
    setStatus({ connected: false });
    setResult(null);
  });

  const selected = result ? result.matches.filter((_, i) => chosen[i]).length : 0;

  return (
    <Modal
      title="Update tickets from GitHub"
      onClose={onClose}
      wide
      footer={result?.matches?.length ? (
        <>
          <button className="btn btn-ghost" onClick={() => setResult(null)}>Back</button>
          <button className="btn btn-primary" onClick={apply} disabled={!selected || !!busy}>
            {busy === "apply" ? <><Spinner small /> Applying…</> : `Apply ${selected} update${selected === 1 ? "" : "s"}`}
          </button>
        </>
      ) : null}
    >
      {!status ? (
        <Spinner />
      ) : !status.connected ? (
        <form className="form" onSubmit={connect}>
          <p className="muted-text">SprintFlow reads your recent commits and suggests which tickets they finish or start.</p>
          <label className="field">
            <span>Repository</span>
            <input className="input" value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="owner/repo, e.g. octocat/hello-world" required />
          </label>
          <label className="field">
            <span>Personal access token</span>
            <input className="input" type="password" value={pat} onChange={(e) => setPat(e.target.value)} placeholder="ghp_…" required />
            <small className="muted-text">
              Create one at <a href="https://github.com/settings/tokens" target="_blank" rel="noopener noreferrer">github.com/settings/tokens</a>. Public repos need no scopes; private repos need “repo”.
            </small>
          </label>
          <button className="btn btn-primary" disabled={!!busy}>{busy === "connect" ? <><Spinner small /> Connecting…</> : "Connect GitHub"}</button>
        </form>
      ) : !result ? (
        <div className="form">
          <div className="connected-row">
            <span className="ok-dot" /> Connected as <strong>@{status.github_username}</strong>
            <button className="btn btn-ghost btn-sm" onClick={disconnect} disabled={!!busy}>Disconnect</button>
          </div>
          <label className="field">
            <span>Repository</span>
            <input className="input" value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="owner/repo" />
          </label>
          <button className="btn btn-primary" onClick={analyze} disabled={!!busy || !repo.trim()}>
            {busy === "analyze" ? <><Spinner small /> Reading the last 20 commits…</> : "Check recent commits"}
          </button>
        </div>
      ) : (
        <div className="form">
          {result.ai_summary && <p className="muted-text">{result.ai_summary}</p>}
          {result.matches.length === 0 ? (
            <p>None of the last {result.commits.length} commits match a ticket on your board.</p>
          ) : (
            <ul className="match-list">
              {result.matches.map((m, i) => (
                <li key={i}>
                  <label className="match">
                    <input type="checkbox" checked={!!chosen[i]} onChange={(e) => setChosen({ ...chosen, [i]: e.target.checked })} />
                    <div>
                      <div><strong>#{m.ticket_id} {m.ticket_task}</strong> → {STATUS_LABEL[m.suggested_status] || m.suggested_status}</div>
                      <div className="muted-text"><code>{m.commit_sha}</code> {m.commit_message}</div>
                      {m.reason && <div className="muted-text small">{m.reason}</div>}
                    </div>
                  </label>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Modal>
  );
}
