export const COLUMNS = [
  { id: "created", label: "To Do", hint: "Not started yet" },
  { id: "pending", label: "In Progress", hint: "Being worked on" },
  { id: "completed", label: "Done", hint: "Finished" },
  { id: "not_completed", label: "Not Done", hint: "Dropped or couldn't finish" },
];

export const STATUS_LABEL = Object.fromEntries(COLUMNS.map((c) => [c.id, c.label]));

export const PRIORITIES = ["high", "medium", "low"];

// "alice123@gmail.com" -> "alice"
export function displayName(email = "") {
  const local = email.split("@")[0];
  return local.replace(/\d+$/, "") || local;
}

export function initial(email = "") {
  return (displayName(email)[0] || "?").toUpperCase();
}

function startOfDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

export function formatDate(iso) {
  if (!iso) return "";
  const [y, m, d] = iso.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }) });
}

// Human-friendly due date: { text: "Due in 3 days", tone: "overdue" | "soon" | "normal" }
export function dueInfo(iso, done) {
  if (!iso) return null;
  if (done) return { text: formatDate(iso), tone: "normal" };
  const [y, m, d] = iso.split("-").map(Number);
  const days = Math.round((new Date(y, m - 1, d) - startOfDay(new Date())) / 86400000);
  if (days < 0) return { text: `Overdue by ${-days} day${days === -1 ? "" : "s"}`, tone: "overdue" };
  if (days === 0) return { text: "Due today", tone: "overdue" };
  if (days === 1) return { text: "Due tomorrow", tone: "soon" };
  if (days <= 3) return { text: `Due in ${days} days`, tone: "soon" };
  return { text: `Due ${formatDate(iso)}`, tone: "normal" };
}

// Markdown -> HTML for AI text (escaped first, so it can't inject markup)
export function renderMarkdown(md) {
  return (md || "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/^#{3,}\s+(.+)$/gm, "<h4>$1</h4>")
    .replace(/^#{1,2}\s+(.+)$/gm, "<h3>$1</h3>")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/^\s*[-*]\s+(.+)$/gm, "<li>$1</li>")
    .replace(/^-{3,}$/gm, "<hr/>")
    .replace(/\n/g, "<br/>")
    .replace(/(<\/h[34]>|<\/li>|<hr\/>)<br\/>/g, "$1");
}

export function timeAgo(isoUtc) {
  if (!isoUtc) return "";
  const then = new Date(isoUtc.endsWith("Z") ? isoUtc : `${isoUtc}Z`);
  const mins = Math.round((Date.now() - then) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return then.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
