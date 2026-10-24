"""
Deploy the SprintFlow API to Modal.

    cd backend
    modal secret create sprintflow-env --from-dotenv .env --force   # after changing .env
    modal deploy modal_app.py
"""
from pathlib import Path

import modal

BACKEND_DIR = Path(__file__).parent

image = (
    modal.Image.debian_slim(python_version="3.13")
    .pip_install_from_pyproject(str(BACKEND_DIR / "pyproject.toml"))
    .add_local_python_source("app")
)

app = modal.App("sprintflow-backend", image=image)


@app.function(
    secrets=[modal.Secret.from_name("sprintflow-env")],
    # A single container: live meeting notes are serialized with in-process locks per workspace
    max_containers=1,
    # Stay warm for 15 minutes after the last request so demos don't hit a cold start
    scaledown_window=15 * 60,
    timeout=120,
)
@modal.concurrent(max_inputs=100)
@modal.asgi_app()
def api():
    from app.main import app as fastapi_app

    return fastapi_app
