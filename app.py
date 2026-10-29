import os
import shutil
import uuid
from datetime import datetime, timezone, timedelta
from typing import List, Optional
from fastapi import FastAPI, UploadFile, File, Form, HTTPException, Query
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from database import (
    get_all_files, get_file_by_id, insert_file, update_file,
    delete_file_record, get_settings, update_settings, ensure_db
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
STATIC_DIR = os.path.join(BASE_DIR, "static")

os.makedirs(STORAGE_DIR, exist_ok=True)
os.makedirs(STATIC_DIR, exist_ok=True)

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
        safe_filename = upload.filename
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

# Static files mounting
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

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
