from datetime import datetime, timezone, timedelta
from typing import Dict, Any, List, Tuple
from database import get_settings, get_all_files, update_file, delete_file_record
import os

def calculate_file_retention_status(file_record: Dict[str, Any], retention_days: int = None) -> Dict[str, Any]:
    """
    Evaluates file retention status:
    - Files with tag 'important' (or is_pinned) are strictly PROTECTED from retention deletion.
    - Otherwise, checks if file is older than retention_days (e.g. 30 or 60 days).
    """
    if retention_days is None:
        settings = get_settings()
        retention_days = int(settings.get("retention_days", 30))

    tags = [t.lower() for t in file_record.get("tags", [])]
    is_important = "important" in tags or file_record.get("is_pinned", False)

    # 1. Important files are strictly protected
    if is_important:
        return {
            "status": "protected",
            "is_protected": True,
            "badge_text": "Protected",
            "badge_color": "emerald",
            "days_old": get_file_age_days(file_record),
            "retention_days": retention_days,
            "reason": "Protected by 'important' tag (excluded from cleanup)."
        }

    # 2. Check extension override
    extended_until = file_record.get("extended_until")
    now = datetime.now(timezone.utc)
    if extended_until:
        try:
            ext_dt = datetime.fromisoformat(extended_until.replace("Z", "+00:00"))
            if now < ext_dt:
                days_left = max(1, (ext_dt - now).days)
                return {
                    "status": "extended",
                    "is_protected": False,
                    "badge_text": f"Extended ({days_left}d left)",
                    "badge_color": "blue",
                    "days_old": get_file_age_days(file_record),
                    "retention_days": retention_days,
                    "reason": f"Retention extended until {ext_dt.strftime('%b %d, %Y')}."
                }
        except Exception:
            pass

    # 3. Calculate age
    days_old = get_file_age_days(file_record)
    days_remaining = retention_days - days_old

    if days_remaining <= 0:
        return {
            "status": "expired",
            "is_protected": False,
            "badge_text": f"Expired ({abs(days_remaining)}d overdue)",
            "badge_color": "rose",
            "days_old": days_old,
            "retention_days": retention_days,
            "reason": f"File is {days_old} days old (exceeds {retention_days}-day limit). Pending user review to delete."
        }
    elif days_remaining <= 7:
        return {
            "status": "expiring_soon",
            "is_protected": False,
            "badge_text": f"Expires in {days_remaining}d",
            "badge_color": "amber",
            "days_old": days_old,
            "retention_days": retention_days,
            "reason": f"File will reach {retention_days}-day retention limit in {days_remaining} days."
        }
    else:
        return {
            "status": "active",
            "is_protected": False,
            "badge_text": f"Active ({days_remaining}d left)",
            "badge_color": "slate",
            "days_old": days_old,
            "retention_days": retention_days,
            "reason": f"Active file. {days_remaining} days remaining before cleanup review."
        }

def get_file_age_days(file_record: Dict[str, Any]) -> int:
    created_at_str = file_record.get("created_at")
    if not created_at_str:
        return 0
    try:
        created_at = datetime.fromisoformat(created_at_str.replace("Z", "+00:00"))
        now = datetime.now(timezone.utc)
        diff = now - created_at
        return max(0, diff.days)
    except Exception:
        return 0

def get_retention_overview() -> Dict[str, Any]:
    settings = get_settings()
    retention_days = int(settings.get("retention_days", 30))
    all_files = get_all_files()

    expired_files = []
    expiring_soon_files = []
    protected_files = []
    active_files = []

    for f in all_files:
        status_info = calculate_file_retention_status(f, retention_days)
        f_with_status = dict(f)
        f_with_status["retention_info"] = status_info

        if status_info["status"] == "protected":
            protected_files.append(f_with_status)
        elif status_info["status"] == "expired":
            expired_files.append(f_with_status)
        elif status_info["status"] == "expiring_soon":
            expiring_soon_files.append(f_with_status)
        else:
            active_files.append(f_with_status)

    return {
        "retention_days": retention_days,
        "counts": {
            "total": len(all_files),
            "expired": len(expired_files),
            "expiring_soon": len(expiring_soon_files),
            "protected": len(protected_files),
            "active": len(active_files)
        },
        "pending_review_files": expired_files,
        "requires_permission": len(expired_files) > 0
    }

def handle_retention_action(file_ids: List[str], action: str, custom_extension_days: int = 30) -> Dict[str, Any]:
    """
    User permissions handler:
    action: 'delete' -> removes files (never affects important files!)
    action: 'extend' -> adds custom_extension_days to extended_until
    action: 'protect' -> adds 'important' tag to prevent deletion
    """
    results = {"success": [], "skipped_protected": [], "errors": []}
    now = datetime.now(timezone.utc)

    for fid in file_ids:
        all_files = get_all_files()
        target = next((f for f in all_files if f.get("id") == fid), None)
        if not target:
            results["errors"].append({"id": fid, "error": "Not found"})
            continue

        tags = [t.lower() for t in target.get("tags", [])]
        is_important = "important" in tags

        if action == "delete":
            # Safety check: Never delete important files via retention cleanup!
            if is_important:
                results["skipped_protected"].append({
                    "id": fid,
                    "filename": target.get("filename"),
                    "reason": "File is protected with 'important' tag"
                })
                continue

            # Remove physical file
            storage_path = target.get("storage_path")
            if storage_path and os.path.exists(storage_path):
                try:
                    os.remove(storage_path)
                except Exception as e:
                    results["errors"].append({"id": fid, "error": f"Failed removing file: {str(e)}"})
                    continue

            delete_file_record(fid)
            results["success"].append({"id": fid, "filename": target.get("filename"), "action": "deleted"})

        elif action == "extend":
            new_extension = (now + timedelta(days=custom_extension_days)).isoformat()
            update_file(fid, {"extended_until": new_extension})
            results["success"].append({
                "id": fid,
                "filename": target.get("filename"),
                "action": f"extended_{custom_extension_days}_days"
            })

        elif action == "protect":
            current_tags = target.get("tags", [])
            if "important" not in [t.lower() for t in current_tags]:
                current_tags.append("important")
            update_file(fid, {"tags": current_tags})
            results["success"].append({
                "id": fid,
                "filename": target.get("filename"),
                "action": "marked_important"
            })

    return results
