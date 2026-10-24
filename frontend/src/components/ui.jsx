import { useEffect } from "react";
import { displayName, initial, renderMarkdown } from "../lib";

export function Spinner({ small }) {
  return <span className={`spinner ${small ? "spinner-sm" : ""}`} aria-hidden="true" />;
}

export function Toasts({ toasts, dismiss }) {
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.type}`} onClick={() => dismiss(t.id)}>
          <span className="toast-icon">{t.type === "success" ? "✓" : t.type === "error" ? "!" : "i"}</span>
          <span>{t.message}</span>
        </div>
      ))}
    </div>
  );
}

export function Modal({ title, onClose, children, footer, wide }) {
  useEffect(() => {
    const onKey = (e) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className={`modal ${wide ? "modal-wide" : ""}`} role="dialog" aria-modal="true" aria-label={title} onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-footer">{footer}</div>}
      </div>
    </div>
  );
}

export function ConfirmDialog({ request, close }) {
  if (!request) return null;
  return (
    <Modal
      title={request.title}
      onClose={() => close(false)}
      footer={
        <>
          <button className="btn btn-ghost" onClick={() => close(false)}>Cancel</button>
          <button className={`btn ${request.danger ? "btn-danger" : "btn-primary"}`} onClick={() => close(true)} autoFocus>
            {request.confirmLabel || "Confirm"}
          </button>
        </>
      }
    >
      <p className="muted-text">{request.message}</p>
    </Modal>
  );
}

export function Avatar({ email, size = 28, title }) {
  // Stable colour per person
  const hue = [...(email || "")].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 0);
  return (
    <span
      className="avatar"
      title={title || email}
      style={{ width: size, height: size, fontSize: size * 0.42, background: `hsl(${hue} 65% 55%)` }}
    >
      {initial(email)}
    </span>
  );
}

export function TopBar({ title, subtitle, onBack, email, onLogout, theme, toggleTheme, children }) {
  return (
    <header className="topbar">
      <div className="topbar-inner">
        <div className="topbar-left">
          {onBack ? (
            <button className="icon-btn back-btn" onClick={onBack} aria-label="Back to workspaces" title="All workspaces">←</button>
          ) : null}
          <div className="brand-block">
            <span className="brand">SprintFlow</span>
            {title && <span className="topbar-title">{title}</span>}
            {subtitle && <span className="topbar-subtitle">{subtitle}</span>}
          </div>
        </div>
        <div className="topbar-right">
          {children}
          <button className="icon-btn" onClick={toggleTheme} aria-label="Toggle dark mode" title="Toggle dark mode">
            {theme === "dark" ? "☀" : "☾"}
          </button>
          {email && (
            <div className="user-chip" title={email}>
              <Avatar email={email} size={26} />
              <span className="user-chip-name">{displayName(email)}</span>
            </div>
          )}
          <button className="btn btn-ghost btn-sm" onClick={onLogout}>Log out</button>
        </div>
      </div>
    </header>
  );
}

export function EmptyState({ icon, title, children, action }) {
  return (
    <div className="empty-state">
      {icon && <div className="empty-icon">{icon}</div>}
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}

export function Markdown({ text }) {
  return <div className="markdown" dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }} />;
}
