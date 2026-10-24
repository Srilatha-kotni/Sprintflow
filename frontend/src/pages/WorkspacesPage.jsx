import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import { useInterval } from "../hooks";
import { EmptyState, Spinner, TopBar } from "../components/ui";

export default function WorkspacesPage({ session, onOpen, notify, chrome }) {
  const { token } = session;
  const [workspaces, setWorkspaces] = useState(null);
  const [invites, setInvites] = useState([]);
  const [live, setLive] = useState({});
  const [busy, setBusy] = useState(null);

  const load = useCallback(async () => {
    try {
      const [ws, inv, meetings] = await Promise.all([
        api("/workspaces/mine", { token }),
        api("/workspaces/invitations", { token }),
        api("/meetings/active", { token }),
      ]);
      setWorkspaces(ws.workspaces);
      setInvites(inv.invitations);
      setLive(Object.fromEntries(meetings.meetings.map((m) => [m.workspace_id, m])));
    } catch (e) {
      notify("error", e.message);
    }
  }, [token, notify]);

  useEffect(() => { load(); }, [load]);
  useInterval(load, 15000);

  const respond = async (invite, action) => {
    setBusy(invite.id);
    try {
      const res = await api(`/workspaces/invitations/${invite.id}/${action}`, { token, method: "POST" });
      notify("success", res.message);
      await load();
    } catch (e) {
      notify("error", e.message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="page">
      <TopBar email={session.email} {...chrome} />
      <main className="container narrow">
        <div className="page-head"><div><h1>Your workspaces</h1><p className="muted-text">Pick a workspace to open your board.</p></div></div>

        {invites.length > 0 && (
          <div className="invites">
            {invites.map((inv) => (
              <div key={inv.id} className="invite">
                <span>📩 You're invited to <strong>{inv.workspace_name}</strong></span>
                <div className="invite-actions">
                  <button className="btn btn-ghost btn-sm" onClick={() => respond(inv, "reject")} disabled={busy === inv.id}>Decline</button>
                  <button className="btn btn-primary btn-sm" onClick={() => respond(inv, "accept")} disabled={busy === inv.id}>Join</button>
                </div>
              </div>
            ))}
          </div>
        )}

        {!workspaces ? (
          <div className="center-pad"><Spinner /></div>
        ) : workspaces.length === 0 ? (
          <EmptyState icon="👋" title="You're not in a workspace yet">
            Ask your admin to invite <strong>{session.email}</strong>. Invitations show up right here.
          </EmptyState>
        ) : (
          <div className="ws-grid">
            {workspaces.map((ws) => (
              <button key={ws.id} className="ws-tile" onClick={() => onOpen(ws)}>
                <div className="ws-tile-top">
                  <span className="ws-tile-name">{ws.name}</span>
                  {live[ws.id] && <span className="live-badge"><span className="live-dot" />Standup live</span>}
                </div>
                <span className="muted-text">{ws.member_count} member{ws.member_count === 1 ? "" : "s"}</span>
                <span className="ws-tile-open">Open board →</span>
              </button>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
