import { useState } from "react";
import { COLUMNS, PRIORITIES, STATUS_LABEL } from "../lib";
import { Modal, Spinner } from "./ui";

// Create or edit one ticket. `ticket` is null when creating.
export default function TicketModal({ ticket, status, tickets, readOnly, onSave, onDelete, onClose }) {
  const [task, setTask] = useState(ticket?.task || "");
  const [priority, setPriority] = useState((ticket?.priority || "medium").toLowerCase());
  const [deadline, setDeadline] = useState(ticket?.deadline || "");
  const [dependency, setDependency] = useState(ticket?.dependency || 0);
  const [newStatus, setNewStatus] = useState(status || "created");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const others = tickets.filter((t) => t.id !== ticket?.id);

  const save = async (e) => {
    e.preventDefault();
    if (!task.trim()) { setError("Give the ticket a title."); return; }
    setSaving(true);
    setError("");
    try {
      await onSave({ task: task.trim(), priority, deadline, dependency: Number(dependency) }, newStatus);
    } catch (err) {
      setError(err.message);
      setSaving(false);
    }
  };

  if (readOnly) {
    return (
      <Modal title={`#${ticket.id} ${ticket.task}`} onClose={onClose}>
        <dl className="details">
          <dt>Status</dt><dd>{STATUS_LABEL[status] || "To Do"}</dd>
          <dt>Priority</dt><dd className="capitalize">{ticket.priority || "medium"}</dd>
          <dt>Due</dt><dd>{ticket.deadline || "No due date"}</dd>
          <dt>Waits for</dt><dd>{ticket.dependency ? `#${ticket.dependency} ${tickets.find((t) => t.id === ticket.dependency)?.task || ""}` : "Nothing"}</dd>
        </dl>
      </Modal>
    );
  }

  return (
    <Modal
      title={ticket ? `Edit ticket #${ticket.id}` : "New ticket"}
      onClose={onClose}
      footer={
        <>
          {ticket && (
            <button type="button" className="btn btn-ghost btn-danger-text footer-left" onClick={onDelete} disabled={saving}>
              Delete ticket
            </button>
          )}
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button type="submit" form="ticket-form" className="btn btn-primary" disabled={saving}>
            {saving ? <><Spinner small /> Saving…</> : ticket ? "Save changes" : "Add ticket"}
          </button>
        </>
      }
    >
      <form id="ticket-form" className="form" onSubmit={save}>
        <label className="field">
          <span>What needs to be done?</span>
          <input className="input" value={task} onChange={(e) => setTask(e.target.value)} placeholder="e.g. Build the signup page" autoFocus />
        </label>

        {ticket && (
          <label className="field">
            <span>Status</span>
            <select className="input" value={newStatus} onChange={(e) => setNewStatus(e.target.value)}>
              {COLUMNS.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
            </select>
          </label>
        )}

        <div className="field">
          <span>Priority</span>
          <div className="segmented" role="radiogroup" aria-label="Priority">
            {PRIORITIES.map((p) => (
              <button type="button" key={p} role="radio" aria-checked={priority === p}
                className={`segment segment-${p} ${priority === p ? "segment-active" : ""}`} onClick={() => setPriority(p)}>
                {p}
              </button>
            ))}
          </div>
        </div>

        <div className="field-row">
          <label className="field">
            <span>Due date <em>(optional)</em></span>
            <input className="input" type="date" value={deadline} onChange={(e) => setDeadline(e.target.value)} />
          </label>
          <label className="field">
            <span>Can't start until… <em>(optional)</em></span>
            <select className="input" value={dependency} onChange={(e) => setDependency(Number(e.target.value))}>
              <option value={0}>Nothing, it can start anytime</option>
              {others.map((t) => <option key={t.id} value={t.id}>#{t.id} {t.task}</option>)}
            </select>
          </label>
        </div>

        {error && <div className="form-error">{error}</div>}
      </form>
    </Modal>
  );
}
