import json
import os
import uuid
from datetime import datetime, timezone
from typing import List, Dict, Any, Optional

DB_FILE = os.path.join(os.path.dirname(__file__), "storage", "metadata.json")

def ensure_db():
    storage_dir = os.path.dirname(DB_FILE)
    if not os.path.exists(storage_dir):
        os.makedirs(storage_dir, exist_ok=True)
    if not os.path.exists(DB_FILE):
        with open(DB_FILE, "w", encoding="utf-8") as f:
            json.dump({"files": [], "settings": {"retention_days": 30}}, f, indent=2)

def load_db() -> Dict[str, Any]:
    ensure_db()
    try:
        with open(DB_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {"files": [], "settings": {"retention_days": 30}}

def save_db(data: Dict[str, Any]):
    ensure_db()
    with open(DB_FILE, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, default=str)

def get_all_files() -> List[Dict[str, Any]]:
    return load_db().get("files", [])

def get_file_by_id(file_id: str) -> Optional[Dict[str, Any]]:
    files = get_all_files()
    for f in files:
        if f.get("id") == file_id:
            return f
    return None

def insert_file(file_record: Dict[str, Any]) -> Dict[str, Any]:
    data = load_db()
    if "id" not in file_record:
        file_record["id"] = str(uuid.uuid4())
    data.setdefault("files", []).append(file_record)
    save_db(data)
    return file_record

def update_file(file_id: str, updates: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    data = load_db()
    for f in data.get("files", []):
        if f.get("id") == file_id:
            f.update(updates)
            f["updated_at"] = datetime.now(timezone.utc).isoformat()
            save_db(data)
            return f
    return None

def delete_file_record(file_id: str) -> Optional[Dict[str, Any]]:
    data = load_db()
    files = data.get("files", [])
    target = None
    new_files = []
    for f in files:
        if f.get("id") == file_id:
            target = f
        else:
            new_files.append(f)
    if target:
        data["files"] = new_files
        save_db(data)
    return target

def get_settings() -> Dict[str, Any]:
    return load_db().get("settings", {"retention_days": 30})

def update_settings(updates: Dict[str, Any]) -> Dict[str, Any]:
    data = load_db()
    data.setdefault("settings", {}).update(updates)
    save_db(data)
    return data["settings"]
