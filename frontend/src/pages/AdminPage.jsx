import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import { useInterval, useSpeechNotes } from "../hooks";
import { displayName } from "../lib";
import MeetingPanel from "../components/MeetingPanel";
import { Avatar, EmptyState, Markdown, Modal, Spinner, TopBar } from "../components/ui";

function WorkspaceCard({ ws, users, liveMeeting, token, notify, confirm, reload }) {
  const [invite, setInvite] = useState("");
  const [busy, setBusy] = useState("");
  const memberIds = new Set(ws.members.map((m) => m.id));
  const invitable = users.filter((u) => !u.is_admin && !memberIds.has(u.id));

  const act = async (kind, fn) => {
    setBusy(kind);
    try { await fn(); await reload(); } catch (e) { notify("error", e.message); } finally { setBusy(""); }
  };

  const sendInvite = (e) => {
    e.preventDefault();
    if (!invite.trim()) return;
    act("invite", async () => {
      const res = await api("/admin/invite", { token, method: "POST", body: { workspace_id: ws.id, user_email: invite.trim() } });
      notify("success", `${res.message}. They'll see it when they log in.`);
      setInvite("");
    });
  };

  const remove = async (m) => {
    if (!(await confirm({ title: `Remove ${displayName(m.email)}?`, message: `${m.email} will lose access to “${ws.name}”.`, confirmLabel: "Remove", danger: true }))) return;
    act(`remove-${m.id}`, async () => notify("success", (await api("/admin/remove-member", { token, method: "POST", body: { workspace_id: ws.id, user_id: m.id } })).message));
  };

  const del = async () => {
    if (!(await confirm({ title: `Delete “${ws.name}”?`, message: "Its boards, tickets, invitations and meetings are deleted for everyone. This can't be undone.", confirmLabel: "Delete workspace", danger: true }))) return;
    act("delete", async () => notify("success", (await api(`/admin/workspaces/${ws.id}`, { token, method: "DELETE" })).message));
  };

  const startMeeting = () => act("meet", async () => {
    await api("/admin/meetings/create", { token, method: "POST", body: { workspace_id: ws.id, title: "Daily Standup" } });
    notify("success", `Standup started. Members of “${ws.name}” see it on their board.`);
  });

  const team = ws.members.filter((m) => !users.find((u) => u.id === m.id)?.is_admin);

  return (
    <div className="ws-card">
      <div className="ws-card-head">
        <div>
          <h3>{ws.name}</h3>
          <span className="muted-text">{team.length} member{team.length === 1 ? "" : "s"}</span>
        </div>
        <div className="ws-card-actions">
          {liveMeeting ? (
            <span className="live-badge"><span className="live-dot" />Standup live</span>
          ) : (
            <button className="btn btn-primary btn-sm" onClick={startMeeting} disabled={!!busy || !team.length} title={team.length ? "" : "Invite someone first"}>
              {busy === "meet" ? <Spinner small /> : "▶ Start standup"}
            </button>
          )}
          <button className="icon-btn" onClick={del} disabled={!!busy} aria-label={`Delete ${ws.name}`} title="Delete workspace">🗑</button>
        </div>
      </div>

      <ul className="member-list">
        {team.length === 0 && <li className="muted-text">No members yet. Invite someone below.</li>}
        {team.map((m) => (
          <li key={m.id} className="member-row">
            <Avatar email={m.email} size={26} />
            <span className="member-email">{m.email}</span>
            <button className="btn btn-ghost btn-sm" onClick={() => remove(m)} disabled={!!busy}>Remove</button>
          </li>
        ))}
      </ul>

      <form className="inline-form" onSubmit={sendInvite}>
        <input className="input" type="email" list={`invite-${ws.id}`} value={invite} onChange={(e) => setInvite(e.target.value)} placeholder="Invite by email…" />
        <datalist id={`invite-${ws.id}`}>{invitable.map((u) => <option key={u.id} value={u.email} />)}</datalist>
        <button className="btn btn-secondary" disabled={!!busy || !invite.trim()}>{busy === "invite" ? <Spinner small /> : "Invite"}</button>
      </form>
    </div>
  );
}

