"""
Turn things said in a live meeting into board actions.

Every note is sent to the AI together with the team and their boards. The AI returns
actions (create / move / delete / reassign / update), which are validated and applied here.
Each applied action stores before/after snapshots of the tickets it touched, so it can be undone.
"""
import copy
import json
import re
import threading
import uuid
from datetime import datetime, timedelta

from bson import ObjectId

from app.database import boards_collection, meetings_collection, users_collection, workspaces_collection
from app.llm.mistral_client import generate
from app.services.dependency_service import VALID_STATUSES, dependency_blocker

PRIORITIES = ("high", "medium", "low")
STATUS_LABELS = {"created": "Created", "pending": "In Progress", "completed": "Completed", "not_completed": "Not Completed"}

# One lock per workspace: notes are processed in the background and must not
# read-modify-write the same boards at the same time.
_locks = {}
_locks_guard = threading.Lock()


def workspace_lock(workspace_id):
    with _locks_guard:
        return _locks.setdefault(workspace_id, threading.Lock())


class Skip(Exception):
    """An action that was understood but can't be applied (the reason is shown to the team)."""


# ─── Team + boards ───────────────────────────────────────────────────────────

def display_name(email):
    return re.sub(r"\d+$", "", email.split("@")[0]) or email.split("@")[0]


def load_team(workspace_id):
    """Return {user_id: {"name", "email", "is_admin"}} with unique display names."""
    workspace = workspaces_collection.find_one({"_id": ObjectId(workspace_id)})
    team = {}
    for uid in workspace.get("members", []):
        u = users_collection.find_one({"_id": ObjectId(uid)})
        if u:
            team[uid] = {"name": display_name(u["email"]), "email": u["email"], "is_admin": bool(u.get("is_admin"))}
    # Fall back to the full email prefix when two people would share a name
    names = [m["name"] for m in team.values()]
    for m in team.values():
        if names.count(m["name"]) > 1:
            m["name"] = m["email"].split("@")[0]
    return team


def get_board(workspace_id, user_id):
    board = boards_collection.find_one({"workspace_id": workspace_id, "user_id": user_id}, {"_id": 0})
    board = board or {"workspace_id": workspace_id, "user_id": user_id}
    board.setdefault("tickets", [])
    board.setdefault("columns", {})
    board.setdefault("execution_order", [])
    return board


def save_board(board):
    boards_collection.update_one(
        {"workspace_id": board["workspace_id"], "user_id": board["user_id"]},
        {"$set": board},
        upsert=True,
    )


def find_ticket(board, ticket_id):
    return next((t for t in board["tickets"] if t["id"] == ticket_id), None)


def snapshot(board, ticket_id):
    ticket = find_ticket(board, ticket_id)
    return {
        "user_id": board["user_id"],
        "ticket_id": ticket_id,
        "ticket": copy.deepcopy(ticket),
        "column": board["columns"].get(str(ticket_id)) if ticket else None,
    }


def restore(workspace_id, snap):
    """Put one ticket back exactly as it was in `snap` (or remove it if it didn't exist)."""
    board = get_board(workspace_id, snap["user_id"])
    tid = snap["ticket_id"]
    board["tickets"] = [t for t in board["tickets"] if t["id"] != tid]
    board["columns"].pop(str(tid), None)
    board["execution_order"] = [i for i in board["execution_order"] if i != tid]
    if snap["ticket"]:
        board["tickets"].append(copy.deepcopy(snap["ticket"]))
        board["tickets"].sort(key=lambda t: t["id"])
        board["columns"][str(tid)] = snap["column"] or "created"
        board["execution_order"].append(tid)
    save_board(board)


# ─── AI extraction ───────────────────────────────────────────────────────────

