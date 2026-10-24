import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { useInterval, useSpeechNotes } from "../hooks";
import { displayName } from "../lib";
import Board from "../components/Board";
import GitHubModal from "../components/GitHubModal";
import Insights from "../components/Insights";
import MeetingPanel from "../components/MeetingPanel";
import TicketModal from "../components/TicketModal";
import { Avatar, EmptyState, Spinner, TopBar } from "../components/ui";

const toPayload = (t) => ({
  id: t.id, task: t.task, deadline: t.deadline || "", priority: t.priority || "medium", dependency: t.dependency || 0,
});

export default function WorkspacePage({ session, workspace, onBack, notify, confirm, chrome }) {
  const { token } = session;
  const wsId = workspace.id;

  const [members, setMembers] = useState([]);
  const [viewing, setViewing] = useState(null); // another member whose board we're looking at
  const [board, setBoard] = useState(null);
  const [analytics, setAnalytics] = useState(null);
  const [meeting, setMeeting] = useState(null);
  const [tab, setTab] = useState("board");
  const [editing, setEditing] = useState(undefined); // undefined = closed, null = new ticket, object = edit
  const [showGithub, setShowGithub] = useState(false);
  const [risks, setRisks] = useState([]);
  const [menuOpen, setMenuOpen] = useState(false);
  const speech = useSpeechNotes(token, notify);

  const loadBoard = useCallback(async () => {
    try {
      const data = await api(`/board?workspace_id=${wsId}${viewing ? `&user_id=${viewing.id}` : ""}`, { token });
      const columns = {};
      for (const [k, v] of Object.entries(data.columns || {})) columns[Number(k)] = v;
      setBoard({ tickets: data.tickets || [], columns, order: data.execution_order || [] });
    } catch (e) {
      notify("error", e.message);
    }
  }, [wsId, token, notify, viewing]);

  const loadAnalytics = useCallback(() => {
    api(`/ai/analytics?workspace_id=${wsId}`, { token }).then(setAnalytics).catch(() => {});
  }, [wsId, token]);

  const loadMeeting = useCallback(() => {
    api("/meetings/active", { token })
      .then((d) => setMeeting(d.meetings.find((m) => m.workspace_id === wsId) || null))
      .catch(() => {});
  }, [wsId, token]);

  const refresh = useCallback(() => { loadBoard(); loadAnalytics(); }, [loadBoard, loadAnalytics]);

  useEffect(() => {
    api(`/workspaces/${wsId}/members`, { token })
      .then((d) => setMembers(d.members))
      .catch((e) => {
        notify("error", e.message);
        if (e.status === 403 || e.status === 404) onBack(); // removed from the workspace, or it was deleted
      });
    loadAnalytics();
    loadMeeting();
  }, [wsId, token, notify, loadAnalytics, loadMeeting, onBack]);

  // Fetch whenever the viewed board changes (state is only set after the request resolves)
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { loadBoard(); }, [loadBoard]);

  const switchBoard = (member) => {
    setBoard(null);
    setRisks([]);
    setViewing(member);
  };

  // Pick up a standup the admin starts (or ends) without needing a refresh
  useInterval(loadMeeting, 10000);
  useEffect(() => { if (!meeting && speech.listeningTo) speech.stop(); }, [meeting, speech]);

  const readOnly = viewing !== null;
  const tickets = useMemo(() => board?.tickets || [], [board]);
  const columns = useMemo(() => board?.columns || {}, [board]);
  const riskMap = useMemo(() => Object.fromEntries(risks.map((r) => [r.ticket_id, r])), [risks]);

  // ─── Ticket changes (always applied to a fresh copy, so live meeting edits aren't overwritten) ───
  const saveTicketList = async (mutate) => {
    const fresh = await api(`/board?workspace_id=${wsId}`, { token });
    const list = mutate(fresh.tickets.map(toPayload));
    if (list.length) await api(`/tickets?workspace_id=${wsId}`, { token, method: "POST", body: { tickets: list } });
    else await api(`/board?workspace_id=${wsId}`, { token, method: "DELETE" });
  };

  const saveTicket = async (fields, status) => {
    const existing = editing;
    await saveTicketList((list) => {
      if (existing) return list.map((t) => (t.id === existing.id ? { ...t, ...fields } : t));
      return [...list, { id: Math.max(0, ...list.map((t) => t.id)) + 1, ...fields }];
    });
    setEditing(undefined);
    if (existing && status !== (columns[existing.id] || "created")) {
      try {
        await api(`/status?workspace_id=${wsId}`, { token, method: "POST", body: { task_id: existing.id, status } });
      } catch (e) {
        notify("error", `Saved, but couldn't change the status: ${e.message}`);
      }
    }
    notify("success", existing ? "Ticket updated" : "Ticket added");
    refresh();
  };

  const deleteTicket = async (ticket) => {
    const ok = await confirm({ title: "Delete this ticket?", message: `“${ticket.task}” will be removed from your board.`, confirmLabel: "Delete", danger: true });
    if (!ok) return;
    try {
      await saveTicketList((list) => list.filter((t) => t.id !== ticket.id).map((t) => (t.dependency === ticket.id ? { ...t, dependency: 0 } : t)));
      setEditing(undefined);
      notify("success", "Ticket deleted");
      refresh();
    } catch (e) {
      notify("error", e.message);
    }
  };

  const moveTicket = async (id, col) => {
    const ticket = tickets.find((t) => t.id === id);
    const dep = tickets.find((t) => t.id === ticket?.dependency);
    if (dep && ["pending", "completed"].includes(col) && columns[dep.id] !== "completed") {
      notify("error", `Finish #${dep.id} “${dep.task}” first. This ticket waits for it.`);
      return;
    }
    const before = columns[id];
    setBoard((b) => ({ ...b, columns: { ...b.columns, [id]: col } }));
    try {
      await api(`/status?workspace_id=${wsId}`, { token, method: "POST", body: { task_id: id, status: col } });
      loadAnalytics();
    } catch (e) {
      setBoard((b) => ({ ...b, columns: { ...b.columns, [id]: before } }));
      notify("error", e.message);
    }
  };

  const clearBoard = async () => {
    setMenuOpen(false);
    const ok = await confirm({ title: "Clear your whole board?", message: "All your tickets in this workspace will be permanently deleted.", confirmLabel: "Clear board", danger: true });
    if (!ok) return;
    try {
      await api(`/board?workspace_id=${wsId}`, { token, method: "DELETE" });
      notify("success", "Board cleared");
      refresh();
    } catch (e) {
      notify("error", e.message);
    }
  };

  // Suggested next steps: the AI's order, skipping finished and blocked tickets
  const upNext = useMemo(() => {
    const byId = Object.fromEntries(tickets.map((t) => [t.id, t]));
    return board?.order
      .map((id) => byId[id])
      .filter((t) => t && !["completed", "not_completed"].includes(columns[t.id]))
      .filter((t) => !t.dependency || !byId[t.dependency] || columns[t.dependency] === "completed")
      .slice(0, 3) || [];
  }, [board, tickets, columns]);

  const teammates = members.filter((m) => !m.is_admin);

  return (
    <div className="page">
      <TopBar title={workspace.name} onBack={onBack} email={session.email} {...chrome} />

      <main className="container">
        {meeting && (
          <MeetingPanel meeting={meeting} token={token} notify={notify} speech={speech} onChanged={refresh} />
        )}

        <div className="page-head">
          <div>
            <h1>{viewing ? `${displayName(viewing.email)}'s board` : "My board"}</h1>
            <p className="muted-text">
              {viewing ? "You can look, but only they can change it." : "Click a ticket to edit it, or drag it to another column."}
            </p>
          </div>
          {!readOnly && (
            <div className="page-actions">
              <button className="btn btn-secondary" onClick={() => setShowGithub(true)}>Sync from GitHub</button>
              <button className="btn btn-primary" onClick={() => setEditing(null)}>+ New ticket</button>
              <div className="menu-wrap">
                <button className="icon-btn" onClick={() => setMenuOpen(!menuOpen)} aria-label="More actions">⋯</button>
                {menuOpen && (
                  <div className="menu" onMouseLeave={() => setMenuOpen(false)}>
                    <button className="menu-item menu-danger" onClick={clearBoard}>Clear my board…</button>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {teammates.length > 1 && (
          <div className="people" role="tablist" aria-label="Whose board">
            {teammates.map((m) => {
              const active = m.is_current_user ? !viewing : viewing?.id === m.id;
              return (
                <button key={m.id} role="tab" aria-selected={active} className={`person ${active ? "person-active" : ""}`}
                  onClick={() => !active && switchBoard(m.is_current_user ? null : m)}>
                  <Avatar email={m.email} size={24} />
                  {m.is_current_user ? "Me" : displayName(m.email)}
                </button>
              );
            })}
          </div>
        )}

        <div className="tabs" role="tablist">
          <button role="tab" aria-selected={tab === "board"} className={`tab ${tab === "board" ? "tab-active" : ""}`} onClick={() => setTab("board")}>Board</button>
          <button role="tab" aria-selected={tab === "insights"} className={`tab ${tab === "insights" ? "tab-active" : ""}`} onClick={() => setTab("insights")}>Insights & AI</button>
        </div>

        {!board ? (
          <div className="center-pad"><Spinner /></div>
        ) : tab === "insights" ? (
          <Insights token={token} wsId={wsId} notify={notify} tickets={tickets} columns={columns}
            analytics={analytics} risks={risks} setRisks={setRisks} readOnly={readOnly} />
        ) : tickets.length === 0 ? (
          <EmptyState
            icon="🗂"
            title={readOnly ? "This board is empty" : "Your board is empty"}
            action={!readOnly && <button className="btn btn-primary" onClick={() => setEditing(null)}>+ Add your first ticket</button>}
          >
            {readOnly ? "They haven't added any tickets yet." : "Add a ticket, or join the next standup and just talk. Saying “I'll build the signup page” creates the ticket for you."}
          </EmptyState>
        ) : (
          <>
            {!readOnly && upNext.length > 0 && (
              <div className="up-next">
                <span className="up-next-label">Suggested next</span>
                {upNext.map((t, i) => (
                  <button key={t.id} className="up-next-item" onClick={() => setEditing(t)}>
                    <span className="up-next-num">{i + 1}</span>{t.task}
                  </button>
                ))}
              </div>
            )}
            <Board tickets={tickets} columns={columns} readOnly={readOnly} riskMap={riskMap}
              onOpen={(t) => setEditing(t)} onMove={moveTicket} />
          </>
        )}
      </main>

      {editing !== undefined && (
        <TicketModal
          key={editing?.id ?? "new"}
          ticket={editing}
          status={editing ? columns[editing.id] || "created" : "created"}
          tickets={tickets}
          readOnly={readOnly}
          onSave={saveTicket}
          onDelete={() => deleteTicket(editing)}
          onClose={() => setEditing(undefined)}
        />
      )}
      {showGithub && <GitHubModal token={token} wsId={wsId} notify={notify} onApplied={refresh} onClose={() => setShowGithub(false)} />}
    </div>
  );
}
