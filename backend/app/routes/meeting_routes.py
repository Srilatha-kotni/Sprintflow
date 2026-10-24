from fastapi import APIRouter, BackgroundTasks, HTTPException, Header
from pydantic import BaseModel
from bson import ObjectId
from datetime import datetime
import re
import uuid
from app.routes.auth_routes import verify_token
from app.routes.admin_routes import require_admin
from app.database import users_collection, workspaces_collection, meetings_collection
from app.llm.mistral_client import generate
from app.services.voice_actions import Skip, process_note, public_activity, undo_activity, workspace_lock

router = APIRouter(tags=["meetings"])


class CreateMeeting(BaseModel):
    workspace_id: str
    title: str = "Daily Standup"


class MeetingNote(BaseModel):
    meeting_id: str
    text: str


# ─── Admin Endpoints ─────────────────────

@router.post("/admin/meetings/create")
def create_meeting(data: CreateMeeting, authorization: str = Header(None)):
    """Create a new standup meeting with a Jitsi link (admin only)."""
    user = require_admin(authorization)

    workspace = workspaces_collection.find_one({"_id": ObjectId(data.workspace_id)})
    if not workspace:
        raise HTTPException(status_code=404, detail="Workspace not found")

    # Check if there's already an active meeting for this workspace
    existing = meetings_collection.find_one({
        "workspace_id": data.workspace_id,
        "status": "active",
    })
    if existing:
        raise HTTPException(
            status_code=400,
            detail="There's already an active meeting for this workspace",
        )

    # Generate unique Jitsi room name
    ws_name_clean = re.sub(r'[^a-zA-Z0-9]', '', workspace["name"])
    timestamp = datetime.utcnow().strftime("%Y%m%d%H%M%S")
    room_name = f"SprintFlow-{ws_name_clean}-{timestamp}"
    jitsi_link = f"https://meet.jit.si/{room_name}"

    # Get workspace member emails for display
    member_emails = []
    for mid in workspace.get("members", []):
        u = users_collection.find_one({"_id": ObjectId(mid)}, {"email": 1})
        if u:
            member_emails.append(u["email"])

    meeting = {
        "workspace_id": data.workspace_id,
        "workspace_name": workspace["name"],
        "title": data.title,
        "room_name": room_name,
        "jitsi_link": jitsi_link,
        "created_by": user["email"],
        "invited_members": workspace.get("members", []),
        "notes": [],
        "status": "active",
        "created_at": datetime.utcnow().isoformat(),
    }

    result = meetings_collection.insert_one(meeting)

    return {
        "message": f"Meeting created for '{workspace['name']}'",
        "meeting_id": str(result.inserted_id),
        "jitsi_link": jitsi_link,
        "room_name": room_name,
        "title": data.title,
        "workspace_name": workspace["name"],
        "member_emails": member_emails,
    }


@router.post("/admin/meetings/{meeting_id}/end")
def end_meeting(meeting_id: str, authorization: str = Header(None)):
    """End an active meeting: finish any unprocessed notes, then write the AI summary."""
    require_admin(authorization)

    meeting = meetings_collection.find_one({"_id": ObjectId(meeting_id)})
    if not meeting:
        raise HTTPException(status_code=404, detail="Meeting not found")

    if meeting["status"] != "active":
        raise HTTPException(status_code=400, detail="Meeting is not active")

    # Notes are normally turned into board actions live; retry any the AI missed (e.g. rate limit)
    for note in meeting.get("notes", []):
        if not note.get("processed") and note.get("id"):
            process_note(meeting_id, note["id"])

    meeting = meetings_collection.find_one({"_id": ObjectId(meeting_id)})
    notes = meeting.get("notes", [])
    applied = [a for a in meeting.get("activity", []) if a["status"] == "applied"]
    ai_summary = ""

    if notes:
        transcript = "\n".join(f"[{n['user_email']}] ({n['timestamp']}): {n['text']}" for n in notes)
        changes = "\n".join(f"- {a['summary']}" for a in applied) or "(none)"
        summary_prompt = (
            "You are a standup meeting assistant. Summarize this meeting transcript.\n"
            "Highlight key updates, blockers, and decisions, then list the board changes that were made.\n\n"
            f"Transcript:\n{transcript}\n\n"
            f"Board changes made automatically during the meeting:\n{changes}"
        )
        try:
            ai_summary = generate(summary_prompt)
        except Exception as e:
            print(f"[AI Summary Error] {type(e).__name__}: {e}")
            ai_summary = "AI summary could not be generated."

    meetings_collection.update_one(
        {"_id": ObjectId(meeting_id)},
        {"$set": {
            "status": "ended",
            "ended_at": datetime.utcnow().isoformat(),
            "ai_summary": ai_summary,
        }}
    )

    return {
        "message": "Meeting ended",
        "ai_summary": ai_summary,
        "notes_count": len(notes),
        "actions_applied": len(applied),
    }


