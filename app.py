import hashlib
import mimetypes
import os
import re
import secrets
import shutil
import time
import uuid
from datetime import datetime, timezone, timedelta
from typing import List, Optional, Dict, Any
from fastapi import FastAPI, UploadFile, File, Form, HTTPException, Query, Header, Request
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from database import (
    get_all_files, get_file_by_id, insert_file, update_file,
    delete_file_record, get_settings, update_settings, ensure_db,
    get_vault_files, get_vault_file_by_id, get_vault_retention_days,
    set_vault_retention_days, get_all_shares, get_share_by_id,
    insert_share, update_share, delete_share_record
)
from document_reader import extract_document_text, categorize_file_type
from ai_engine import analyze_document_context
from retention_policy import (
    calculate_file_retention_status, get_retention_overview,
    handle_retention_action
)
from sample_generator import generate_sample_dataset

app = FastAPI(title="Aegis AI File Manager", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STORAGE_DIR = os.path.join(BASE_DIR, "storage")
SHARES_DIR = os.path.join(STORAGE_DIR, "shares")
STATIC_DIR = os.path.join(BASE_DIR, "static")

os.makedirs(STORAGE_DIR, exist_ok=True)
os.makedirs(STATIC_DIR, exist_ok=True)

E2EE_MAGIC = b"AE2E\x01"
VAULT_ID_RE = re.compile(r"^[a-fA-F0-9]{16,64}$")

# Pydantic Schemas
class RenameRequest(BaseModel):
    new_name: Optional[str] = None
    use_ai_suggested: Optional[bool] = False

class BatchRenameRequest(BaseModel):
    file_ids: List[str]

class TagUpdateRequest(BaseModel):
    tags: List[str]

class AddTagRequest(BaseModel):
    tag: str

class RemoveTagRequest(BaseModel):
    tag: str

class RetentionSettingsRequest(BaseModel):
    retention_days: int

class RetentionActionRequest(BaseModel):
    file_ids: List[str]
    action: str  # 'delete', 'extend', 'protect'
    custom_extension_days: Optional[int] = 30

class SetAgeRequest(BaseModel):
    days_old: int

class BatchDeleteRequest(BaseModel):
    file_ids: List[str]

@app.on_event("startup")
def startup_event():
    ensure_db()

@app.get("/api/stats")
def get_stats():
    files = get_all_files()
    settings = get_settings()
    retention_days = int(settings.get("retention_days", 30))

    total_size = sum(f.get("size_bytes", 0) for f in files)
    categories = {}
    tags_count = {}
    expired_count = 0
    protected_count = 0

    for f in files:
        cat = f.get("context_category", "Personal & Notes")
        categories[cat] = categories.get(cat, 0) + 1

        for t in f.get("tags", []):
            tags_count[t] = tags_count.get(t, 0) + 1

        ret_info = calculate_file_retention_status(f, retention_days)
        if ret_info["status"] == "expired":
            expired_count += 1
        elif ret_info["status"] == "protected":
            protected_count += 1

    return {
        "total_files": len(files),
        "total_size_bytes": total_size,
        "categories": categories,
        "tags_count": tags_count,
        "retention_days": retention_days,
        "expired_files_count": expired_count,
        "protected_files_count": protected_count
    }

@app.get("/api/files")
def list_files(
    query: Optional[str] = None,
    context: Optional[str] = None,
    type: Optional[str] = None,
    tag: Optional[str] = None,
    retention: Optional[str] = None,
    sort_by: Optional[str] = "date",
    sort_order: Optional[str] = "desc"
):
    all_files = get_all_files()
    settings = get_settings()
    retention_days = int(settings.get("retention_days", 30))

    enriched_files = []
    for f in all_files:
        f_copy = dict(f)
        f_copy["retention_info"] = calculate_file_retention_status(f, retention_days)
        enriched_files.append(f_copy)

    filtered = enriched_files

    # 1. Full-Text Search
    if query:
        q = query.strip().lower()
        def matches_search(item):
            # check filename
            if q in item.get("filename", "").lower():
                return True
            # check original filename
            if q in item.get("original_filename", "").lower():
                return True
            # check context category
            if q in item.get("context_category", "").lower():
                return True
            # check tags
            if any(q in t.lower() for t in item.get("tags", [])):
                return True
            # check summary
            if q in item.get("ai_summary", "").lower():
                return True
            # check extracted document text
            if q in item.get("extracted_text", "").lower():
                return True
            return False

        filtered = [f for f in filtered if matches_search(f)]

    # 2. Context Filter
    if context and context != "All":
        filtered = [f for f in filtered if f.get("context_category") == context]

    # 3. File Type Filter
    if type and type != "All":
        filtered = [f for f in filtered if f.get("file_type") == type]

    # 4. Tag Filter
    if tag and tag != "All":
        tag_lower = tag.lower()
        filtered = [f for f in filtered if any(t.lower() == tag_lower for t in f.get("tags", []))]

    # 5. Retention Status Filter
    if retention and retention != "All":
        if retention == "expired":
            filtered = [f for f in filtered if f["retention_info"]["status"] == "expired"]
        elif retention == "protected":
            filtered = [f for f in filtered if f["retention_info"]["status"] == "protected"]
        elif retention == "expiring_soon":
            filtered = [f for f in filtered if f["retention_info"]["status"] == "expiring_soon"]
        elif retention == "active":
            filtered = [f for f in filtered if f["retention_info"]["status"] in ("active", "extended")]

    # 6. Sorting
    reverse = (sort_order == "desc")
    if sort_by == "name":
        filtered.sort(key=lambda x: x.get("filename", "").lower(), reverse=reverse)
    elif sort_by == "size":
        filtered.sort(key=lambda x: x.get("size_bytes", 0), reverse=reverse)
    elif sort_by == "retention":
        filtered.sort(key=lambda x: x["retention_info"].get("days_old", 0), reverse=reverse)
    else:  # default 'date'
        filtered.sort(key=lambda x: x.get("created_at", ""), reverse=reverse)

    return filtered

@app.post("/api/files/upload")
async def upload_files(
    files: List[UploadFile] = File(...),
    auto_rename: bool = Form(False),
    initial_tags: Optional[str] = Form(None)
):
    uploaded_records = []
    now = datetime.now(timezone.utc)
    custom_tag_list = [t.strip() for t in initial_tags.split(",") if t.strip()] if initial_tags else []

    for upload in files:
        # Strip any directory components so uploads can't escape the storage folder
        safe_filename = os.path.basename((upload.filename or "untitled").replace("\\", "/")) or "untitled"
        unique_prefix = uuid.uuid4().hex[:8]
        disk_filename = f"{unique_prefix}_{safe_filename}"
        dest_path = os.path.join(STORAGE_DIR, disk_filename)

        with open(dest_path, "wb") as buffer:
            shutil.copyfileobj(upload.file, buffer)

        file_stat = os.stat(dest_path)

        # 1. Read document content
        doc_info = extract_document_text(dest_path)

        # 2. Segregate context and generate AI suggestions
        ai_info = analyze_document_context(safe_filename, doc_info["text"])

        # Decide filename
        final_filename = safe_filename
        if auto_rename:
            final_filename = ai_info["ai_suggested_name"]

        # Merge tags
        combined_tags = list(dict.fromkeys(custom_tag_list + ai_info["suggested_tags"]))

        record = {
            "id": str(uuid.uuid4()),
            "filename": final_filename,
            "original_filename": safe_filename,
            "storage_path": dest_path,
            "file_type": categorize_file_type(safe_filename),
            "extension": os.path.splitext(safe_filename)[1].lower(),
            "size_bytes": file_stat.st_size,
            "created_at": now.isoformat(),
            "updated_at": now.isoformat(),
            "context_category": ai_info["context_category"],
            "tags": combined_tags,
            "ai_summary": ai_info["summary"],
            "extracted_text": doc_info["text"],
            "ai_suggested_name": ai_info["ai_suggested_name"],
            "ai_rename_reason": ai_info["ai_rename_reason"],
            "word_count": doc_info["word_count"],
            "reading_time_minutes": doc_info["reading_time_minutes"],
            "is_pinned": False,
            "extended_until": None
        }

        insert_file(record)
        uploaded_records.append(record)

    return {"uploaded": uploaded_records, "count": len(uploaded_records)}

@app.get("/api/files/{file_id}")
def get_file_detail(file_id: str):
    file_record = get_file_by_id(file_id)
    if not file_record:
        raise HTTPException(status_code=404, detail="File not found")
    settings = get_settings()
    retention_days = int(settings.get("retention_days", 30))
    res = dict(file_record)
    res["retention_info"] = calculate_file_retention_status(file_record, retention_days)
    return res

@app.post("/api/files/{file_id}/rename")
def rename_file(file_id: str, payload: RenameRequest):
    file_record = get_file_by_id(file_id)
    if not file_record:
        raise HTTPException(status_code=404, detail="File not found")

    new_name = payload.new_name
    if payload.use_ai_suggested:
        new_name = file_record.get("ai_suggested_name")

    if not new_name:
        raise HTTPException(status_code=400, detail="Missing new filename")

    # Ensure extension is maintained if missing
    orig_ext = file_record.get("extension", "")
    if orig_ext and not new_name.lower().endswith(orig_ext.lower()):
        new_name += orig_ext

    updated = update_file(file_id, {"filename": new_name})
    return {"message": "File renamed successfully", "file": updated}

@app.post("/api/files/batch-ai-rename")
def batch_ai_rename(payload: BatchRenameRequest):
    renamed = []
    for fid in payload.file_ids:
        file_record = get_file_by_id(fid)
        if file_record and file_record.get("ai_suggested_name"):
            ai_name = file_record["ai_suggested_name"]
            updated = update_file(fid, {"filename": ai_name})
            renamed.append(updated)
    return {"renamed_count": len(renamed), "files": renamed}

@app.post("/api/files/{file_id}/tags")
def update_tags(file_id: str, payload: TagUpdateRequest):
    file_record = get_file_by_id(file_id)
    if not file_record:
        raise HTTPException(status_code=404, detail="File not found")
    clean_tags = list(dict.fromkeys([t.strip().lower() for t in payload.tags if t.strip()]))
    updated = update_file(file_id, {"tags": clean_tags})
    return updated

@app.post("/api/files/{file_id}/tags/add")
def add_tag(file_id: str, payload: AddTagRequest):
    file_record = get_file_by_id(file_id)
    if not file_record:
        raise HTTPException(status_code=404, detail="File not found")
    current_tags = file_record.get("tags", [])
    tag_clean = payload.tag.strip().lower()
    if tag_clean and tag_clean not in [t.lower() for t in current_tags]:
        current_tags.append(tag_clean)
        update_file(file_id, {"tags": current_tags})
    return {"tags": current_tags}

@app.post("/api/files/{file_id}/tags/remove")
def remove_tag(file_id: str, payload: RemoveTagRequest):
    file_record = get_file_by_id(file_id)
    if not file_record:
        raise HTTPException(status_code=404, detail="File not found")
    current_tags = [t for t in file_record.get("tags", []) if t.lower() != payload.tag.strip().lower()]
    update_file(file_id, {"tags": current_tags})
    return {"tags": current_tags}

@app.delete("/api/files/{file_id}")
def delete_file(file_id: str):
    file_record = get_file_by_id(file_id)
    if not file_record:
        raise HTTPException(status_code=404, detail="File not found")

    storage_path = file_record.get("storage_path")
    if storage_path and os.path.exists(storage_path):
        try:
            os.remove(storage_path)
        except Exception as e:
            print(f"Error removing physical file: {e}")

    deleted = delete_file_record(file_id)
    return {"message": "File deleted successfully", "file": deleted}

@app.post("/api/files/batch-delete")
def batch_delete(payload: BatchDeleteRequest):
    deleted_ids = []
    for fid in payload.file_ids:
        file_record = get_file_by_id(fid)
        if file_record:
            storage_path = file_record.get("storage_path")
            if storage_path and os.path.exists(storage_path):
                try:
                    os.remove(storage_path)
                except Exception:
                    pass
            delete_file_record(fid)
            deleted_ids.append(fid)
    return {"deleted_count": len(deleted_ids), "ids": deleted_ids}

@app.post("/api/files/{file_id}/set-age")
def set_file_age(file_id: str, payload: SetAgeRequest):
    """
    Simulates file age in days for easy testing of retention rules (30d, 60d).
    """
    file_record = get_file_by_id(file_id)
    if not file_record:
        raise HTTPException(status_code=404, detail="File not found")

    now = datetime.now(timezone.utc)
    simulated_created_at = (now - timedelta(days=payload.days_old)).isoformat()
    updated = update_file(file_id, {"created_at": simulated_created_at, "extended_until": None})
    settings = get_settings()
    ret_info = calculate_file_retention_status(updated, int(settings.get("retention_days", 30)))
    return {"message": f"File age simulated to {payload.days_old} days", "retention_info": ret_info}

# Retention Policy Endpoints
@app.get("/api/retention/overview")
def get_retention_status():
    return get_retention_overview()

@app.post("/api/retention/settings")
def update_retention_settings(payload: RetentionSettingsRequest):
    if payload.retention_days not in (30, 60, 90):
        # Allow any positive integer up to 365
        if payload.retention_days < 1 or payload.retention_days > 365:
            raise HTTPException(status_code=400, detail="Retention days must be between 1 and 365")
    updated = update_settings({"retention_days": payload.retention_days})
    return {"message": f"Retention policy updated to {payload.retention_days} days", "settings": updated}

@app.post("/api/retention/action")
def perform_retention_action(payload: RetentionActionRequest):
    results = handle_retention_action(
        file_ids=payload.file_ids,
        action=payload.action,
        custom_extension_days=payload.custom_extension_days or 30
    )
    return results

@app.post("/api/samples/generate")
def regenerate_samples():
    records = generate_sample_dataset()
    return {"message": f"Generated {len(records)} realistic sample files", "files": records}

@app.get("/api/download/{file_id}")
def download_file(file_id: str):
    file_record = get_file_by_id(file_id)
    if not file_record:
        raise HTTPException(status_code=404, detail="File not found")
    storage_path = file_record.get("storage_path")
    if not storage_path or not os.path.exists(storage_path):
        raise HTTPException(status_code=404, detail="Physical file missing on disk")
    return FileResponse(
        path=storage_path,
        filename=file_record.get("filename"),
        media_type="application/octet-stream"
    )

# ==============================================================================
# Zero-Knowledge End-to-End Encryption (E2EE) Vault & Encrypted Sharing API
# ==============================================================================

class E2EEFileUpdateRequest(BaseModel):
    encrypted_meta: Optional[str] = None
    is_protected: Optional[bool] = None
    extended_until: Optional[str] = None
    clear_extended_until: Optional[bool] = False
    created_at: Optional[str] = None


class E2EERetentionItem(BaseModel):
    id: str
    encrypted_meta: Optional[str] = None
    is_protected: Optional[bool] = None


class E2EERetentionActionRequest(BaseModel):
    action: str  # 'delete', 'extend', 'protect'
    items: List[E2EERetentionItem]
    custom_extension_days: Optional[int] = 30


def _require_vault_id(x_vault_id: Optional[str]) -> str:
    if not x_vault_id or not VAULT_ID_RE.match(x_vault_id.strip()):
        raise HTTPException(status_code=401, detail="Missing or invalid X-Vault-Id header")
    return x_vault_id.strip().lower()


def _public_e2ee_record(rec: Dict[str, Any]) -> Dict[str, Any]:
    out = dict(rec)
    out.pop("storage_path", None)
    return out


def _validate_e2ee_blob(raw_bytes: bytes):
    # AE2E (4B) + version 0x01 (1B) + 96-bit IV (12B) + 128-bit GCM auth tag (16B) = min 33 bytes
    if len(raw_bytes) < 33 or raw_bytes[:5] != E2EE_MAGIC:
        raise HTTPException(
            status_code=400,
            detail="Rejected: payload is not a valid AE2E v1 AES-256-GCM ciphertext envelope"
        )


@app.get("/api/e2ee/files")
def list_e2ee_files(x_vault_id: Optional[str] = Header(None)):
    vault_id = _require_vault_id(x_vault_id)
    files = [_public_e2ee_record(f) for f in get_vault_files(vault_id)]
    return {
        "retention_days": get_vault_retention_days(vault_id),
        "files": files
    }


@app.post("/api/e2ee/files")
async def upload_e2ee_file(
    encrypted_blob: UploadFile = File(...),
    encrypted_meta: str = Form(...),
    size_bytes: int = Form(0),
    is_protected: bool = Form(False),
    x_vault_id: Optional[str] = Header(None)
):
    vault_id = _require_vault_id(x_vault_id)
    cipher_bytes = await encrypted_blob.read()
    _validate_e2ee_blob(cipher_bytes)
    if not encrypted_meta or len(encrypted_meta) < 24:
        raise HTTPException(status_code=400, detail="Missing encrypted metadata envelope")

    file_id = str(uuid.uuid4())
    disk_name = f"{file_id}.enc"
    dest_path = os.path.join(STORAGE_DIR, disk_name)
    with open(dest_path, "wb") as f:
        f.write(cipher_bytes)

    now_iso = datetime.now(timezone.utc).isoformat()
    record = {
        "id": file_id,
        "vault_id": vault_id,
        "e2ee": True,
        "cipher": "AES-256-GCM",
        "kdf": "PBKDF2-SHA256-210000",
        "storage_path": dest_path,
        "encrypted_meta": encrypted_meta,
        "size_bytes": max(0, int(size_bytes)),
        "cipher_size_bytes": len(cipher_bytes),
        "is_protected": bool(is_protected),
        "created_at": now_iso,
        "updated_at": now_iso,
        "extended_until": None
    }
    insert_file(record)
    return _public_e2ee_record(record)


@app.get("/api/e2ee/files/{file_id}/blob")
def download_e2ee_blob(file_id: str, x_vault_id: Optional[str] = Header(None)):
    vault_id = _require_vault_id(x_vault_id)
    rec = get_vault_file_by_id(file_id, vault_id)
    if not rec:
        raise HTTPException(status_code=404, detail="Encrypted file not found in this vault")
    storage_path = rec.get("storage_path")
    if not storage_path or not os.path.exists(storage_path):
        raise HTTPException(status_code=404, detail="Encrypted blob missing on disk")
    return FileResponse(path=storage_path, filename=f"{file_id}.enc", media_type="application/octet-stream")


@app.get("/api/e2ee/files/{file_id}/proof")
def inspect_e2ee_server_proof(file_id: str, x_vault_id: Optional[str] = Header(None)):
    vault_id = _require_vault_id(x_vault_id)
    rec = get_vault_file_by_id(file_id, vault_id)
    if not rec:
        raise HTTPException(status_code=404, detail="Encrypted file not found")
    storage_path = rec.get("storage_path")
    if not storage_path or not os.path.exists(storage_path):
        raise HTTPException(status_code=404, detail="Encrypted blob missing on disk")

    with open(storage_path, "rb") as f:
        head = f.read(65)

    return {
        "file_id": file_id,
        "disk_filename": os.path.basename(storage_path),
        "e2ee": bool(rec.get("e2ee", True)),
        "cipher": rec.get("cipher", "AES-256-GCM"),
        "kdf": rec.get("kdf", "PBKDF2-SHA256-210000"),
        "magic_header_hex": head[:5].hex(),
        "blob_iv_hex": head[5:17].hex(),
        "ciphertext_sample_hex": head[17:49].hex(),
        "cipher_size_bytes": os.path.getsize(storage_path),
        "encrypted_meta_preview": (rec.get("encrypted_meta") or "")[:96] + "...",
        "server_visible_fields": sorted([k for k in rec.keys() if k != "storage_path"]),
        "plaintext_stored_on_server": False
    }


@app.put("/api/e2ee/files/{file_id}")
def update_e2ee_file(
    file_id: str,
    payload: E2EEFileUpdateRequest,
    x_vault_id: Optional[str] = Header(None)
):
    vault_id = _require_vault_id(x_vault_id)
    rec = get_vault_file_by_id(file_id, vault_id)
    if not rec:
        raise HTTPException(status_code=404, detail="Encrypted file not found")

    updates: Dict[str, Any] = {}
    if payload.encrypted_meta is not None:
        if len(payload.encrypted_meta) < 24:
            raise HTTPException(status_code=400, detail="Invalid encrypted_meta")
        updates["encrypted_meta"] = payload.encrypted_meta
    if payload.is_protected is not None:
        updates["is_protected"] = bool(payload.is_protected)
    if payload.clear_extended_until:
        updates["extended_until"] = None
    elif payload.extended_until is not None:
        updates["extended_until"] = payload.extended_until
    if payload.created_at is not None:
        updates["created_at"] = payload.created_at

    updated = update_file(file_id, updates)
    return _public_e2ee_record(updated)


@app.delete("/api/e2ee/files/{file_id}")
def delete_e2ee_file(file_id: str, x_vault_id: Optional[str] = Header(None)):
    vault_id = _require_vault_id(x_vault_id)
    rec = get_vault_file_by_id(file_id, vault_id)
    if not rec:
        raise HTTPException(status_code=404, detail="Encrypted file not found")

    storage_path = rec.get("storage_path")
    if storage_path and os.path.exists(storage_path):
        try:
            os.remove(storage_path)
        except Exception:
            pass
    delete_file_record(file_id)
    return {"message": "Encrypted file deleted", "id": file_id}


@app.post("/api/e2ee/retention/settings")
def update_e2ee_retention_settings(
    payload: RetentionSettingsRequest,
    x_vault_id: Optional[str] = Header(None)
):
    vault_id = _require_vault_id(x_vault_id)
    if payload.retention_days < 1 or payload.retention_days > 365:
        raise HTTPException(status_code=400, detail="Retention days must be between 1 and 365")
    days = set_vault_retention_days(vault_id, payload.retention_days)
    return {"message": f"Retention policy updated to {days} days", "settings": {"retention_days": days}}


@app.post("/api/e2ee/retention/action")
def perform_e2ee_retention_action(
    payload: E2EERetentionActionRequest,
    x_vault_id: Optional[str] = Header(None)
):
    vault_id = _require_vault_id(x_vault_id)
    results = {"success": [], "skipped_protected": [], "errors": []}
    now = datetime.now(timezone.utc)

    for item in payload.items:
        rec = get_vault_file_by_id(item.id, vault_id)
        if not rec:
            results["errors"].append({"id": item.id, "error": "Not found"})
            continue

        if payload.action == "delete":
            if rec.get("is_protected", False):
                results["skipped_protected"].append({
                    "id": item.id,
                    "reason": "File is protected with 'important' tag"
                })
                continue
            storage_path = rec.get("storage_path")
            if storage_path and os.path.exists(storage_path):
                try:
                    os.remove(storage_path)
                except Exception as e:
                    results["errors"].append({"id": item.id, "error": str(e)})
                    continue
            delete_file_record(item.id)
            results["success"].append({"id": item.id, "action": "deleted"})

        elif payload.action == "extend":
            ext_days = payload.custom_extension_days or 30
            new_ext = (now + timedelta(days=ext_days)).isoformat()
            update_file(item.id, {"extended_until": new_ext})
            results["success"].append({"id": item.id, "action": f"extended_{ext_days}_days"})

        elif payload.action == "protect":
            updates: Dict[str, Any] = {"is_protected": True}
            if item.encrypted_meta:
                updates["encrypted_meta"] = item.encrypted_meta
            update_file(item.id, updates)
            results["success"].append({"id": item.id, "action": "marked_important"})

    return results


# Zero-Knowledge Encrypted File Share Links (Key stays strictly in URL #fragment)
def _purge_expired_shares():
    now = datetime.now(timezone.utc)
    for s in list(get_all_shares()):
        exp_str = s.get("expires_at")
        expired = False
        if exp_str:
            try:
                exp_dt = datetime.fromisoformat(exp_str.replace("Z", "+00:00"))
                expired = now >= exp_dt
            except Exception:
                expired = False
        if expired:
            sp = s.get("storage_path")
            if sp and os.path.exists(sp):
                try:
                    os.remove(sp)
                except Exception:
                    pass
            delete_share_record(s.get("share_id", ""))
    if os.path.exists(SHARES_DIR) and not os.listdir(SHARES_DIR):
        try:
            os.rmdir(SHARES_DIR)
        except Exception:
            pass


@app.post("/api/shares")
async def create_encrypted_share(
    encrypted_blob: UploadFile = File(...),
    encrypted_meta: str = Form(...),
    expires_in_hours: int = Form(168),
    burn_after_download: bool = Form(False)
):
    _purge_expired_shares()
    cipher_bytes = await encrypted_blob.read()
    _validate_e2ee_blob(cipher_bytes)
    if not encrypted_meta or len(encrypted_meta) < 24:
        raise HTTPException(status_code=400, detail="Missing encrypted share metadata")

    hours = max(1, min(720, int(expires_in_hours)))
    os.makedirs(SHARES_DIR, exist_ok=True)
    share_id = secrets.token_urlsafe(12)
    revoke_token = secrets.token_hex(16)
    dest_path = os.path.join(SHARES_DIR, f"{share_id}.enc")
    with open(dest_path, "wb") as f:
        f.write(cipher_bytes)

    now = datetime.now(timezone.utc)
    expires_at = (now + timedelta(hours=hours)).isoformat()
    record = {
        "share_id": share_id,
        "cipher": "AES-256-GCM",
        "storage_path": dest_path,
        "encrypted_meta": encrypted_meta,
        "cipher_size_bytes": len(cipher_bytes),
        "created_at": now.isoformat(),
        "expires_at": expires_at,
        "burn_after_download": bool(burn_after_download),
        "download_count": 0,
        "revoke_token": revoke_token
    }
    insert_share(record)
    return {
        "share_id": share_id,
        "cipher": "AES-256-GCM",
        "expires_at": expires_at,
        "burn_after_download": bool(burn_after_download),
        "revoke_token": revoke_token
    }


@app.get("/api/shares/{share_id}/meta")
def get_encrypted_share_meta(share_id: str):
    _purge_expired_shares()
    rec = get_share_by_id(share_id)
    if not rec or not os.path.exists(rec.get("storage_path", "")):
        raise HTTPException(status_code=404, detail="Encrypted share link has expired or already been burned.")
    return {
        "share_id": rec["share_id"],
        "cipher": rec.get("cipher", "AES-256-GCM"),
        "encrypted_meta": rec["encrypted_meta"],
        "cipher_size_bytes": rec.get("cipher_size_bytes", 0),
        "created_at": rec.get("created_at"),
        "expires_at": rec.get("expires_at"),
        "burn_after_download": rec.get("burn_after_download", False),
        "download_count": rec.get("download_count", 0)
    }


@app.get("/api/shares/{share_id}/blob")
def download_encrypted_share_blob(share_id: str):
    _purge_expired_shares()
    rec = get_share_by_id(share_id)
    if not rec:
        raise HTTPException(status_code=404, detail="Encrypted share link has expired or already been burned.")
    storage_path = rec.get("storage_path", "")
    if not os.path.exists(storage_path):
        delete_share_record(share_id)
        raise HTTPException(status_code=404, detail="Encrypted share payload missing or burned.")

    with open(storage_path, "rb") as f:
        cipher_bytes = f.read()

    if rec.get("burn_after_download", False):
        try:
            os.remove(storage_path)
        except Exception:
            pass
        delete_share_record(share_id)
        if os.path.exists(SHARES_DIR) and not os.listdir(SHARES_DIR):
            try:
                os.rmdir(SHARES_DIR)
            except Exception:
                pass
    else:
        update_share(share_id, {"download_count": int(rec.get("download_count", 0)) + 1})

    return Response(content=cipher_bytes, media_type="application/octet-stream")


@app.delete("/api/shares/{share_id}")
def revoke_encrypted_share(share_id: str, x_revoke_token: Optional[str] = Header(None)):
    rec = get_share_by_id(share_id)
    if not rec:
        raise HTTPException(status_code=404, detail="Share not found")
    if not x_revoke_token or x_revoke_token != rec.get("revoke_token"):
        raise HTTPException(status_code=403, detail="Invalid revoke token")
    sp = rec.get("storage_path")
    if sp and os.path.exists(sp):
        try:
            os.remove(sp)
        except Exception:
            pass
    delete_share_record(share_id)
    if os.path.exists(SHARES_DIR) and not os.listdir(SHARES_DIR):
        try:
            os.rmdir(SHARES_DIR)
        except Exception:
            pass
    return {"message": "Encrypted share link permanently revoked", "share_id": share_id}


# ==============================================================================
# Direct Loopback Local-Device Auto-Discovery & Live Downloads Feed
# Strictly accessible ONLY from direct local browser (localhost / 127.0.0.1)
# with zero reverse-proxy/tunnel headers. On public links (Render / Cloudflare),
# this returns 403 and the browser uses the W3C File System Access API instead.
# ==============================================================================
_LOCAL_DEVICE_SECRET = secrets.token_bytes(32)
_LOCAL_TOKEN_MAP: Dict[str, str] = {}

_SKIP_DIRS = {
    "node_modules", "__pycache__", ".git", ".svn", ".hg", "venv", ".venv",
    "AppData", "Application Data", "My Music", "My Pictures", "My Videos",
    "$RECYCLE.BIN", "System Volume Information"
}
_SKIP_EXTS = {
    ".exe", ".msi", ".dll", ".sys", ".lnk", ".ini", ".db", ".tmp", ".temp",
    ".crdownload", ".part", ".opdownload", ".download", ".onetoc2", ".iso",
    ".dmg", ".vmdk", ".cab", ".bin", ".log"
}
_MAX_AUTO_SYNC_BYTES = 15 * 1024 * 1024  # 15 MB cap per auto-synced file


def _verify_direct_local_browser(request: Request):
    client_host = (request.client.host if request.client else "") or ""
    if client_host not in ("127.0.0.1", "::1", "localhost"):
        raise HTTPException(status_code=403, detail="Local device bridge requires direct localhost access")

    # Block any request routed through a tunnel or cloud reverse proxy (Cloudflare, Render, ngrok, etc.)
    proxy_headers = (
        "cf-connecting-ip", "cf-ray", "x-forwarded-for", "x-forwarded-host",
        "x-forwarded-proto", "x-real-ip", "forwarded", "true-client-ip"
    )
    hdrs = request.headers
    if any(h in hdrs for h in proxy_headers):
        raise HTTPException(status_code=403, detail="Proxied/tunneled requests cannot read host files")

    host_hdr = (hdrs.get("host") or "").lower().split(":")[0]
    if host_hdr not in ("localhost", "127.0.0.1", "[::1]"):
        raise HTTPException(status_code=403, detail="Invalid Host header for local device bridge")

    sec_site = (hdrs.get("sec-fetch-site") or "").lower()
    if sec_site and sec_site not in ("same-origin", "none"):
        raise HTTPException(status_code=403, detail="Cross-site access denied")


def _get_watched_local_roots() -> List[tuple]:
    # Never expose server container filesystem in cloud environments (e.g. Render)
    if os.environ.get("RENDER") or os.environ.get("DYNO") or os.environ.get("K_SERVICE"):
        return []
    home = os.path.expanduser("~")
    candidates = [
        ("Downloads", os.path.join(home, "Downloads")),
        ("Documents", os.path.join(home, "Documents")),
        ("Desktop", os.path.join(home, "Desktop")),
        ("OneDrive Downloads", os.path.join(home, "OneDrive", "Downloads")),
        ("OneDrive Documents", os.path.join(home, "OneDrive", "Documents")),
        ("OneDrive Desktop", os.path.join(home, "OneDrive", "Desktop")),
    ]
    seen_real = set()
    roots = []
    for label, path in candidates:
        if os.path.isdir(path):
            rp = os.path.normcase(os.path.realpath(path))
            if rp not in seen_real:
                seen_real.add(rp)
                roots.append((label, path))
    return roots


@app.get("/api/local-device/files")
def list_local_device_files(request: Request):
    _verify_direct_local_browser(request)
    roots = _get_watched_local_roots()
    if not roots:
        raise HTTPException(status_code=404, detail="No local user folders in cloud environment")

    now_ts = time.time()
    discovered = []
    project_real = os.path.normcase(os.path.realpath(BASE_DIR))

    for label, root_dir in roots:
        for cur_root, dirs, files in os.walk(root_dir):
            rel_dir = os.path.relpath(cur_root, root_dir)
            depth = 0 if rel_dir == "." else len(rel_dir.split(os.sep))
            if depth >= 3:
                dirs[:] = []
            else:
                dirs[:] = [
                    d for d in dirs
                    if not d.startswith(".") and not d.startswith("$") and d not in _SKIP_DIRS
                ]

            if os.path.normcase(os.path.realpath(cur_root)).startswith(project_real):
                continue

            for fname in files:
                if fname.startswith(".") or fname.startswith("~$"):
                    continue
                ext = os.path.splitext(fname)[1].lower()
                if not ext or ext in _SKIP_EXTS:
                    continue
                full_path = os.path.join(cur_root, fname)
                try:
                    st = os.stat(full_path)
                except OSError:
                    continue
                if st.st_size <= 0 or st.st_size > _MAX_AUTO_SYNC_BYTES:
                    continue
                # Wait at least 1.5s after last write so active downloads finish cleanly
                if (now_ts - st.st_mtime) < 1.5:
                    continue

                rel_file = os.path.relpath(full_path, root_dir).replace("\\", "/")
                source_key = f"local::{label}/{rel_file}::{st.st_size}::{int(st.st_mtime)}"
                token = hashlib.sha256(_LOCAL_DEVICE_SECRET + full_path.encode("utf-8", "ignore")).hexdigest()[:32]
                _LOCAL_TOKEN_MAP[token] = full_path
                mime_guess, _ = mimetypes.guess_type(fname)
                discovered.append({
                    "token": token,
                    "name": fname,
                    "folder": label,
                    "relative_path": f"{label}/{rel_file}",
                    "size_bytes": st.st_size,
                    "mtime_ms": int(st.st_mtime * 1000),
                    "mime_type": mime_guess or "application/octet-stream",
                    "source_key": source_key
                })

    # Newest downloaded / modified files first!
    discovered.sort(key=lambda x: x["mtime_ms"], reverse=True)
    return {
        "mode": "local_loopback",
        "folders": [lbl for lbl, _ in roots],
        "count": len(discovered),
        "files": discovered
    }


@app.get("/api/local-device/read")
def read_local_device_file(token: str, request: Request):
    _verify_direct_local_browser(request)
    full_path = _LOCAL_TOKEN_MAP.get(token)
    if not full_path or not os.path.isfile(full_path):
        raise HTTPException(status_code=404, detail="Local file token expired or file moved")
    mime_guess, _ = mimetypes.guess_type(full_path)
    return FileResponse(path=full_path, media_type=mime_guess or "application/octet-stream")


# Static files mounting
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

@app.get("/download-app")
def download_android_apk():
    apk_path = os.path.join(BASE_DIR, "Aegis-AI-File-Manager.apk")
    if not os.path.exists(apk_path):
        raise HTTPException(status_code=404, detail="Android APK has not been built yet.")
    return FileResponse(
        path=apk_path,
        filename="Aegis-AI-File-Manager.apk",
        media_type="application/vnd.android.package-archive"
    )

@app.get("/")
def serve_index():
    index_file = os.path.join(STATIC_DIR, "index.html")
    if os.path.exists(index_file):
        return FileResponse(index_file)
    return {"message": "AI File Manager API is running. UI loading..."}

if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", 8000))
    uvicorn.run("app:app", host="0.0.0.0", port=port, reload=True)
