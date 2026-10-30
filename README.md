# Aegis AI File Manager 🛡️📁

A modern, intelligent AI-powered file manager available both as a **Web Application** (FastAPI + responsive UI) and an **Android Phone App** (`Aegis-AI-File-Manager.apk`). It starts with a clean empty vault and automatically reads inside your documents (PDF, Word `.docx`, Markdown, Text, Code, CSV), performs semantic context segregation, proposes standardized AI filenames, provides full-text deep search, and protects files with an intelligent retention lifecycle guardian.

---

## 🌟 Core Features (Web & Android App)

### 1. 🗂️ Intelligent File Segregation (Type & Context)
- **Context-Aware Sorting**: Reads inside document bodies and automatically classifies files into semantic categories:
  - 📚 **Study & Education**: Lecture notes, textbooks, syllabi, assignments, academic papers
  - 💳 **Finance & Invoices**: Billing statements, receipts, budgets, purchase orders
  - 💼 **Work & Projects**: Specifications, sprint plans, architecture docs, team roadmaps
  - ⚖️ **Legal & Identity**: Non-disclosure agreements (NDAs), contracts, privacy policies
  - 💻 **Code & Technical**: Python/JS scripts, config files, SQL schemas, API endpoints
  - 💡 **Personal & Notes**: Journals, daily scratchpads, checklists
- **Type Sorting**: Filter or group by Documents, Code & Data, Spreadsheets, Images, Media, or Archives.
- **View Switcher**: Seamlessly toggle between **Group by Context**, **Group by Type**, or flat **All Files** view.

### 2. ✨ Automatic & Manual File Renaming
- **AI Document Reading Engine**: Reads through PDFs (`pypdf` on Web / `pdf.js` on Android), Word documents (`python-docx` on Web / `JSZip` + XML parser on Android), Markdown, CSV, and plain text.
- **Automatic Standardized Renaming**: Analyzes document headings, dates, and subjects to propose clean names like `Finance_Receipt_AWS_Mar2026.txt` or `Study_Physics_Lecture_3.docx`.
- **1-Click Apply**: Accept AI suggestions individually, batch-rename all pending files, or auto-rename on upload.
- **Manual Renaming**: Touch-friendly inline rename modal with automatic file-extension preservation.

### 3. 🔍 Search Taskbar
- **`Ctrl + K` Shortcut**: Instant keyboard focus on desktop, plus dedicated mobile search bar.
- **Deep Full-Text Search**: Matches filename, tags, semantic context, AI summary, and **deep inside the extracted document body**.
- **Live Autocomplete Dropdown**: Real-time matching previews with context badges.

### 4. ⏳ Retention Guardian (1 or 2 Months Deletion Permission)
- **Configurable Policy**: **1 Month (30 days)**, **2 Months (60 days)**, or **90 days**.
- **🛡️ `important` Tag Immunity**: Any file saved with the `important` tag is strictly protected and will **never** be flagged or deleted by retention cleanup.
- **Explicit Permission Review**: When non-important files exceed the retention threshold, Aegis asks your permission to:
  1. 🗑️ **Approve & Delete** selected stale files
  2. ⏳ **Extend Retention** (+30 or +60 days)
  3. 🛡️ **Protect as `important`** permanently

### 5. 🏷️ Tags & Themes
- Quick & custom tags (`important`, `temporary`, `study`, `work`, `finance`, `draft`, `receipt`, or any custom tag).
- 4 built-in themes: **🌿 Emerald Mint** (default), **🔮 Royal Amethyst**, **⚡ Cyber Titanium**, and **☀️ Nordic Light**.

### 6. 🔒 Zero-Knowledge End-to-End Encryption (E2EE) & Encrypted Sharing
- **AES-256-GCM Vault Encryption**: Your Vault Passphrase derives a 256-bit key locally in your browser (`PBKDF2-HMAC-SHA256`, 210,000 iterations) that **never leaves your device**.
- **Client-Side AI Before Encryption**: Documents (`PDF`, `.docx`, `TXT`, `MD`, `CSV`, code) are read and classified by AI inside your browser first; both the raw file (`AE2E\x01` binary envelope) and all metadata (filenames, extracted text, AI summary, tags) are encrypted before upload.
- **Zero-Knowledge Share Links (`#share=<id>&key=<secret>`)**: Share individual files using ephemeral 256-bit AES-GCM keys placed strictly after `#` in the URL (never sent to the server), with configurable expiry (24h / 7d / 30d) and optional **Burn after 1st download**.
- **Live Server Ciphertext Proof**: Open any file's **E2EE Security Proof** tab in the Document Inspector to verify live hexadecimal ciphertext stored on disk.

---

## 📱 Android Phone App (`Aegis-AI-File-Manager.apk`)

The Android app (`com.aegis.filemanager`) runs **100% offline on your phone** with its own private on-device vault:
- **Install from Website**: Open the web app on your phone and tap **Download APK** in the menu drawer (`/download-app`), or copy `Aegis-AI-File-Manager.apk` directly to your phone.
- **Share to Aegis**: Share any PDF, `.docx`, text, or image from WhatsApp, Gmail, or Android Files directly into **Aegis AI Vault** from the Android Share sheet.
- **Save to Phone Downloads**: Tap download on any vaulted file to export it directly into your phone's `Downloads` folder.
- **Rebuild APK from Source**: Run `android-app\build-apk.bat`.

---

## 💻 Running the Web App

### Local Run
1. Run `run.bat` or `python app.py`
2. Open `http://localhost:8000`

### 24/7 Cloud Deployment (Render.com)
This repository includes [`render.yaml`](render.yaml) pre-configured with service name `ai-file-manager` (`uvicorn app:app --host 0.0.0.0 --port $PORT`).