@router.delete("/admin/meetings/{meeting_id}")
def delete_meeting(meeting_id: str, authorization: str = Header(None)):
    """Delete a meeting from history (admin only)."""
    require_admin(authorization)

    result = meetings_collection.delete_one({"_id": ObjectId(meeting_id)})
    if result.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Meeting not found")

    return {"message": "Meeting deleted"}


@router.get("/admin/meetings")
def list_admin_meetings(authorization: str = Header(None)):
    """List all active meetings (admin only)."""
    require_admin(authorization)

    meetings = []
    for m in meetings_collection.find({"status": "active"}):
        meetings.append({
            "id": str(m["_id"]),
            "workspace_id": m["workspace_id"],
            "workspace_name": m["workspace_name"],
            "title": m["title"],
            "jitsi_link": m["jitsi_link"],
            "created_by": m["created_by"],
            "created_at": m["created_at"],
            "notes_count": len(m.get("notes", [])),
        })

    return {"meetings": meetings}


@router.get("/admin/meetings/history")
def meeting_history(authorization: str = Header(None)):
    """List ended meetings with transcripts and AI summaries (admin only)."""
    require_admin(authorization)

    meetings = []
    for m in meetings_collection.find({"status": "ended"}).sort("ended_at", -1).limit(20):
        # Build transcript from notes
        notes = m.get("notes", [])
        transcript_lines = []
        for note in notes:
            transcript_lines.append({
                "user": note["user_email"],
                "text": note["text"],
                "time": note["timestamp"],
            })

        meetings.append({
            "id": str(m["_id"]),
            "workspace_name": m["workspace_name"],
            "title": m["title"],
            "created_by": m["created_by"],
            "created_at": m["created_at"],
            "ended_at": m.get("ended_at", ""),
            "transcript": transcript_lines,
            "ai_summary": m.get("ai_summary", ""),
            "notes_count": len(notes),
            "activity": public_activity(m),
        })

    return {"meetings": meetings}


# ─── User Endpoints ──────────────────────

@router.post("/meetings/notes")
def add_meeting_note(data: MeetingNote, background: BackgroundTasks, authorization: str = Header(None)):
    """Add a note to an active meeting; the AI turns it into board actions in the background."""
    user = verify_token(authorization)

    meeting = meetings_collection.find_one({"_id": ObjectId(data.meeting_id)})
    if not meeting:
        raise HTTPException(status_code=404, detail="Meeting not found")

    if meeting["status"] != "active":
        raise HTTPException(status_code=400, detail="Meeting is not active")

    workspace = workspaces_collection.find_one({"_id": ObjectId(meeting["workspace_id"])})
    if not workspace or user["user_id"] not in workspace.get("members", []):
        raise HTTPException(status_code=403, detail="Not a member of this workspace")

    text = data.text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="Note is empty")

    note = {
        "id": uuid.uuid4().hex,
        "user_id": user["user_id"],
        "user_email": user["email"],
        "text": text,
        "timestamp": datetime.utcnow().strftime("%H:%M:%S"),
        "processed": False,
    }

    meetings_collection.update_one(
        {"_id": ObjectId(data.meeting_id)},
        {"$push": {"notes": note}}
    )
    background.add_task(process_note, data.meeting_id, note["id"])

    return {"message": "Note added", "note": note}