def build_prompt(team, boards, speaker_id, text, earlier_notes, done_summaries):
    today = datetime.now().strftime("%Y-%m-%d (%A)")
    member_lines, board_lines = [], []
    for uid, m in team.items():
        role = "facilitator, has no board, never assign work to them" if m["is_admin"] else "team member"
        member_lines.append(f"- {m['name']} ({role})")
        if m["is_admin"]:
            continue
        tickets = boards[uid]["tickets"]
        board_lines.append(f"{m['name']}'s board:" if tickets else f"{m['name']}'s board: (empty)")
        for t in tickets:
            col = boards[uid]["columns"].get(str(t["id"]), "created")
            extra = f", due {t['deadline']}" if t.get("deadline") else ""
            extra += f", depends on #{t['dependency']}" if t.get("dependency") else ""
            board_lines.append(f'  #{t["id"]} "{t["task"]}" [{col}] ({t.get("priority") or "medium"}{extra})')

    speaker = team[speaker_id]["name"]
    earlier = "\n".join(f"{team.get(n['user_id'], {}).get('name', '?')}: {n['text']}" for n in earlier_notes) or "(none)"
    done = "\n".join(f"- {s}" for s in done_summaries) or "(none)"

    return f"""You turn what people say in a live standup meeting into actions on their task boards.

Today is {today}.

Team (use these exact names):
{chr(10).join(member_lines)}

Current boards (ticket ids are per board):
{chr(10).join(board_lines)}

Earlier in this meeting (context only, already handled):
{earlier}

Board changes already made in this meeting:
{done}

NEW note from {speaker}:
"{text}"

Return the actions that the NEW note asks for. Action formats:
- {{"type": "create", "assignee": NAME, "task": "short imperative title", "priority": "high|medium|low", "deadline": DUE}}
- {{"type": "move", "owner": NAME, "ticket_id": N, "status": "created|pending|completed|not_completed"}}
- {{"type": "delete", "owner": NAME, "ticket_id": N}}
- {{"type": "reassign", "owner": NAME, "ticket_id": N, "assignee": NAME}}
- {{"type": "update", "owner": NAME, "ticket_id": N, "priority": "high|medium|low", "deadline": DUE}} (include only the fields that change)
Add "quote" to every action: the exact words from the note that triggered it.
DUE is the due date exactly as spoken, without "by"/"on": e.g. "Friday", "next Monday", "tomorrow", "November 15", "end of week". Use "" if no date was said. Do not convert it yourself.

Rules:
- "I", "me", "my" mean {speaker}.
- New work someone commits to ("I'll…", "I'm going to…", "next I…") or is asked to do ("Bob, can you…", "Alice will handle…") -> create on that person's board. If a matching ticket already exists on their board, don't create a duplicate.
- Finished / done / completed / merged / shipped -> move to completed. Started / working on / picking up -> move to pending. Couldn't finish / blocked / giving up for now -> move to not_completed.
- "Almost done", "nearly finished", "still working on", "will finish today" mean the work is NOT finished -> pending (or nothing if it's already pending). Only move to completed when the speaker says it IS finished.
- Only delete when someone clearly says to remove, drop, cancel or delete a ticket.
- "X, take over Y from me" or "move Y to X" -> reassign.
- Match tickets by meaning, not exact wording, and only use ticket ids that exist on that owner's board.
- If the work mentioned matches no ticket on that person's board, do nothing. Never pick a different, unrelated ticket.
- Greetings, small talk and updates that match no ticket -> no actions.
- One note often contains several updates. Return one action for EACH of them.

Examples (for a speaker named sam whose board has #1 "Build signup page" [created] and #2 "Write tests" [created]):
- "I wrapped up the signup page and I'm starting the tests now" ->
  {{"actions": [{{"type": "move", "owner": "sam", "ticket_id": 1, "status": "completed", "quote": "I wrapped up the signup page"}},
               {{"type": "move", "owner": "sam", "ticket_id": 2, "status": "pending", "quote": "I'm starting the tests now"}}]}}
- "I'm nearly done with the signup page" ->
  {{"actions": [{{"type": "move", "owner": "sam", "ticket_id": 1, "status": "pending", "quote": "I'm nearly done with the signup page"}}]}}
- "Hi all, quick one from me today" -> {{"actions": []}}

Return JSON: {{"actions": [...]}} (an empty list if nothing should change)."""


def extract_actions(prompt):
    return json.loads(generate(prompt, json_mode=True)).get("actions", [])


# ─── Applying actions ────────────────────────────────────────────────────────

def _resolve(team, name, field):
    name = str(name or "").strip().lower()
    for uid, m in team.items():
        if m["name"].lower() == name or m["email"].split("@")[0].lower() == name:
            if m["is_admin"]:
                raise Skip(f"{m['name']} is the facilitator and has no board")
            return uid
    raise Skip(f"Unknown {field} '{name}'")


def _ticket_on(board, team, raw_id):
    try:
        tid = int(str(raw_id).lstrip("#"))
    except (TypeError, ValueError):
        raise Skip(f"Invalid ticket id '{raw_id}'")
    ticket = find_ticket(board, tid)
    if not ticket:
        raise Skip(f"{team[board['user_id']]['name']} has no ticket #{tid}")
    return ticket


FILLER_WORDS = {
    "the", "and", "for", "with", "from", "that", "this", "our", "your", "her", "his", "their", "its",
    "ticket", "tickets", "task", "tasks", "work", "stuff", "thing", "things", "one", "board", "item",
    "done", "finished", "finish", "completed", "complete", "started", "start", "starting", "working",
    "today", "yesterday", "tomorrow", "now", "also", "just", "please", "can", "will", "need", "needs",
    "drop", "delete", "remove", "move", "take", "over", "priority", "high", "low", "medium", "deadline",
}


def _words(text):
    return {w for w in re.findall(r"[a-z0-9]+", text.lower()) if len(w) >= 2 and w not in FILLER_WORDS}


