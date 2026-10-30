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
            json.dump({"files": [], "shares": [], "settings": {"retention_days": 30, "vault_retention": {}}}, f, indent=2)


def load_db() -> Dict[str, Any]:
    ensure_db()
    try:
        with open(DB_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
            data.setdefault("files", [])
            data.setdefault("shares", [])
            data.setdefault("settings", {"retention_days": 30})
            return data
    except Exception:
        return {"files": [], "shares": [], "settings": {"retention_days": 30, "vault_retention": {}}}


def save_db(data: Dict[str, Any]):
    ensure_db()
    with open(DB_FILE, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, default=str)


def get_all_files() -> List[Dict[str, Any]]:
    return load_db().get("files", [])


def get_vault_files(vault_id: str) -> List[Dict[str, Any]]:
    return [f for f in get_all_files() if f.get("vault_id") == vault_id]


def get_file_by_id(file_id: str) -> Optional[Dict[str, Any]]:
    for f in get_all_files():
        if f.get("id") == file_id:
            return f
    return None


def get_vault_file_by_id(file_id: str, vault_id: str) -> Optional[Dict[str, Any]]:
    rec = get_file_by_id(file_id)
    if rec and rec.get("vault_id") == vault_id:
        return rec
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


def get_vault_retention_days(vault_id: str) -> int:
    settings = get_settings()
    vault_map = settings.get("vault_retention") or {}
    if vault_id and vault_id in vault_map:
        return int(vault_map[vault_id])
    return int(settings.get("retention_days", 30))


def set_vault_retention_days(vault_id: str, days: int) -> int:
    data = load_db()
    settings = data.setdefault("settings", {"retention_days": 30})
    vault_map = settings.setdefault("vault_retention", {})
    vault_map[vault_id] = int(days)
    save_db(data)
    return int(days)


# Zero-Knowledge Encrypted Share Records
def get_all_shares() -> List[Dict[str, Any]]:
    return load_db().get("shares", [])


def get_share_by_id(share_id: str) -> Optional[Dict[str, Any]]:
    for s in get_all_shares():
        if s.get("share_id") == share_id:
            return s
    return None


def insert_share(share_record: Dict[str, Any]) -> Dict[str, Any]:
    data = load_db()
    data.setdefault("shares", []).append(share_record)
    save_db(data)
    return share_record


def update_share(share_id: str, updates: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    data = load_db()
    for s in data.get("shares", []):
        if s.get("share_id") == share_id:
            s.update(updates)
            save_db(data)
            return s
    return None


def delete_share_record(share_id: str) -> Optional[Dict[str, Any]]:
    data = load_db()
    shares = data.get("shares", [])
    target = None
    kept = []
    for s in shares:
        if s.get("share_id") == share_id:
            target = s
        else:
            kept.append(s)
    if target:
        data["shares"] = kept
        save_db(data)
    return target
