/**
 * Aegis AI File Manager - On-device backend for the Android app.
 *
 * This is a JavaScript port of the Python backend (app.py, ai_engine.py,
 * document_reader.py, retention_policy.py, database.py). It intercepts the
 * same `/api/...` fetch calls the website makes, so static/app.js runs
 * unchanged. Files and metadata are stored on the phone in IndexedDB.
 */
(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Storage (IndexedDB: "files" = metadata records, "blobs" = file contents)
  // ---------------------------------------------------------------------------
  const DB_NAME = 'aegis-vault';
  let dbPromise = null;

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('files')) db.createObjectStore('files', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('blobs')) db.createObjectStore('blobs');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  async function tx(store, mode, fn) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const t = db.transaction(store, mode);
      const s = t.objectStore(store);
      let result;
      Promise.resolve(fn(s)).then(r => { result = r; });
      t.oncomplete = () => resolve(result);
      t.onerror = () => reject(t.error);
    });
  }

  const reqP = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

  const db = {
    all: () => tx('files', 'readonly', s => reqP(s.getAll())),
    get: (id) => tx('files', 'readonly', s => reqP(s.get(id))),
    put: (rec) => tx('files', 'readwrite', s => { s.put(rec); return rec; }),
    del: (id) => tx('files', 'readwrite', s => { s.delete(id); }),
    putBlob: (id, blob) => tx('blobs', 'readwrite', s => { s.put(blob, id); }),
    getBlob: (id) => tx('blobs', 'readonly', s => reqP(s.get(id))),
    delBlob: (id) => tx('blobs', 'readwrite', s => { s.delete(id); }),
  };

  async function updateFile(id, updates) {
    const rec = await db.get(id);
    if (!rec) return null;
    Object.assign(rec, updates, { updated_at: new Date().toISOString() });
    await db.put(rec);
    return rec;
  }

  function getSettings() {
    try { return JSON.parse(localStorage.getItem('aegis_settings')) || { retention_days: 30 }; }
    catch (e) { return { retention_days: 30 }; }
  }
  function saveSettings(s) { localStorage.setItem('aegis_settings', JSON.stringify(s)); return s; }

  const uuid = () => (crypto.randomUUID ? crypto.randomUUID()
    : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
      }));

  // ---------------------------------------------------------------------------
  // Document reader (port of document_reader.py)
  // ---------------------------------------------------------------------------
  const TEXT_EXT = new Set(['.txt', '.md', '.markdown', '.csv', '.json', '.log', '.py', '.js', '.jsx', '.ts', '.tsx',
    '.html', '.css', '.xml', '.yaml', '.yml', '.sql', '.sh', '.bat', '.ini', '.conf', '.env', '.rst']);
  const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico']);
  const AUDIO_EXT = new Set(['.mp3', '.wav', '.ogg', '.m4a', '.flac']);
  const VIDEO_EXT = new Set(['.mp4', '.mov', '.avi', '.mkv', '.webm']);
  const ARCHIVE_EXT = new Set(['.zip', '.tar', '.gz', '.rar', '.7z']);

  function extOf(name) {
    const i = name.lastIndexOf('.');
    return i > 0 ? name.slice(i).toLowerCase() : '';
  }
  function baseOf(name) {
    const i = name.lastIndexOf('.');
    return i > 0 ? name.slice(0, i) : name;
  }

  function categorizeFileType(filename) {
    const e = extOf(filename);
    if (['.pdf', '.doc', '.docx', '.txt', '.rtf', '.odt', '.epub', '.pages', '.md'].includes(e)) return 'Document';
    if (IMAGE_EXT.has(e)) return 'Image';
    if (['.py', '.js', '.jsx', '.ts', '.tsx', '.html', '.css', '.json', '.xml', '.yaml', '.yml', '.sql', '.sh', '.bat'].includes(e)) return 'Code & Data';
    if (['.csv', '.xls', '.xlsx', '.tsv'].includes(e)) return 'Spreadsheet';
    if (ARCHIVE_EXT.has(e)) return 'Archive';
    if (AUDIO_EXT.has(e) || VIDEO_EXT.has(e)) return 'Media';
    return 'Other';
  }

  async function readPdf(blob) {
    if (!window.pdfjsLib) return '[PDF parser not available]';
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';
    const pdf = await window.pdfjsLib.getDocument({ data: await blob.arrayBuffer() }).promise;
    const pages = [];
    for (let i = 1; i <= Math.min(pdf.numPages, 20); i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      // Rebuild lines using the hasEOL flag pdf.js provides
      let line = '', text = '';
      for (const item of content.items) {
        line += item.str;
        if (item.hasEOL) { text += line + '\n'; line = ''; }
      }
      text += line;
      if (text.trim()) pages.push(text);
    }
    return pages.join('\n\n');
  }

  async function readDocx(blob) {
    if (!window.JSZip) return '[Word docx parser not available]';
    const zip = await window.JSZip.loadAsync(await blob.arrayBuffer());
    const xmlFile = zip.file('word/document.xml');
    if (!xmlFile) return '[DOCX Parsing Notice: missing document.xml]';
    const xml = new DOMParser().parseFromString(await xmlFile.async('string'), 'application/xml');
    const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
    const paras = [];
    for (const p of xml.getElementsByTagNameNS(W, 'p')) {
      const t = Array.from(p.getElementsByTagNameNS(W, 't')).map(n => n.textContent).join('');
      if (t.trim()) paras.push(t);
    }
    return paras.join('\n\n');
  }

  async function extractDocumentText(blob, filename, maxChars = 15000) {
    const e = extOf(filename);
    let text = '';
    try {
      if (e === '.pdf') text = await readPdf(blob);
      else if (e === '.docx') text = await readDocx(blob);
      else if (e === '.doc') text = '[Word docx parser fallback or binary format]';
      else if (TEXT_EXT.has(e)) text = (await blob.text()).slice(0, maxChars);
      else if (IMAGE_EXT.has(e)) text = `[Image Asset: ${filename} - ${blob.size} bytes. Visual content file.]`;
      else {
        const head = new Uint8Array(await blob.slice(0, 1024).arrayBuffer());
        const latin = Array.from(head, b => String.fromCharCode(b)).join('');
        const parts = latin.match(/[ -~]{4,}/g);
        text = parts ? parts.slice(0, 30).join(' ') : `[Binary/Data File: ${filename}]`;
      }
    } catch (err) {
      text = `[Parsing Notice: ${err.message || err}]`;
    }
    const cleaned = text.replace(/\s+/g, ' ').trim();
    const words = cleaned ? cleaned.split(' ').length : 0;
    return {
      text: text.slice(0, maxChars),
      word_count: words,
      reading_time_minutes: words > 0 ? Math.max(1, Math.ceil(words / 200)) : 0,
    };
  }

  // ---------------------------------------------------------------------------
  // AI context engine (port of ai_engine.py)
  // ---------------------------------------------------------------------------
  const CONTEXT_CATEGORIES = {
    'Study & Education': { prefix: 'Study', keywords: ['syllabus', 'lecture', 'professor', 'assignment', 'homework', 'exam', 'course',
      'study', 'chapter', 'textbook', 'university', 'college', 'student', 'curriculum', 'theorem', 'quiz', 'class', 'tutorial',
      'semester', 'bibliography', 'physics', 'calculus', 'biology', 'chemistry', 'algorithm', 'cs', 'history', 'notes', 'thesis'] },
    'Finance & Invoices': { prefix: 'Finance', keywords: ['invoice', 'receipt', 'billing', 'payment', 'tax', 'subtotal', 'total', 'amount',
      'balance', 'usd', 'eur', 'inr', 'gbp', 'bank', 'account', 'transaction', 'salary', 'payroll', 'expense', 'budget', 'statement',
      'wire', 'due date', 'remittance', 'credit', 'debit', 'price', 'vat', 'gst', 'financial'] },
    'Work & Projects': { prefix: 'Work', keywords: ['sprint', 'project', 'client', 'roadmap', 'meeting', 'deliverables', 'milestone',
      'agile', 'jira', 'specification', 'architecture', 'status report', 'proposal', 'executive', 'strategy', 'deliverable',
      'stakeholder', 'presentation', 'brief', 'standup', 'kpi', 'okr', 'quarterly', 'team'] },
    'Legal & Identity': { prefix: 'Legal', keywords: ['agreement', 'terms', 'conditions', 'nda', 'non-disclosure', 'contract', 'parties',
      'confidentiality', 'privacy policy', 'license', 'passport', 'signature', 'clause', 'liability', 'governing law', 'jurisdiction',
      'indemnity', 'intellectual property', 'warranties', 'compliance', 'copyright', 'trademark', 'consent'] },
    'Code & Technical': { prefix: 'Tech', keywords: ['def ', 'function ', 'import ', 'const ', 'class ', 'return ', 'endpoint', 'api',
      'docker', 'kubernetes', 'sql', 'database', 'schema', 'repository', 'git', 'config', 'yaml', 'json', 'backend', 'frontend',
      'server', 'null', 'undefined', 'interface'] },
    'Personal & Notes': { prefix: 'Personal', keywords: ['journal', 'diary', 'todo', 'bucket list', 'shopping', 'recipe', 'personal',
      'reminder', 'thought', 'draft', 'family', 'vacation', 'trip', 'reflection', 'hobby', 'daily'] },
  };

  const reEscape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const titleCase = (s) => s.toLowerCase().replace(/[a-z]+/g, w => w[0].toUpperCase() + w.slice(1));

  function analyzeDocumentContext(filename, text) {
    const combined = `${filename} ${text.slice(0, 4000)}`.toLowerCase();
    const normalized = combined.replace(/[_.\-]+/g, ' ');
    const fnLower = filename.toLowerCase();

    const scores = {};
    for (const [cat, cfg] of Object.entries(CONTEXT_CATEGORIES)) {
      let score = 0;
      for (const kw of cfg.keywords) {
        const count = (normalized.match(new RegExp('\\b' + reEscape(kw) + '\\b', 'g')) || []).length;
        score += fnLower.includes(kw) ? count * 3 : count;
      }
      scores[cat] = score;
    }
    const ext = extOf(filename);
    if (['.py', '.js', '.ts', '.html', '.css', '.sql', '.sh'].includes(ext)) scores['Code & Technical'] += 15;

    let best = 'Personal & Notes', bestScore = 0;
    for (const [cat, sc] of Object.entries(scores)) if (sc > bestScore) { bestScore = sc; best = cat; }

    const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 3);
    let title = '';
    for (const line of lines.slice(0, 8)) {
      const cleaned = line.replace(/[#*_\-=\[\]|]/g, '').trim();
      if (cleaned.length >= 5 && cleaned.length <= 65 && !/^(page|copyright|http|all rights)/i.test(cleaned)) { title = cleaned; break; }
    }
    if (!title) title = titleCase(baseOf(filename).replace(/[_.\-]+/g, ' '));

    const dm = text.match(/\b(20\d{2}[-_/]\d{1,2}(?:[-_/]\d{1,2})?|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec|Q[1-4])\b/i);
    const now = new Date();
    const datePart = dm ? dm[0].replace(/\//g, '-') : `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

    const prefix = CONTEXT_CATEGORIES[best].prefix;
    let sanitized = title.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    if (sanitized.length > 35) sanitized = sanitized.slice(0, 35).replace(/_+$/, '');

    const tags = [];
    const catTag = { 'Study & Education': ['study'], 'Finance & Invoices': ['finance'], 'Work & Projects': ['work'],
      'Legal & Identity': ['legal', 'important'], 'Code & Technical': ['code'] }[best] || [];
    tags.push(...catTag);
    const isTemp = /\b(receipt|temporary|temp|draft|scratch|cache)\b/.test(normalized);
    if (isTemp) tags.push('temporary');
    if (/\b(urgent|critical|confidential|contract|passport|license|agreement|nda|important)\b/.test(normalized)) {
      if (!(isTemp && normalized.includes('receipt')) && !tags.includes('important')) tags.push('important');
    } else if (/\b(tax return|tax audit|income tax|w2|1099)\b/.test(normalized) && !tags.includes('important')) {
      tags.push('important');
    }
    if (/\b(invoice|billing|bill)\b/.test(combined) && !tags.includes('invoice')) tags.push('invoice');
    const uniqTags = [...new Set(tags)];

    let summary;
    if (lines.length) {
      const cand = lines.slice(0, 2).join('. ');
      summary = cand.length > 200 ? cand.slice(0, 200) + '...' : cand;
    } else {
      summary = `A ${best.toLowerCase()} document with ${text.length} characters.`;
    }

    return {
      context_category: best,
      ai_suggested_name: `${prefix}_${sanitized}_${datePart}${ext}`,
      ai_rename_reason: `Identified topic as '${title}' under ${best} with date reference (${datePart}).`,
      suggested_tags: uniqTags.length ? uniqTags : ['general'],
      summary,
    };
  }

  // ---------------------------------------------------------------------------
  // Retention policy (port of retention_policy.py)
  // ---------------------------------------------------------------------------
  const DAY = 86400000;
  const ageDays = (rec) => rec.created_at ? Math.max(0, Math.floor((Date.now() - new Date(rec.created_at)) / DAY)) : 0;

  function retentionStatus(rec, retentionDays) {
    const tags = (rec.tags || []).map(t => t.toLowerCase());
    const days = ageDays(rec);
    const base = { days_old: days, retention_days: retentionDays };
    if (tags.includes('important') || rec.is_pinned) {
      return { ...base, status: 'protected', is_protected: true, badge_text: 'Protected', badge_color: 'emerald',
        reason: "Protected by 'important' tag (excluded from cleanup)." };
    }
    if (rec.extended_until) {
      const ext = new Date(rec.extended_until);
      if (Date.now() < ext) {
        const left = Math.max(1, Math.floor((ext - Date.now()) / DAY));
        return { ...base, status: 'extended', is_protected: false, badge_text: `Extended (${left}d left)`, badge_color: 'blue',
          reason: `Retention extended until ${ext.toDateString()}.` };
      }
    }
    const remaining = retentionDays - days;
    if (remaining <= 0) {
      return { ...base, status: 'expired', is_protected: false, badge_text: `Expired (${Math.abs(remaining)}d overdue)`, badge_color: 'rose',
        reason: `File is ${days} days old (exceeds ${retentionDays}-day limit). Pending user review to delete.` };
    }
    if (remaining <= 7) {
      return { ...base, status: 'expiring_soon', is_protected: false, badge_text: `Expires in ${remaining}d`, badge_color: 'amber',
        reason: `File will reach ${retentionDays}-day retention limit in ${remaining} days.` };
    }
    return { ...base, status: 'active', is_protected: false, badge_text: `Active (${remaining}d left)`, badge_color: 'slate',
      reason: `Active file. ${remaining} days remaining before cleanup review.` };
  }

  const retentionDays = () => parseInt(getSettings().retention_days || 30, 10);
  const enrich = (rec, rd) => ({ ...rec, retention_info: retentionStatus(rec, rd) });

  async function deleteRecord(id) {
    await db.delBlob(id);
    await db.del(id);
  }

  // ---------------------------------------------------------------------------
  // API routes (same contract as app.py)
  // ---------------------------------------------------------------------------
  async function listFiles(q) {
    const rd = retentionDays();
    let files = (await db.all()).map(f => enrich(f, rd));
    const query = (q.get('query') || '').trim().toLowerCase();
    if (query) {
      files = files.filter(f => [f.filename, f.original_filename, f.context_category, f.ai_summary, f.extracted_text]
        .some(v => (v || '').toLowerCase().includes(query)) || (f.tags || []).some(t => t.toLowerCase().includes(query)));
    }
    const ctx = q.get('context'); if (ctx && ctx !== 'All') files = files.filter(f => f.context_category === ctx);
    const type = q.get('type'); if (type && type !== 'All') files = files.filter(f => f.file_type === type);
    const tag = q.get('tag');
    if (tag && tag !== 'All') files = files.filter(f => (f.tags || []).some(t => t.toLowerCase() === tag.toLowerCase()));
    const ret = q.get('retention');
    if (ret && ret !== 'All') {
      files = files.filter(f => ret === 'active' ? ['active', 'extended'].includes(f.retention_info.status) : f.retention_info.status === ret);
    }
    const by = q.get('sort_by') || 'date', dir = q.get('sort_order') === 'asc' ? 1 : -1;
    const key = { name: f => (f.filename || '').toLowerCase(), size: f => f.size_bytes || 0,
      retention: f => f.retention_info.days_old || 0 }[by] || (f => f.created_at || '');
    files.sort((a, b) => (key(a) > key(b) ? 1 : key(a) < key(b) ? -1 : 0) * dir);
    return files;
  }

  async function stats() {
    const rd = retentionDays();
    const files = await db.all();
    const categories = {}, tags_count = {};
    let expired = 0, protectedCount = 0;
    for (const f of files) {
      categories[f.context_category] = (categories[f.context_category] || 0) + 1;
      for (const t of f.tags || []) tags_count[t] = (tags_count[t] || 0) + 1;
      const st = retentionStatus(f, rd).status;
      if (st === 'expired') expired++; else if (st === 'protected') protectedCount++;
    }
    return { total_files: files.length, total_size_bytes: files.reduce((s, f) => s + (f.size_bytes || 0), 0), categories,
      tags_count, retention_days: rd, expired_files_count: expired, protected_files_count: protectedCount };
  }

  async function retentionOverview() {
    const rd = retentionDays();
    const files = (await db.all()).map(f => enrich(f, rd));
    const counts = { total: files.length, expired: 0, expiring_soon: 0, protected: 0, active: 0 };
    const pending = [];
    for (const f of files) {
      const st = f.retention_info.status;
      if (st === 'expired') { counts.expired++; pending.push(f); }
      else if (st === 'expiring_soon') counts.expiring_soon++;
      else if (st === 'protected') counts.protected++;
      else counts.active++;
    }
    return { retention_days: rd, counts, pending_review_files: pending, requires_permission: pending.length > 0 };
  }

  async function upload(form) {
    const autoRename = String(form.get('auto_rename')) === 'true';
    const initial = String(form.get('initial_tags') || '').split(',').map(t => t.trim()).filter(Boolean);
    const now = new Date().toISOString();
    const uploaded = [];
    for (const file of form.getAll('files')) {
      const name = (file.name || 'untitled').split(/[\\/]/).pop() || 'untitled';
      const doc = await extractDocumentText(file, name);
      const ai = analyzeDocumentContext(name, doc.text);
      const rec = {
        id: uuid(), filename: autoRename ? ai.ai_suggested_name : name, original_filename: name,
        mime_type: file.type || 'application/octet-stream', file_type: categorizeFileType(name), extension: extOf(name),
        size_bytes: file.size, created_at: now, updated_at: now, context_category: ai.context_category,
        tags: [...new Set([...initial, ...ai.suggested_tags])], ai_summary: ai.summary, extracted_text: doc.text,
        ai_suggested_name: ai.ai_suggested_name, ai_rename_reason: ai.ai_rename_reason, word_count: doc.word_count,
        reading_time_minutes: doc.reading_time_minutes, is_pinned: false, extended_until: null,
      };
      await db.putBlob(rec.id, file);
      await db.put(rec);
      uploaded.push(rec);
    }
    return { uploaded, count: uploaded.length };
  }

  async function retentionAction(body) {
    const results = { success: [], skipped_protected: [], errors: [] };
    for (const id of body.file_ids || []) {
      const rec = await db.get(id);
      if (!rec) { results.errors.push({ id, error: 'Not found' }); continue; }
      const important = (rec.tags || []).map(t => t.toLowerCase()).includes('important');
      if (body.action === 'delete') {
        // Safety: retention cleanup never deletes files tagged 'important'
        if (important) { results.skipped_protected.push({ id, filename: rec.filename, reason: "File is protected with 'important' tag" }); continue; }
        await deleteRecord(id);
        results.success.push({ id, filename: rec.filename, action: 'deleted' });
      } else if (body.action === 'extend') {
        const days = body.custom_extension_days || 30;
        await updateFile(id, { extended_until: new Date(Date.now() + days * DAY).toISOString() });
        results.success.push({ id, filename: rec.filename, action: `extended_${days}_days` });
      } else if (body.action === 'protect') {
        const tags = rec.tags || [];
        if (!important) tags.push('important');
        await updateFile(id, { tags });
        results.success.push({ id, filename: rec.filename, action: 'marked_important' });
      }
    }
    return results;
  }

  class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
  const need = (rec) => { if (!rec) throw new HttpError(404, 'File not found'); return rec; };

  async function route(method, path, q, body) {
    let m;
    if (method === 'GET' && path === '/api/stats') return stats();
    if (method === 'GET' && path === '/api/files') return listFiles(q);
    if (method === 'GET' && path === '/api/retention/overview') return retentionOverview();
    if (method === 'POST' && path === '/api/files/upload') return upload(body);
    if (method === 'POST' && path === '/api/files/batch-ai-rename') {
      const files = [];
      for (const id of body.file_ids || []) {
        const rec = await db.get(id);
        if (rec && rec.ai_suggested_name) files.push(await updateFile(id, { filename: rec.ai_suggested_name }));
      }
      return { renamed_count: files.length, files };
    }
    if (method === 'POST' && path === '/api/files/batch-delete') {
      for (const id of body.file_ids || []) await deleteRecord(id);
      return { deleted_count: (body.file_ids || []).length, ids: body.file_ids || [] };
    }
    if (method === 'POST' && path === '/api/retention/settings') {
      const d = parseInt(body.retention_days, 10);
      if (!(d >= 1 && d <= 365)) throw new HttpError(400, 'Retention days must be between 1 and 365');
      const settings = saveSettings({ ...getSettings(), retention_days: d });
      return { message: `Retention policy updated to ${d} days`, settings };
    }
    if (method === 'POST' && path === '/api/retention/action') return retentionAction(body);

    if ((m = path.match(/^\/api\/files\/([^/]+)$/))) {
      const id = decodeURIComponent(m[1]);
      if (method === 'GET') return enrich(need(await db.get(id)), retentionDays());
      if (method === 'DELETE') { const rec = need(await db.get(id)); await deleteRecord(id); return { message: 'File deleted successfully', file: rec }; }
    }
    if ((m = path.match(/^\/api\/files\/([^/]+)\/(rename|tags\/add|tags\/remove|tags|set-age)$/)) && method === 'POST') {
      const id = decodeURIComponent(m[1]);
      const rec = need(await db.get(id));
      switch (m[2]) {
        case 'rename': {
          let name = body.use_ai_suggested ? rec.ai_suggested_name : body.new_name;
          if (!name) throw new HttpError(400, 'Missing new filename');
          if (rec.extension && !name.toLowerCase().endsWith(rec.extension.toLowerCase())) name += rec.extension;
          return { message: 'File renamed successfully', file: await updateFile(id, { filename: name }) };
        }
        case 'tags/add': {
          const tag = String(body.tag || '').trim().toLowerCase();
          const tags = rec.tags || [];
          if (tag && !tags.map(t => t.toLowerCase()).includes(tag)) { tags.push(tag); await updateFile(id, { tags }); }
          return { tags };
        }
        case 'tags/remove': {
          const tags = (rec.tags || []).filter(t => t.toLowerCase() !== String(body.tag || '').trim().toLowerCase());
          await updateFile(id, { tags });
          return { tags };
        }
        case 'tags': {
          const tags = [...new Set((body.tags || []).map(t => t.trim().toLowerCase()).filter(Boolean))];
          return updateFile(id, { tags });
        }
        case 'set-age': {
          const updated = await updateFile(id, { created_at: new Date(Date.now() - body.days_old * DAY).toISOString(), extended_until: null });
          return { message: `File age simulated to ${body.days_old} days`, retention_info: retentionStatus(updated, retentionDays()) };
        }
      }
    }
    throw new HttpError(404, `No route for ${method} ${path}`);
  }

  // ---------------------------------------------------------------------------
  // fetch() interception
  // ---------------------------------------------------------------------------
  const realFetch = window.fetch.bind(window);
  window.fetch = async function (input, init = {}) {
    const url = new URL(typeof input === 'string' ? input : input.url, location.href);
    if (!url.pathname.startsWith('/api/')) return realFetch(input, init);
    const method = (init.method || 'GET').toUpperCase();
    let body = init.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { /* keep raw */ } }
    try {
      const data = await route(method, url.pathname, url.searchParams, body || {});
      return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
    } catch (err) {
      console.error(err);
      return new Response(JSON.stringify({ detail: err.message }), { status: err.status || 500, headers: { 'Content-Type': 'application/json' } });
    }
  };

  // ---------------------------------------------------------------------------
  // Download / save a copy of a file (uses the Android bridge when present)
  // ---------------------------------------------------------------------------
  async function download(id) {
    const rec = await db.get(id);
    const blob = rec && await db.getBlob(id);
    if (!blob) throw new Error('File content missing');
    if (window.AegisNative && window.AegisNative.saveToDownloads) {
      const b64 = await new Promise((res, rej) => {
        const r = new FileReader();
        r.onload = () => res(String(r.result).split(',')[1] || '');
        r.onerror = () => rej(r.error);
        r.readAsDataURL(blob);
      });
      return window.AegisNative.saveToDownloads(rec.filename, rec.mime_type || 'application/octet-stream', b64);
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = rec.filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    return 'Downloaded';
  }

  // ---------------------------------------------------------------------------
  // Android back-button & Share-to-Aegis integration
  // ---------------------------------------------------------------------------
  window.aegisHandleBack = function () {
    const modals = [
      ['quickTagModal', () => window.closeQuickTagModal && window.closeQuickTagModal()],
      ['renameModal', () => window.closeRenameModal && window.closeRenameModal()],
      ['inspectorModal', () => window.closeInspectorModal && window.closeInspectorModal()],
      ['retentionModal', () => window.closeRetentionModal && window.closeRetentionModal()],
      ['uploadModal', () => window.closeUploadModal && window.closeUploadModal()],
    ];
    for (const [id, closeFn] of modals) {
      const el = document.getElementById(id);
      if (el && !el.classList.contains('hidden')) {
        closeFn();
        return true;
      }
    }
    const sidebar = document.getElementById('sidebar');
    if (sidebar && sidebar.classList.contains('open')) {
      if (window.toggleMobileDrawer) window.toggleMobileDrawer(false);
      return true;
    }
    return false;
  };

  window.aegisImportShared = async function (filename, mimeType, b64) {
    try {
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const file = new File([bytes], filename || 'shared_document', { type: mimeType || 'application/octet-stream' });
      const fd = new FormData();
      fd.append('files', file);
      fd.append('auto_rename', 'false');
      fd.append('initial_tags', '');
      await upload(fd);
      if (window.fetchFiles) window.fetchFiles();
      if (window.showToast) window.showToast(`Imported "${filename}" into Aegis Vault!`, 'success');
    } catch (e) {
      if (window.showToast) window.showToast('Import failed: ' + (e.message || e), 'error');
    }
  };

  window.AegisLocal = { download, analyzeDocumentContext, extractDocumentText, retentionStatus };

  const hideApkCard = () => {
    const card = document.getElementById('downloadApkCard');
    if (card) card.remove();
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', hideApkCard);
  } else {
    hideApkCard();
  }
})();