def _mentions(task, text):
    """True if the spoken text shares a real word with the ticket title ("auth" counts for "authentication")."""
    spoken = _words(text)
    return any(a.startswith(b) or b.startswith(a) for a in _words(task) for b in spoken if min(len(a), len(b)) >= 3 or a == b)


WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]


def _deadline(value, today=None):
    """Turn a spoken due date ("Friday", "tomorrow", "Nov 15", "2026-11-15") into YYYY-MM-DD, or ""."""
    today = today or datetime.now().date()
    text = re.sub(r"^(by|on|before|due)\s+", "", str(value or "").strip().lower()).rstrip(".")
    text = re.sub(r"(\d+)(st|nd|rd|th)\b", r"\1", text)
    if not text:
        return ""
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", text):
        return text
    if text in ("today", "tonight", "eod", "end of day"):
        return today.isoformat()
    if text == "tomorrow":
        return (today + timedelta(days=1)).isoformat()
    if text in ("end of week", "end of the week", "this week", "eow"):
        text = "friday"
    if text == "next week":
        return (today + timedelta(days=7 - today.weekday())).isoformat()  # next Monday
    m = re.fullmatch(r"(this |next )?(\w+)", text)
    if m and m.group(2) in WEEKDAYS:
        # The coming occurrence of that weekday (never today)
        days = (WEEKDAYS.index(m.group(2)) - today.weekday() - 1) % 7 + 1
        return (today + timedelta(days=days)).isoformat()
    for fmt in ("%B %d", "%b %d", "%d %B", "%d %b", "%B %d %Y", "%b %d %Y", "%d %B %Y", "%d %b %Y"):
        try:
            d = datetime.strptime(text.replace(",", ""), fmt).date()
        except ValueError:
            continue
        if "%Y" not in fmt:
            d = d.replace(year=today.year)
            if d < today:
                d = d.replace(year=today.year + 1)
        return d.isoformat()
    return ""


def apply_action(workspace_id, team, action, note_text=""):
    """Apply one AI action. Returns (summary, before_snapshots, after_snapshots); raises Skip."""
    kind = action.get("type")

    if kind == "create":
        uid = _resolve(team, action.get("assignee"), "assignee")
        task = str(action.get("task") or "").strip()
        if not task:
            raise Skip("No task description")
        board = get_board(workspace_id, uid)
        if any(t["task"].strip().lower() == task.lower() for t in board["tickets"]):
            raise Skip(f'"{task}" is already on {team[uid]["name"]}\'s board')
        tid = max((t["id"] for t in board["tickets"]), default=0) + 1
        before = [snapshot(board, tid)]
        priority = str(action.get("priority") or "medium").lower()
        board["tickets"].append({
            "id": tid, "task": task, "deadline": _deadline(action.get("deadline")),
            "priority": priority if priority in PRIORITIES else "medium",
            "dependency": 0, "status": "created",
        })
        board["columns"][str(tid)] = "created"
        board["execution_order"].append(tid)
        save_board(board)
        return f'Created #{tid} "{task}" for {team[uid]["name"]}', before, [snapshot(board, tid)]

    if kind in ("move", "delete", "reassign", "update"):
        owner = _resolve(team, action.get("owner"), "owner")
        board = get_board(workspace_id, owner)
        ticket = _ticket_on(board, team, action.get("ticket_id"))
        tid, label = ticket["id"], f'#{ticket["id"]} "{ticket["task"]}"'
        owner_name = team[owner]["name"]

        # Guard against the AI picking an unrelated ticket: what was said must mention it
        if not _mentions(ticket["task"], action.get("quote") or note_text):
            raise Skip(f"Not sure which of {owner_name}'s tickets was meant (closest guess was {label})")

        if kind == "move":
            status = action.get("status")
            if status not in VALID_STATUSES:
                raise Skip(f"Unknown status '{status}'")
            if board["columns"].get(str(tid)) == status:
                raise Skip(f"{label} is already {STATUS_LABELS[status]}")
            blocker = dependency_blocker(ticket, board["tickets"], board["columns"], status)
            if blocker:
                raise Skip(f'{label} depends on #{blocker["id"]} "{blocker["task"]}", which isn\'t completed yet')
            before = [snapshot(board, tid)]
            board["columns"][str(tid)] = status
            ticket["status"] = status
            save_board(board)
            return f"Moved {owner_name}'s {label} to {STATUS_LABELS[status]}", before, [snapshot(board, tid)]

        if kind == "update":
            changes = {}
            priority = str(action.get("priority") or "").lower()
            if priority in PRIORITIES and priority != ticket.get("priority"):
                changes["priority"] = priority
            deadline = _deadline(action.get("deadline"))
            if deadline and deadline != ticket.get("deadline"):
                changes["deadline"] = deadline
            if not changes:
                raise Skip(f"Nothing to change on {label}")
            before = [snapshot(board, tid)]
            ticket.update(changes)
            save_board(board)
            what = " and ".join(f"{k} to {v}" for k, v in changes.items())
            return f"Set {owner_name}'s {label} {what}", before, [snapshot(board, tid)]

        # delete and reassign both take the ticket off this board, which frees its dependents
        dependents = [t for t in board["tickets"] if t.get("dependency") == tid]
        before = [snapshot(board, tid)] + [snapshot(board, d["id"]) for d in dependents]

        if kind == "reassign":
            new_owner = _resolve(team, action.get("assignee"), "assignee")
            if new_owner == owner:
                raise Skip(f"{label} already belongs to {owner_name}")
            new_board = get_board(workspace_id, new_owner)
            new_id = max((t["id"] for t in new_board["tickets"]), default=0) + 1
            before.append(snapshot(new_board, new_id))
            column = board["columns"].get(str(tid), "created")
            new_board["tickets"].append({**ticket, "id": new_id, "dependency": 0, "status": column})
            new_board["columns"][str(new_id)] = column
            new_board["execution_order"].append(new_id)

        board["tickets"] = [t for t in board["tickets"] if t["id"] != tid]
        board["columns"].pop(str(tid), None)
        board["execution_order"] = [i for i in board["execution_order"] if i != tid]
        for d in dependents:
            d["dependency"] = 0
        save_board(board)
        after = [snapshot(board, tid)] + [snapshot(board, d["id"]) for d in dependents]

        if kind == "delete":
            return f"Deleted {owner_name}'s {label}", before, after
        save_board(new_board)
        after.append(snapshot(new_board, new_id))
        return f"Moved {label} from {owner_name} to {team[new_owner]['name']} (now #{new_id})", before, after

    raise Skip(f"Unknown action type '{kind}'")


