import os
import certifi
import bcrypt
from dotenv import load_dotenv
from pymongo import MongoClient

load_dotenv()

MONGODB_URI = os.getenv("MONGODB_URI")
client = MongoClient(MONGODB_URI, tlsCAFile=certifi.where())
db = client["mini_ai_jira"]

users_collection = db["users"]
boards_collection = db["boards"]
workspaces_collection = db["workspaces"]
invitations_collection = db["invitations"]
meetings_collection = db["meetings"]

# Ensure indexes
users_collection.create_index("email", unique=True)
# Drop ALL old indexes on boards (except _id) to clear stale unique constraints
try:
    boards_collection.drop_indexes()
except Exception:
    pass
boards_collection.create_index([("workspace_id", 1), ("user_id", 1)], unique=True)
workspaces_collection.create_index("name")
invitations_collection.create_index("to_user_id")

# Seed admin user
ADMIN_EMAIL = os.getenv("ADMIN_EMAIL")
ADMIN_PASSWORD = os.getenv("ADMIN_PASSWORD")

existing_admin = users_collection.find_one({"email": ADMIN_EMAIL}) if ADMIN_EMAIL else None
if not ADMIN_EMAIL or not ADMIN_PASSWORD:
    print("[DB] ADMIN_EMAIL / ADMIN_PASSWORD not set — skipping admin seed")
elif not existing_admin:
    hashed = bcrypt.hashpw(ADMIN_PASSWORD.encode("utf-8"), bcrypt.gensalt())
    users_collection.insert_one({
        "email": ADMIN_EMAIL,
        "password": hashed.decode("utf-8"),
        "is_admin": True,
    })
    print(f"[DB] Admin user seeded: {ADMIN_EMAIL}")
else:
    # Ensure is_admin flag is set
    if not existing_admin.get("is_admin"):
        users_collection.update_one({"email": ADMIN_EMAIL}, {"$set": {"is_admin": True}})
