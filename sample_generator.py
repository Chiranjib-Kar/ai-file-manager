import os
import uuid
from datetime import datetime, timezone, timedelta
from typing import List, Dict, Any
import docx
from database import insert_file, get_all_files, DB_FILE
from document_reader import extract_document_text, categorize_file_type
from ai_engine import analyze_document_context

STORAGE_DIR = os.path.join(os.path.dirname(__file__), "storage")

def generate_sample_dataset() -> List[Dict[str, Any]]:
    os.makedirs(STORAGE_DIR, exist_ok=True)
    now = datetime.now(timezone.utc)

    # 1. Old Temporary Cloud Invoice (Age: 45 days -> Over 1 month! Subject to retention review!)
    file1_name = "Scan_Receipt_Invoice_AWS_Mar2026.txt"
    file1_path = os.path.join(STORAGE_DIR, file1_name)
    file1_content = """Amazon Web Services Inc.
INVOICE #INV-9823412
Billing Date: March 15, 2026
Due Date: April 15, 2026

Account ID: 9942-1029-3819
Services:
- Amazon EC2 Compute Linux (t4g.xlarge): $42.50
- Amazon S3 Standard Storage (2.4 TB): $55.20
- Amazon RDS PostgreSQL Multi-AZ: $128.00
- Data Transfer Out: $14.15

Subtotal: $239.85
Estimated Tax (GST 18%): $43.17
Total Balance Due: $283.02 USD
Status: Paid via Credit Card ending in 4091.

Note: This is a temporary billing receipt for Q1 infrastructure review.
"""
    with open(file1_path, "w", encoding="utf-8") as f:
        f.write(file1_content)

    # 2. Important Legal Agreement (Age: 75 days -> Over 2 months, but protected because of 'important' tag!)
    file2_name = "Master_NonDisclosure_Agreement_2026.docx"
    file2_path = os.path.join(STORAGE_DIR, file2_name)
    doc = docx.Document()
    doc.add_heading("MUTUAL NON-DISCLOSURE AND CONFIDENTIALITY AGREEMENT", 0)
    p1 = doc.add_paragraph("This Agreement is entered into by and between Apex Systems Corp ('Disclosing Party') and Partner Innovations LLC ('Receiving Party').")
    p1.bold = True
    doc.add_heading("1. Confidential Information", level=1)
    doc.add_paragraph("The Receiving Party agrees to protect and maintain confidential all proprietary trade secrets, software source code, patents, financial data, and customer identities.")
    doc.add_heading("2. Term & Governing Law", level=1)
    doc.add_paragraph("This agreement shall remain strictly confidential in perpetuity and is governed by applicable commercial laws. This is a legally critical binding document.")
    doc.save(file2_path)

    # 3. Study Notes on Distributed Systems (Age: 12 days ago)
    file3_name = "CS701_Distributed_Systems_Lecture4.md"
    file3_path = os.path.join(STORAGE_DIR, file3_name)
    file3_content = """# Computer Science 701: Distributed Systems & Consensus
**Professor:** Dr. Eleanor Vance
**Course:** Advanced Algorithms & Scalability (Spring Semester)
**Topic:** Paxos vs Raft Consensus Protocols

## 1. The Consensus Problem
In an asynchronous distributed network, nodes must reach mutual agreement on values despite network partitions, latency jitter, and node fail-stop crashes.

### Key Guarantees:
- **Safety:** All non-faulty nodes decide on the same sequence of committed logs.
- **Liveness:** Some proposed value eventually gets chosen if a majority quorum is alive.

## 2. Raft Leader Election & Log Replication
Raft breaks consensus into 3 decoupled phases:
1. Leader Election (Heartbeat timeouts and term incrementation)
2. Log Replication (AppendEntries RPC)
3. Safety Invariant (Committed entries are permanent)

**Homework Assignment:** Implement a 3-node Raft leader election state machine in Python. Due next Monday.
"""
    with open(file3_path, "w", encoding="utf-8") as f:
        f.write(file3_content)

    # 4. Old Temporary Roadmap Draft (Age: 65 days ago -> Over 2 months! Eligible for deletion review!)
    file4_name = "temp_draft_product_roadmap_archive.txt"
    file4_path = os.path.join(STORAGE_DIR, file4_name)
    file4_content = """PRODUCT ROADMAP DRAFT (TEMPORARY SCRATCHPAD)
Date: February 2026
Sprint Planning Notes:

- Sprint 12: Mobile responsive navigation bar and quick filters
- Sprint 13: Elastic full-text indexing prototype
- Sprint 14: Dark mode accessibility contrast polish

Notes: This is a scratchpad draft from earlier this year. Can be discarded once final Jira tickets are created.
"""
    with open(file4_path, "w", encoding="utf-8") as f:
        f.write(file4_content)

    # 5. Financial Expense Spreadsheet (Age: 6 days ago)
    file5_name = "Q1_Departmental_Budget_Expenses.csv"
    file5_path = os.path.join(STORAGE_DIR, file5_name)
    file5_content = """Department,Category,Budget_Allocated,Actual_Spent,Variance,Quarter
Engineering,Cloud Hosting,$15000,$14200,+$800,Q1-2026
Engineering,Software Licenses,$8500,$9100,-$600,Q1-2026
Design,Figma & Adobe Subs,$3200,$3150,+$50,Q1-2026
Marketing,Search Engine Ads,$22000,$21800,+$200,Q1-2026
Human Resources,Recruitment Portals,$5000,$4600,+$400,Q1-2026
Operations,Office Ergonomics,$4000,$3950,+$50,Q1-2026
"""
    with open(file5_path, "w", encoding="utf-8") as f:
        f.write(file5_content)

    # 6. Technical Source Code (Age: 18 days ago)
    file6_name = "jwt_auth_security_middleware.py"
    file6_path = os.path.join(STORAGE_DIR, file6_name)
    file6_content = """import jwt
from fastapi import Request, HTTPException, status
from datetime import datetime, timezone

SECRET_KEY = "super-secret-hmac-sha256-key"
ALGORITHM = "HS256"

async def verify_jwt_token(request: Request):
    auth_header = request.headers.get("Authorization")
    if not auth_header or not auth_header.startswith("Bearer "):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Missing authorization header")
    token = auth_header.split(" ")[1]
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        return payload
    except Exception as e:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Invalid or expired token")
"""
    with open(file6_path, "w", encoding="utf-8") as f:
        f.write(file6_content)

    # Define specs for each sample
    sample_definitions = [
        {
            "filename": file1_name,
            "path": file1_path,
            "days_ago": 45,  # 1.5 months old (Expired under 30d retention!)
            "tags": ["finance", "temporary", "receipt"]
        },
        {
            "filename": file2_name,
            "path": file2_path,
            "days_ago": 75,  # 2.5 months old (Over 2 months, but PROTECTED because of 'important' tag!)
            "tags": ["important", "legal", "confidential"]
        },
        {
            "filename": file3_name,
            "path": file3_path,
            "days_ago": 12,
            "tags": ["study", "computer-science", "lecture"]
        },
        {
            "filename": file4_name,
            "path": file4_path,
            "days_ago": 65,  # > 2 months old (Expired under both 30d and 60d retention!)
            "tags": ["work", "temporary", "draft"]
        },
        {
            "filename": file5_name,
            "path": file5_path,
            "days_ago": 6,
            "tags": ["finance", "budget"]
        },
        {
            "filename": file6_name,
            "path": file6_path,
            "days_ago": 18,
            "tags": ["code", "security"]
        }
    ]

    created_records = []
    for item in sample_definitions:
        doc_info = extract_document_text(item["path"])
        ai_info = analyze_document_context(item["filename"], doc_info["text"])

        created_dt = (now - timedelta(days=item["days_ago"])).isoformat()
        file_stat = os.stat(item["path"])

        record = {
            "id": str(uuid.uuid4()),
            "filename": item["filename"],
            "original_filename": item["filename"],
            "storage_path": item["path"],
            "file_type": categorize_file_type(item["filename"]),
            "extension": os.path.splitext(item["filename"])[1].lower(),
            "size_bytes": file_stat.st_size,
            "created_at": created_dt,
            "updated_at": created_dt,
            "context_category": ai_info["context_category"],
            "tags": list(set(item["tags"] + ai_info["suggested_tags"])),
            "ai_summary": ai_info["summary"],
            "extracted_text": doc_info["text"],
            "ai_suggested_name": ai_info["ai_suggested_name"],
            "ai_rename_reason": ai_info["ai_rename_reason"],
            "word_count": doc_info["word_count"],
            "reading_time_minutes": doc_info["reading_time_minutes"],
            "is_pinned": False,
            "extended_until": None
        }

        # If it has important tag, ensure it's recorded
        insert_file(record)
        created_records.append(record)

    return created_records
