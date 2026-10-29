# Aegis AI File Manager 🛡️📁

A modern, intelligent AI-powered file manager web application built with FastAPI and modern responsive UI. It automatically reads through document contents (PDF, Word DOCX, Markdown, Text, Code, CSV), performs semantic context segregation, proposes automatic AI filenames, provides full-text deep search, and protects files with an intelligent retention lifecycle system.

---

## 🌟 Key Features

### 1. 🗂️ Intelligent File Segregation (Type & Context)
- **Context-Aware Sorting**: Reads inside document bodies and automatically classifies files into semantic categories:
  - 📚 **Study & Education**: Lecture notes, textbooks, syllabi, assignments, academic papers
  - 💳 **Finance & Invoices**: Billing statements, AWS/cloud receipts, budgets, purchase orders
  - 💼 **Work & Projects**: Specifications, sprint plans, architecture docs, team roadmaps
  - ⚖️ **Legal & Identity**: Non-disclosure agreements (NDAs), contracts, privacy policies
  - 💻 **Code & Technical**: Python scripts, config files, SQL schemas, API endpoints
  - 💡 **Personal & Notes**: Journals, daily scratchpads, checklists
- **Type Sorting**: Quickly filter or group by Documents, Code & Data, Spreadsheets, Images, Archives.
- **View Switcher**: Seamlessly toggle between "Group by Context", "Group by Type", or flat "All Files" view.

### 2. ✨ Automatic & Manual File Renaming
- **AI Document Reading Engine**: Reads through PDFs (via `pypdf`), Word documents (via `python-docx`), Markdown, and plain text.
- **Automatic Standardized Renaming**: Analyzes document titles, dates, and subjects to propose clean names like `Finance_Receipt_AWS_Mar2026.txt` or `Study_Distributed_Systems_Lecture4.md`.
- **1-Click Apply**: Batch apply AI names or accept suggestions individually.
- **Manual Inline Renaming**: Direct editing with extension protection.

### 3. 🔍 Search Taskbar
- **Ctrl + K Shortcut**: Instant keyboard focus.
- **Deep Full-Text Search**: Matches filename, tags, context, and **deep inside the extracted document body**.
- **Live Autocomplete Dropdown**: Real-time matching previews with context badges.

### 4. ⏳ Retention Guardian (1 or 2 Months Deletion Permission)
- **Configurable Policy**: 1 Month (30 days), 2 Months (60 days), or 90 days.
- **🛡️ Important Tag Immunity Guarantee**: Any file tagged `important` (or pinned) is strictly protected and will **NEVER** be deleted by retention cleanup.
- **Explicit Permission Review**: When non-important files exceed the retention threshold:
  - An alert banner notifies you: *"⚠️ 2 files are older than 30 days and ready for deletion permission review!"*
  - Interactive Review Modal lets you:
    1. 🗑️ **Approve & Delete**: Permanently clean up selected stale files.
    2. ⏳ **Extend Retention**: Keep files for another 30 or 60 days.
    3. 🛡️ **Mark as 'Important'**: Add the `important` tag to protect them permanently.
- **Age Simulator**: Built-in simulator to test file ages (e.g. simulate 35 days or 65 days old) for instant demonstration!

### 5. 🏷️ Flexible Tags System
- Pre-built quick tags: `important`, `temporary`, `study`, `work`, `finance`, `draft`, `receipt`.
- Color-coded tag chips with instant filter capability.
- Add or remove tags on the fly per file card or inside the document inspector.

---

## 🚀 Getting Started

### Prerequisites
- Python 3.10+ (Tested on Python 3.14)

### Quick Run
1. Navigate to the project folder:
   ```powershell
   cd C:\Users\HP\.gemini\antigravity\scratch\ai-file-manager
   ```
2. For local use:
   - Double-click [`run.bat`](file:///C:/Users/HP/.gemini/antigravity/scratch/ai-file-manager/run.bat) or run `python app.py`
   - Access at `http://localhost:8000`
3. For sharing to other devices (phones, tablets, external friends):
   - Double-click [`share.bat`](file:///C:/Users/HP/.gemini/antigravity/scratch/ai-file-manager/share.bat)
   - It will start the server and give you an instant, secure `https://....trycloudflare.com` link that works anywhere!

### 🎲 Instant Testing with Sample Data
Click the **"Load Samples"** button at the top of the app. It will instantly generate 6 realistic files across multiple contexts and ages, demonstrating:
- An expired temporary invoice (45 days old) eligible for deletion review.
- A confidential legal NDA (75 days old) protected by the `important` tag.
- Computer science lecture notes tagged `study`.
- An expired product roadmap draft (65 days old).
- A departmental expense CSV and python security middleware.
