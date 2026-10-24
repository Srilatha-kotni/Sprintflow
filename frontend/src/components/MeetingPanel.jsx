import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import { useInterval } from "../hooks";
import { timeAgo } from "../lib";
import { Spinner } from "./ui";

const TYPE_ICON = { create: "＋", move: "→", delete: "✕", reassign: "⇄", update: "✎" };

const EXAMPLES = [
  "I finished the login page",
  "Bob, can you set up the CI pipeline by Friday?",
  "I'm starting on the API docs today",
  "Let's drop the dark mode ticket",
];

// A live standup: mic + typed notes in, and a feed of the board changes the AI made, with Undo.
export default function MeetingPanel({ meeting, token, notify, speech, isAdmin, onEnd, onChanged }) {
  const [activity, setActivity] = useState([]);
  const [waiting, setWaiting] = useState([]); // notes the AI hasn't processed yet
  const [note, setNote] = useState("");
  const [sending, setSending] = useState(false);
  const [busyId, setBusyId] = useState(null);
  const seen = useRef(null); // "id:status" of every entry we've already reacted to

  const load = useCallback(async () => {
    try {
      const data = await api(`/meetings/${meeting.id}/activity`, { token });
      const keys = data.activity.map((a) => `${a.id}:${a.status}`);
      if (seen.current) {
        const fresh = data.activity.filter((a) => !seen.current.has(`${a.id}:${a.status}`));
        fresh.filter((a) => a.status === "applied").forEach((a) => notify("success", a.summary));
        if (fresh.some((a) => a.status !== "skipped")) onChanged?.();
      }
      seen.current = new Set(keys);
      setActivity(data.activity);
      setWaiting(data.notes.filter((n) => !n.processed));
    } catch { /* keep the last state; next poll will retry */ }
  }, [meeting.id, token, notify, onChanged]);

  useEffect(() => { seen.current = null; load(); }, [load]);
  useInterval(load, 3000);

  const listening = speech.listeningTo === meeting.id;

  const sendNote = async (e) => {
    e.preventDefault();
    if (!note.trim()) return;
    setSending(true);
    try {
      await speech.send(meeting.id, note.trim());
      setNote("");
      load();
    } catch (err) {
      notify("error", err.message);
    } finally {
      setSending(false);
    }
  };

  const undo = async (entry) => {
    setBusyId(entry.id);
    try {
      const res = await api(`/meetings/${meeting.id}/activity/${entry.id}/undo`, { token, method: "POST" });
      notify("success", res.message);
      await load();
    } catch (err) {
      notify("error", err.message);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <section className="meeting">
      <div className="meeting-head">
        <div className="meeting-title">
          <span className="live-dot" aria-hidden="true" />
          <span className="live-label">LIVE</span>
          <strong>{meeting.title}</strong>
          {isAdmin && <span className="muted-text">· {meeting.workspace_name}</span>}
        </div>
        <div className="meeting-actions">
          <a className="btn btn-secondary btn-sm" href={meeting.jitsi_link} target="_blank" rel="noopener noreferrer">
            Join video call ↗
          </a>
          {isAdmin && <button className="btn btn-danger btn-sm" onClick={() => onEnd(meeting)}>End meeting</button>}
        </div>
      </div>

      <div className="meeting-grid">
        <div className="meeting-input">
          {speech.supported ? (
            <button
              className={`mic-btn ${listening ? "mic-on" : ""}`}
              onClick={() => (listening ? speech.stop() : speech.start(meeting.id))}
            >
              <span className="mic-icon" aria-hidden="true">{listening ? "■" : "🎤"}</span>
              <span>
                <strong>{listening ? "Listening… click to stop" : "Start voice notes"}</strong>
                <small>{listening ? "Keep this tab open while you talk" : "SprintFlow updates the board from what you say"}</small>
              </span>
            </button>
          ) : (
            <p className="hint-box">Voice notes need Chrome or Edge. You can still type updates below.</p>
          )}
          {listening && (
            <div className="interim">{speech.interim ? `“${speech.interim}”` : "Speak now…"}</div>
          )}
          <form className="note-form" onSubmit={sendNote}>
            <input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Or type an update, e.g. “I finished the login page”" />
            <button className="btn btn-primary" disabled={sending || !note.trim()}>{sending ? <Spinner small /> : "Send"}</button>
          </form>
        </div>

        <div className="feed">
          <div className="feed-title">Board changes from this meeting</div>
          {waiting.map((n) => (
            <div key={n.id} className="feed-item feed-waiting">
              <Spinner small />
              <div><div className="feed-quote">“{n.text}”</div><div className="feed-meta">Understanding…</div></div>
            </div>
          ))}
          {activity.length === 0 && waiting.length === 0 && (
            <div className="feed-empty">
              <p>Nothing yet. Talk normally and changes appear here. Try saying:</p>
              <ul>{EXAMPLES.map((x) => <li key={x}>“{x}”</li>)}</ul>
            </div>
          )}
          {[...activity].reverse().map((a) => (
            <div key={a.id} className={`feed-item feed-${a.status}`}>
              <span className={`feed-icon feed-icon-${a.type}`}>{a.status === "skipped" ? "–" : TYPE_ICON[a.type] || "•"}</span>
              <div className="feed-text">
                <div className="feed-summary">
                  {a.status === "skipped" && <span className="feed-skip-label">Not applied: </span>}
                  {a.summary}
                  {a.status === "undone" && <span className="feed-undone-label"> (undone)</span>}
                </div>
                <div className="feed-meta">“{a.quote}” — {a.speaker} · {timeAgo(a.created_at)}</div>
              </div>
              {a.status === "applied" && (
                <button className="btn btn-ghost btn-sm" onClick={() => undo(a)} disabled={busyId === a.id}>
                  {busyId === a.id ? <Spinner small /> : "Undo"}
                </button>
              )}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
