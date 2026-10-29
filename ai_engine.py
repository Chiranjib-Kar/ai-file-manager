import os
import re
from datetime import datetime
from typing import Dict, Any, List

CONTEXT_CATEGORIES = {
    "Study & Education": {
        "keywords": [
            "syllabus", "lecture", "professor", "assignment", "homework", "exam", "course",
            "study", "chapter", "textbook", "university", "college", "student", "curriculum",
            "theorem", "quiz", "class", "tutorial", "semester", "bibliography", "physics",
            "calculus", "biology", "chemistry", "algorithm", "cs", "history", "notes", "thesis"
        ],
        "prefix": "Study"
    },
    "Finance & Invoices": {
        "keywords": [
            "invoice", "receipt", "billing", "payment", "tax", "subtotal", "total", "amount",
            "balance", "usd", "eur", "inr", "gbp", "bank", "account", "transaction", "salary",
            "payroll", "expense", "budget", "statement", "wire", "due date", "remittance",
            "credit", "debit", "price", "vat", "gst", "financial"
        ],
        "prefix": "Finance"
    },
    "Work & Projects": {
        "keywords": [
            "sprint", "project", "client", "roadmap", "meeting", "deliverables", "milestone",
            "agile", "jira", "specification", "architecture", "status report", "proposal",
            "executive", "strategy", "deliverable", "stakeholder", "presentation", "brief",
            "standup", "kpi", "okr", "quarterly", "team"
        ],
        "prefix": "Work"
    },
    "Legal & Identity": {
        "keywords": [
            "agreement", "terms", "conditions", "nda", "non-disclosure", "contract", "parties",
            "confidentiality", "privacy policy", "license", "passport", "signature", "clause",
            "liability", "governing law", "jurisdiction", "indemnity", "intellectual property",
            "warranties", "compliance", "copyright", "trademark", "consent"
        ],
        "prefix": "Legal"
    },
    "Code & Technical": {
        "keywords": [
            "def ", "function ", "import ", "const ", "class ", "return ", "endpoint", "api",
            "docker", "kubernetes", "sql", "database", "schema", "repository", "git", "config",
            "yaml", "json", "backend", "frontend", "server", "null", "undefined", "interface"
        ],
        "prefix": "Tech"
    },
    "Personal & Notes": {
        "keywords": [
            "journal", "diary", "todo", "bucket list", "shopping", "recipe", "personal",
            "reminder", "thought", "draft", "family", "vacation", "trip", "reflection",
            "hobby", "daily"
        ],
        "prefix": "Personal"
    }
}

def analyze_document_context(filename: str, text: str) -> Dict[str, Any]:
    """
    Categorizes the document context, generates AI summary, suggests tags,
    and proposes an automatic standardized name.
    """
    combined_content = f"{filename} {text[:4000]}".lower()

    # Normalize underscores and hyphens into spaces for matching
    normalized_content = re.sub(r'[_.\-]+', ' ', combined_content)

    # 1. Score each category
    scores = {}
    for category, config in CONTEXT_CATEGORIES.items():
        score = 0
        for kw in config["keywords"]:
            count = len(re.findall(r'\b' + re.escape(kw) + r'\b', normalized_content))
            score += count * 3 if kw in filename.lower() else count
        scores[category] = score

    # Check extension hints
    ext = os.path.splitext(filename)[1].lower()
    if ext in {".py", ".js", ".ts", ".html", ".css", ".sql", ".sh"}:
        scores["Code & Technical"] = scores.get("Code & Technical", 0) + 15

    best_category = "Personal & Notes"
    best_score = 0
    for cat, score in scores.items():
        if score > best_score:
            best_score = score
            best_category = cat

    # 2. Extract potential title / subject
    lines = [line.strip() for line in text.split("\n") if line.strip() and len(line.strip()) > 3]
    candidate_title = ""
    for line in lines[:8]:
        cleaned_line = re.sub(r'[#*_\-=\[\]|]', '', line).strip()
        if 5 <= len(cleaned_line) <= 65 and not re.search(r'^(page|copyright|http|all rights)', cleaned_line, re.I):
            candidate_title = cleaned_line
            break

    if not candidate_title:
        base = os.path.splitext(filename)[0]
        # Clean underscores/dashes
        clean_base = re.sub(r'[_.\-]+', ' ', base).title()
        candidate_title = clean_base

    # 3. Detect date or keywords
    date_match = re.search(r'\b(20\d{2}[-_/]\d{1,2}(?:[-_/]\d{1,2})?|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec|Q[1-4])\b', text, re.I)
    date_part = date_match.group(0).replace("/", "-") if date_match else datetime.now().strftime("%Y-%m")

    # 4. Propose standardized AI filename
    prefix = CONTEXT_CATEGORIES.get(best_category, {}).get("prefix", "Doc")
    sanitized_title = re.sub(r'[^a-zA-Z0-9]+', '_', candidate_title).strip('_')
    if len(sanitized_title) > 35:
        sanitized_title = sanitized_title[:35].rstrip('_')

    ai_suggested_name = f"{prefix}_{sanitized_title}_{date_part}{ext}"
    ai_rename_reason = f"Identified topic as '{candidate_title}' under {best_category} with date reference ({date_part})."

    # 5. Suggest Tags
    suggested_tags = []
    # Always suggest context tag in lowercase
    if best_category == "Study & Education":
        suggested_tags.append("study")
    elif best_category == "Finance & Invoices":
        suggested_tags.append("finance")
    elif best_category == "Work & Projects":
        suggested_tags.append("work")
    elif best_category == "Legal & Identity":
        suggested_tags.append("legal")
        suggested_tags.append("important")  # Legal docs are typically important!
    elif best_category == "Code & Technical":
        suggested_tags.append("code")

    # Look for specific high-signal keywords
    is_temp = bool(re.search(r'\b(receipt|temporary|temp|draft|scratch|cache)\b', normalized_content))
    if is_temp:
        suggested_tags.append("temporary")

    # Important criteria: contracts, NDAs, passports, critical/urgent, or explicit 'important'
    # Do not auto-mark temporary receipts as important just because of sales tax
    if re.search(r'\b(urgent|critical|confidential|contract|passport|license|agreement|nda|important)\b', normalized_content):
        if not (is_temp and "receipt" in normalized_content):
            if "important" not in suggested_tags:
                suggested_tags.append("important")
    elif re.search(r'\b(tax return|tax audit|income tax|w2|1099)\b', normalized_content):
        if "important" not in suggested_tags:
            suggested_tags.append("important")
    if re.search(r'\b(invoice|billing|bill)\b', combined_content):
        if "invoice" not in suggested_tags:
            suggested_tags.append("invoice")

    # Deduplicate tags
    suggested_tags = list(dict.fromkeys(suggested_tags))
    if not suggested_tags:
        suggested_tags = ["general"]

    # 6. Generate Summary
    summary = ""
    if lines:
        sample_lines = lines[:4]
        summary_candidate = ". ".join(sample_lines[:2])
        if len(summary_candidate) > 200:
            summary = summary_candidate[:200] + "..."
        else:
            summary = summary_candidate
    else:
        summary = f"A {best_category.lower()} document with {len(text)} characters."

    return {
        "context_category": best_category,
        "ai_suggested_name": ai_suggested_name,
        "ai_rename_reason": ai_rename_reason,
        "suggested_tags": suggested_tags,
        "summary": summary
    }
