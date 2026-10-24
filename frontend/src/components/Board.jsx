import { useState } from "react";
import { COLUMNS, dueInfo } from "../lib";

function TicketCard({ ticket, column, blockedBy, risk, readOnly, onOpen, onDragStart, dragging }) {
  const due = dueInfo(ticket.deadline, column === "completed");
  const priority = (ticket.priority || "medium").toLowerCase();
  return (
    <button
      type="button"
      className={`card ${dragging ? "card-dragging" : ""} ${column === "completed" ? "card-done" : ""}`}
      draggable={!readOnly}
      onDragStart={(e) => {
        e.dataTransfer.setData("text/plain", String(ticket.id));
        e.dataTransfer.effectAllowed = "move";
        onDragStart(ticket.id);
      }}
      onClick={() => onOpen(ticket)}
      title={readOnly ? "View ticket" : "Click to edit, or drag to another column"}
    >
      <div className="card-top">
        <span className={`priority priority-${priority}`}>{priority}</span>
        <span className="card-id">#{ticket.id}</span>
      </div>
      <div className="card-title">{ticket.task || "Untitled"}</div>
      {(due || ticket.dependency > 0 || risk) && (
        <div className="card-meta">
          {due && <span className={`due due-${due.tone}`}>{due.text}</span>}
          {ticket.dependency > 0 && (
            <span className={`waits ${blockedBy ? "waits-blocked" : ""}`} title={blockedBy ? `Can't start until #${ticket.dependency} "${blockedBy.task}" is done` : `#${ticket.dependency} is done`}>
              {blockedBy ? "🔒" : "✓"} after #{ticket.dependency}
            </span>
          )}
          {risk && <span className="risk-tag" title={risk.reason}>⚠ {risk.reason}</span>}
        </div>
      )}
    </button>
  );
}

export default function Board({ tickets, columns, readOnly, riskMap = {}, onOpen, onMove }) {
  const [draggingId, setDraggingId] = useState(null);
  const [overCol, setOverCol] = useState(null);
  const byId = Object.fromEntries(tickets.map((t) => [t.id, t]));
  const colOf = (id) => columns[id] || "created";

  return (
    <div className="board" onDragEnd={() => { setDraggingId(null); setOverCol(null); }}>
      {COLUMNS.map((col) => {
        const items = tickets.filter((t) => colOf(t.id) === col.id);
        return (
          <section
            key={col.id}
            className={`column column-${col.id} ${overCol === col.id ? "column-over" : ""}`}
            onDragOver={(e) => { if (readOnly || draggingId === null) return; e.preventDefault(); setOverCol(col.id); }}
            onDragLeave={() => setOverCol(null)}
            onDrop={(e) => {
              e.preventDefault();
              setOverCol(null);
              const id = Number(e.dataTransfer.getData("text/plain"));
              setDraggingId(null);
              if (!readOnly && id && colOf(id) !== col.id) onMove(id, col.id);
            }}
          >
            <header className="column-header">
              <span className="column-dot" />
              <span className="column-title">{col.label}</span>
              <span className="column-count">{items.length}</span>
            </header>
            <div className="column-body">
              {items.length === 0 && <div className="column-empty">{readOnly ? "Nothing here" : col.hint}</div>}
              {items.map((t) => {
                const dep = t.dependency ? byId[t.dependency] : null;
                const blockedBy = dep && colOf(dep.id) !== "completed" ? dep : null;
                return (
                  <TicketCard
                    key={t.id}
                    ticket={t}
                    column={col.id}
                    blockedBy={blockedBy}
                    risk={riskMap[t.id]}
                    readOnly={readOnly}
                    onOpen={onOpen}
                    onDragStart={setDraggingId}
                    dragging={draggingId === t.id}
                  />
                );
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
}
