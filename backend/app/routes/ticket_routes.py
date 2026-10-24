from fastapi import APIRouter, HTTPException, Header, Query
from app.schemas import TicketRequest
from app.llm.priority_agent import prioritize_tasks
from app.routes.auth_routes import verify_token
from app.database import boards_collection
from app.permissions import require_member
from app.services.dependency_service import validate_tickets

router = APIRouter()


@router.post("/tickets")
def create_tickets(data: TicketRequest, workspace_id: str = Query(...), authorization: str = Header(None)):
    user = verify_token(authorization)
    user_id = user["user_id"]
    require_member(workspace_id, user_id)

    tickets = [ticket.model_dump() for ticket in data.tickets]
    for t in tickets:
        t["priority"] = t["priority"].strip().lower()

    error = validate_tickets(tickets)
    if error:
        raise HTTPException(status_code=400, detail=error)

    try:
        execution_order = prioritize_tasks(tickets)

        # Keep the column of tickets that were already on the board; new ones start in "created"
        existing = boards_collection.find_one({"workspace_id": workspace_id, "user_id": user_id}) or {}
        old_columns = existing.get("columns", {})
        columns = {str(t["id"]): old_columns.get(str(t["id"]), "created") for t in tickets}
        for t in tickets:
            t["status"] = columns[str(t["id"])]

        # Save to MongoDB under workspace + user
        boards_collection.update_one(
            {"workspace_id": workspace_id, "user_id": user_id},
            {"$set": {
                "workspace_id": workspace_id,
                "user_id": user_id,
                "tickets": tickets,
                "columns": columns,
                "execution_order": execution_order,
            }},
            upsert=True
        )

        return {
            "message": "Tickets received",
            "execution_order": execution_order,
            "columns": columns,
        }

    except Exception as e:
        print(f"[Unexpected Error] {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/board")
def get_board(workspace_id: str = Query(...), user_id: str = Query(None), authorization: str = Header(None)):
    """Load a board. If user_id is provided, load that user's board (read-only view)."""
    user = verify_token(authorization)
    target_user_id = user_id or user["user_id"]

    # Both the viewer and the board owner must belong to the workspace
    workspace = require_member(workspace_id, user["user_id"])
    if target_user_id not in workspace.get("members", []):
        raise HTTPException(status_code=404, detail="User is not in this workspace")

    board = boards_collection.find_one(
        {"workspace_id": workspace_id, "user_id": target_user_id},
        {"_id": 0}
    ) or {}

    return {
        "tickets": board.get("tickets", []),
        "columns": board.get("columns", {}),
        "execution_order": board.get("execution_order", []),
        "is_own_board": target_user_id == user["user_id"],
    }


@router.delete("/board")
def clear_board(workspace_id: str = Query(...), authorization: str = Header(None)):
    """Clear the current user's board data for the workspace."""
    user = verify_token(authorization)
    user_id = user["user_id"]
    require_member(workspace_id, user_id)

    boards_collection.delete_one({"workspace_id": workspace_id, "user_id": user_id})

    return {"message": "Board cleared"}