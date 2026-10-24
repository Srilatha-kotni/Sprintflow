from bson import ObjectId
from bson.errors import InvalidId
from fastapi import HTTPException
from app.database import workspaces_collection


def get_workspace(workspace_id: str):
    try:
        workspace = workspaces_collection.find_one({"_id": ObjectId(workspace_id)})
    except InvalidId:
        workspace = None
    if not workspace:
        raise HTTPException(status_code=404, detail="Workspace not found")
    return workspace


def require_member(workspace_id: str, user_id: str):
    """Return the workspace, or raise 403 if the user is not one of its members."""
    workspace = get_workspace(workspace_id)
    if user_id not in workspace.get("members", []):
        raise HTTPException(status_code=403, detail="Not a member of this workspace")
    return workspace