def undo_activity(workspace_id, entry):
    """Revert an applied action, unless its tickets were changed again since."""
    for snap in entry["after"]:
        if snapshot(get_board(workspace_id, snap["user_id"]), snap["ticket_id"]) != snap:
            raise Skip(f"Ticket #{snap['ticket_id']} has changed since, so this can't be undone automatically")
    for snap in entry["before"]:
        restore(workspace_id, snap)


# ─── Processing notes ────────────────────────────────────────────────────────

def process_note(meeting_id, note_id):
    """Turn one meeting note into board actions (runs in the background after the note is saved)."""
    meeting = meetings_collection.find_one({"_id": ObjectId(meeting_id)})
    if not meeting:
        return 0
    workspace_id = meeting["workspace_id"]

    with workspace_lock(workspace_id):
        meeting = meetings_collection.find_one({"_id": ObjectId(meeting_id)})
        notes = meeting.get("notes", [])
        idx = next((i for i, n in enumerate(notes) if n.get("id") == note_id), None)
        if idx is None or notes[idx].get("processed"):
            return 0
        note = notes[idx]

        team = load_team(workspace_id)
        if note["user_id"] not in team:
            return 0
        boards = {uid: get_board(workspace_id, uid) for uid in team}
        done = [a["summary"] for a in meeting.get("activity", []) if a["status"] == "applied"]
        prompt = build_prompt(team, boards, note["user_id"], note["text"], notes[max(0, idx - 6):idx], done)

        try:
            actions = extract_actions(prompt)
        except Exception as e:
            print(f"[Voice Actions] AI failed for note {note_id}: {e}")
            return 0  # left unprocessed, so ending the meeting retries it

        entries = []
        for action in actions if isinstance(actions, list) else []:
            if not isinstance(action, dict):
                continue
            entry = {
                "id": uuid.uuid4().hex,
                "note_id": note_id,
                "speaker": team[note["user_id"]]["name"],
                "quote": str(action.get("quote") or note["text"])[:200],
                "type": action.get("type", "?"),
                "created_at": datetime.utcnow().isoformat(),
            }
            try:
                summary, before, after = apply_action(workspace_id, team, action, note["text"])
                entry.update(status="applied", summary=summary, before=before, after=after)
            except Skip as s:
                entry.update(status="skipped", summary=str(s), before=[], after=[])
            print(f"[Voice Actions] {entry['status']}: {entry['summary']}")
            entries.append(entry)

        update = {"$set": {f"notes.{idx}.processed": True}}
        if entries:
            update["$push"] = {"activity": {"$each": entries}}
        meetings_collection.update_one({"_id": ObjectId(meeting_id)}, update)
        return sum(e["status"] == "applied" for e in entries)


def public_activity(meeting):
    """Activity entries without the internal undo snapshots."""
    return [
        {k: v for k, v in a.items() if k not in ("before", "after")}
        for a in meeting.get("activity", [])
    ]