function HistoryItem({ m, onDelete }) {
  const [open, setOpen] = useState(false);
  const applied = m.activity.filter((a) => a.status === "applied");
  return (
    <div className={`history ${open ? "history-open" : ""}`}>
      <button className="history-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="history-chevron">{open ? "▾" : "▸"}</span>
        <span className="history-title"><strong>{m.title}</strong> · {m.workspace_name}</span>
        <span className="muted-text">{m.ended_at ? new Date(`${m.ended_at}Z`).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : ""}</span>
        <span className="pill">{applied.length} board change{applied.length === 1 ? "" : "s"}</span>
      </button>
      {open && (
        <div className="history-body">
          {m.ai_summary && <><h4>Summary</h4><Markdown text={m.ai_summary} /></>}
          {m.activity.length > 0 && (
            <>
              <h4>Board changes</h4>
              <ul className="plain-list">
                {m.activity.map((a) => (
                  <li key={a.id} className={`history-change change-${a.status}`}>
                    {a.status === "skipped" ? "Not applied: " : ""}{a.summary}{a.status === "undone" ? " (undone)" : ""}
                  </li>
                ))}
              </ul>
            </>
          )}
          <h4>Transcript</h4>
          {m.transcript.length === 0 ? <p className="muted-text">Nobody added notes.</p> : (
            <ul className="transcript">
              {m.transcript.map((n, i) => <li key={i}><strong>{displayName(n.user)}</strong> <span className="muted-text">{n.time}</span> {n.text}</li>)}
            </ul>
          )}
          <button className="btn btn-ghost btn-sm btn-danger-text" onClick={() => onDelete(m)}>Delete from history</button>
        </div>
      )}
    </div>
  );
}