@router.get("/meetings/active")
def get_active_meetings(authorization: str = Header(None)):
    """Get active meetings for workspaces the current user belongs to."""
    user = verify_token(authorization)
    user_id = user["user_id"]

    # Find workspaces user is a member of
    user_workspaces = []
    for w in workspaces_collection.find({"members": user_id}):
        user_workspaces.append(str(w["_id"]))

    if not user_workspaces:
        return {"meetings": []}

    # Find active meetings for those workspaces
    meetings = []
    for m in meetings_collection.find({
        "workspace_id": {"$in": user_workspaces},
        "status": "active",
    }):
        meetings.append({
            "id": str(m["_id"]),
            "workspace_id": m["workspace_id"],
            "workspace_name": m["workspace_name"],
            "title": m["title"],
            "jitsi_link": m["jitsi_link"],
            "created_by": m["created_by"],
            "created_at": m["created_at"],
        })

    return {"meetings": meetings}


def _meeting_for_member(meeting_id: str, authorization: str):
    """Load a meeting the caller can see: a member of its workspace, or the admin."""
    user = verify_token(authorization)
    try:
        meeting = meetings_collection.find_one({"_id": ObjectId(meeting_id)})
    except Exception:
        meeting = None
    if not meeting:
        raise HTTPException(status_code=404, detail="Meeting not found")
    workspace = workspaces_collection.find_one({"_id": ObjectId(meeting["workspace_id"])})
    db_user = users_collection.find_one({"email": user["email"]}) or {}
    if not db_user.get("is_admin") and (not workspace or user["user_id"] not in workspace.get("members", [])):
        raise HTTPException(status_code=403, detail="Not a member of this workspace")
    return user, meeting


@router.get("/meetings/{meeting_id}/activity")
def get_meeting_activity(meeting_id: str, authorization: str = Header(None)):
    """Live feed of board changes made from what was said in the meeting."""
    _, meeting = _meeting_for_member(meeting_id, authorization)
    notes = meeting.get("notes", [])
    return {
        "status": meeting["status"],
        "activity": public_activity(meeting),
        "notes": [{"id": n.get("id"), "user": n["user_email"], "text": n["text"], "time": n["timestamp"],
                   "processed": n.get("processed", True)} for n in notes[-30:]],
    }


@router.post("/meetings/{meeting_id}/activity/{activity_id}/undo")
def undo_meeting_activity(meeting_id: str, activity_id: str, authorization: str = Header(None)):
    """Revert one automatic board change."""
    user, meeting = _meeting_for_member(meeting_id, authorization)
    workspace_id = meeting["workspace_id"]

    with workspace_lock(workspace_id):
        meeting = meetings_collection.find_one({"_id": ObjectId(meeting_id)})
        idx = next((i for i, a in enumerate(meeting.get("activity", [])) if a["id"] == activity_id), None)
        if idx is None:
            raise HTTPException(status_code=404, detail="Activity not found")
        entry = meeting["activity"][idx]
        if entry["status"] != "applied":
            raise HTTPException(status_code=400, detail=f"This change is {entry['status']}, nothing to undo")
        try:
            undo_activity(workspace_id, entry)
        except Skip as s:
            raise HTTPException(status_code=409, detail=str(s))
        meetings_collection.update_one(
            {"_id": ObjectId(meeting_id)},
            {"$set": {f"activity.{idx}.status": "undone", f"activity.{idx}.undone_by": user["email"]}}
        )

    return {"message": f"Undone: {entry['summary']}"}
