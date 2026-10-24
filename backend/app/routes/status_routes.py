from fastapi import APIRouter, HTTPException, Header, Query
from app.schemas import StatusUpdate
from app.routes.auth_routes import verify_token
from app.database import boards_collection
from app.permissions import require_member
from app.services.dependency_service import VALID_STATUSES, dependency_blocker

router = APIRouter()


@router.post("/status")
def update_task_status(data: StatusUpdate, workspace_id: str = Query(...), authorization: str = Header(None)):
    user = verify_token(authorization)
    user_id = user["user_id"]
    require_member(workspace_id, user_id)

    if data.status not in VALID_STATUSES:
        raise HTTPException(status_code=400, detail=f"Unknown status '{data.status}'")

    board = boards_collection.find_one({"workspace_id": workspace_id, "user_id": user_id})
    if not board:
        raise HTTPException(status_code=404, detail="Board not found")

    tickets = board.get("tickets", [])
    columns = board.get("columns", {})
    ticket = next((t for t in tickets if t["id"] == data.task_id), None)
    if not ticket:
        raise HTTPException(status_code=404, detail=f"Ticket #{data.task_id} not found")

    blocker = dependency_blocker(ticket, tickets, columns, data.status)
    if blocker:
        raise HTTPException(
            status_code=409,
            detail=f"Ticket #{data.task_id} depends on #{blocker['id']} ({blocker['task']}), which isn't completed yet",
        )

    columns[str(data.task_id)] = data.status
    ticket["status"] = data.status
    boards_collection.update_one(
        {"workspace_id": workspace_id, "user_id": user_id},
        {"$set": {"columns": columns, "tickets": tickets}}
    )

    return {"message": f"Task {data.task_id} updated to {data.status}"}