export default function AdminPage({ session, notify, confirm, chrome }) {
  const { token } = session;
  const [tab, setTab] = useState("workspaces");
  const [workspaces, setWorkspaces] = useState(null);
  const [users, setUsers] = useState([]);
  const [meetings, setMeetings] = useState([]);
  const [history, setHistory] = useState([]);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const [search, setSearch] = useState("");
  const [summary, setSummary] = useState(null);
  const speech = useSpeechNotes(token, notify);

  const load = useCallback(async () => {
    try {
      const [ws, us, ms, hist] = await Promise.all([
        api("/admin/workspaces", { token }), api("/admin/users", { token }),
        api("/admin/meetings", { token }), api("/admin/meetings/history", { token }),
      ]);
      setWorkspaces(ws.workspaces);
      setUsers(us.users);
      setMeetings(ms.meetings);
      setHistory(hist.meetings);
    } catch (e) {
      notify("error", e.message);
    }
  }, [token, notify]);

  useEffect(() => { load(); }, [load]);
  useInterval(load, 20000);

  const createWorkspace = async (e) => {
    e.preventDefault();
    if (!newName.trim()) return;
    setCreating(true);
    try {
      const res = await api("/admin/workspaces", { token, method: "POST", body: { name: newName.trim() } });
      notify("success", res.message);
      setNewName("");
      await load();
    } catch (err) {
      notify("error", err.message);
    } finally {
      setCreating(false);
    }
  };

  const endMeeting = async (m) => {
    if (!(await confirm({ title: "End this standup?", message: "SprintFlow will finish any pending notes and write a summary.", confirmLabel: "End meeting" }))) return;
    if (speech.listeningTo === m.id) speech.stop();
    try {
      const res = await api(`/admin/meetings/${m.id}/end`, { token, method: "POST" });
      setSummary({ ...res, title: m.title, workspace: m.workspace_name });
      await load();
    } catch (e) {
      notify("error", e.message);
    }
  };

  const deleteMeeting = async (m) => {
    if (!(await confirm({ title: "Delete this meeting?", message: "Its transcript and summary are removed from history. Board changes stay.", confirmLabel: "Delete", danger: true }))) return;
    try {
      await api(`/admin/meetings/${m.id}`, { token, method: "DELETE" });
      await load();
    } catch (e) {
      notify("error", e.message);
    }
  };

  const deleteUser = async (u) => {
    if (!(await confirm({ title: `Delete ${u.email}?`, message: "Their account and all their boards are deleted. This can't be undone.", confirmLabel: "Delete user", danger: true }))) return;
    try {
      notify("success", (await api(`/admin/users/${u.id}`, { token, method: "DELETE" })).message);
      await load();
    } catch (e) {
      notify("error", e.message);
    }
  };

  const liveByWs = Object.fromEntries(meetings.map((m) => [m.workspace_id, m]));
  const shownUsers = users.filter((u) => u.email.toLowerCase().includes(search.toLowerCase()));

  return (
    <div className="page">
      <TopBar title="Admin" email={session.email} {...chrome} />
      <main className="container">
        {meetings.map((m) => (
          <MeetingPanel key={m.id} meeting={m} token={token} notify={notify} speech={speech} isAdmin onEnd={endMeeting} />
        ))}

        <div className="tabs" role="tablist">
          {[["workspaces", "Workspaces"], ["meetings", `Meeting history${history.length ? ` (${history.length})` : ""}`], ["people", `People (${users.length})`]].map(([id, label]) => (
            <button key={id} role="tab" aria-selected={tab === id} className={`tab ${tab === id ? "tab-active" : ""}`} onClick={() => setTab(id)}>{label}</button>
          ))}
        </div>

        {!workspaces ? <div className="center-pad"><Spinner /></div> : tab === "workspaces" ? (
          <>
            <form className="create-row" onSubmit={createWorkspace}>
              <input className="input" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="New workspace name, e.g. Hackathon Team" />
              <button className="btn btn-primary" disabled={creating || !newName.trim()}>{creating ? <Spinner small /> : "+ Create workspace"}</button>
            </form>
            {workspaces.length === 0 ? (
              <EmptyState icon="🏗" title="No workspaces yet">Create one above, invite your team, then start a standup.</EmptyState>
            ) : (
              <div className="ws-card-grid">
                {workspaces.map((ws) => (
                  <WorkspaceCard key={ws.id} ws={ws} users={users} liveMeeting={liveByWs[ws.id]} token={token} notify={notify} confirm={confirm} reload={load} />
                ))}
              </div>
            )}
          </>
        ) : tab === "meetings" ? (
          history.length === 0 ? (
            <EmptyState icon="🗓" title="No finished meetings yet">Start a standup from a workspace card. When you end it, its summary and board changes show up here.</EmptyState>
          ) : (
            <div className="history-list">{history.map((m) => <HistoryItem key={m.id} m={m} onDelete={deleteMeeting} />)}</div>
          )
        ) : (
          <div className="panel">
            <input className="input" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search by email…" />
            <ul className="member-list">
              {shownUsers.map((u) => (
                <li key={u.id} className="member-row">
                  <Avatar email={u.email} size={26} />
                  <span className="member-email">{u.email}</span>
                  {u.is_admin ? <span className="pill">Admin</span> : <button className="btn btn-ghost btn-sm btn-danger-text" onClick={() => deleteUser(u)}>Delete</button>}
                </li>
              ))}
              {shownUsers.length === 0 && <li className="muted-text">Nobody matches “{search}”.</li>}
            </ul>
          </div>
        )}
      </main>

      {summary && (
        <Modal title={`${summary.title} · ${summary.workspace}`} onClose={() => setSummary(null)} wide
          footer={<button className="btn btn-primary" onClick={() => setSummary(null)}>Done</button>}>
          <p className="muted-text">{summary.notes_count} notes · {summary.actions_applied} board change{summary.actions_applied === 1 ? "" : "s"} made during the meeting</p>
          {summary.ai_summary ? <Markdown text={summary.ai_summary} /> : <p>Nobody added notes, so there's nothing to summarize.</p>}
        </Modal>
      )}
    </div>
  );
}
