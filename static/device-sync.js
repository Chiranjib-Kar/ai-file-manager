/**
 * Aegis AI File Manager — Automatic Device & Live Downloads Sync Engine
 *
 * Automatically accesses existing files on the user's device AND newly downloaded
 * files without requiring manual file-by-file selection, while keeping 100%
 * client-side AI analysis + Zero-Knowledge AES-256-GCM End-to-End Encryption:
 *
 * 1. Direct Localhost Mode (`localhost` / `127.0.0.1`):
 *    Automatically discovers existing files & live-watches `Downloads`, `Documents`,
 *    and `Desktop` with zero dialogs via the loopback-guarded local bridge.
 * 2. Public Cloud Website Mode (`https://...onrender.com`, `trycloudflare.com`, etc.):
 *    Uses the W3C File System Access API (`window.showDirectoryPicker` + IndexedDB
 *    persistent handles + `FileSystemObserver` / 4s live folder watcher) so a 1-time
 *    folder grant (`Downloads`, `Documents`, etc.) automatically imports all existing
 *    files AND continuously ingests every newly downloaded file in real time!
 */
(function () {
  'use strict';

  const HANDLE_DB = 'aegis-device-handles-v1';
  const POLL_INTERVAL_MS = 4000;
  const MAX_SYNC_BYTES = 15 * 1024 * 1024; // 15 MB per auto-synced file
  const SKIP_DIRS = new Set([
    'node_modules', '__pycache__', '.git', '.svn', '.hg', 'venv', '.venv',
    'AppData', 'Application Data', '$RECYCLE.BIN', 'System Volume Information'
  ]);
  const SKIP_EXTS = new Set([
    '.exe', '.msi', '.dll', '.sys', '.lnk', '.ini', '.db', '.tmp', '.temp',
    '.crdownload', '.part', '.opdownload', '.download', '.onetoc2', '.iso',
    '.dmg', '.vmdk', '.cab', '.log'
  ]);

  let pollTimer = null;
  let isScanning = false;
  let isProcessingQueue = false;
  let localBridgeAvailable = null; // null = unknown, true/false
  let localBridgeFolders = [];
  let activeHandles = []; // [{ id, name, handle, permission: 'granted' | 'prompt' }]
  const observers = new Map();
  const importQueue = []; // [{ sourceKey, folderLabel, name, getFile: async () => File, isLiveDownload }]
  const queuedKeys = new Set();

  let syncStats = {
    totalQueued: 0,
    completedInBatch: 0,
    currentFile: '',
    totalAutoSyncedEver: 0
  };

  function isPaused() {
    return localStorage.getItem('aegis_autosync_paused') === 'true';
  }

  function isAutoRenameEnabled() {
    return localStorage.getItem('aegis_autosync_autorename') === 'true';
  }

  function seenStorageKey() {
    const vid = (window.AegisE2EE && window.AegisE2EE.getVaultId && window.AegisE2EE.getVaultId()) || 'default';
    return `aegis_autosync_seen_${vid}`;
  }

  function loadSeenKeys() {
    try {
      const arr = JSON.parse(localStorage.getItem(seenStorageKey()) || '[]');
      return new Set(Array.isArray(arr) ? arr : []);
    } catch (e) {
      return new Set();
    }
  }

  function saveSeenKeys(setObj) {
    try {
      const arr = Array.from(setObj);
      // Keep most recent 5000 keys bounded
      const trimmed = arr.length > 5000 ? arr.slice(arr.length - 5000) : arr;
      localStorage.setItem(seenStorageKey(), JSON.stringify(trimmed));
    } catch (e) {}
  }

  function markKeySeen(key) {
    const s = loadSeenKeys();
    s.add(key);
    saveSeenKeys(s);
  }

  // ===========================================================================
  // IndexedDB Persistence for Browser `FileSystemDirectoryHandle`s
  // ===========================================================================
  function openHandleDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(HANDLE_DB, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('handles')) {
          db.createObjectStore('handles', { keyPath: 'id' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function loadSavedHandles() {
    if (!window.showDirectoryPicker) return [];
    try {
      const db = await openHandleDb();
      const records = await new Promise((res, rej) => {
        const tx = db.transaction('handles', 'readonly');
        const r = tx.objectStore('handles').getAll();
        r.onsuccess = () => res(r.result || []);
        r.onerror = () => rej(r.error);
      });
      const out = [];
      for (const rec of records) {
        if (!rec || !rec.handle) continue;
        let perm = 'prompt';
        try {
          perm = await rec.handle.queryPermission({ mode: 'read' });
        } catch (e) {}
        out.push({ id: rec.id, name: rec.name || rec.handle.name, handle: rec.handle, permission: perm });
        if (perm === 'granted') attachObserverIfSupported(rec.id, rec.handle);
      }
      activeHandles = out;
      return out;
    } catch (e) {
      return [];
    }
  }

  async function saveDirectoryHandle(handle) {
    const db = await openHandleDb();
    // Avoid duplicate handle if same directory already linked
    for (const existing of activeHandles) {
      try {
        if (await existing.handle.isSameEntry(handle)) {
          existing.permission = 'granted';
          attachObserverIfSupported(existing.id, existing.handle);
          return existing;
        }
      } catch (e) {}
    }
    const rec = { id: `${handle.name}-${Date.now()}`, name: handle.name, handle };
    await new Promise((res, rej) => {
      const tx = db.transaction('handles', 'readwrite');
      tx.objectStore('handles').put(rec);
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
    const item = { ...rec, permission: 'granted' };
    activeHandles.push(item);
    attachObserverIfSupported(item.id, item.handle);
    return item;
  }

  async function removeDirectoryHandle(id) {
    const obs = observers.get(id);
    if (obs && obs.disconnect) { try { obs.disconnect(); } catch (e) {} }
    observers.delete(id);
    activeHandles = activeHandles.filter(h => h.id !== id);
    try {
      const db = await openHandleDb();
      await new Promise((res) => {
        const tx = db.transaction('handles', 'readwrite');
        tx.objectStore('handles').delete(id);
        tx.oncomplete = () => res();
        tx.onerror = () => res();
      });
    } catch (e) {}
    renderAutoSyncUI();
  }

  function attachObserverIfSupported(id, dirHandle) {
    if (observers.has(id) || typeof window.FileSystemObserver !== 'function') return;
    try {
      const obs = new window.FileSystemObserver(() => {
        // Trigger fast scan shortly after OS file write settles
        setTimeout(() => runSyncCycle(true), 1600);
      });
      obs.observe(dirHandle, { recursive: true }).catch(() => {});
      observers.set(id, obs);
    } catch (e) {}
  }

  // ===========================================================================
  // Filtering & Recursive Browser Directory Scanner
  // ===========================================================================
  function extLower(name) {
    const i = name.lastIndexOf('.');
    return i > 0 ? name.slice(i).toLowerCase() : '';
  }

  function shouldIncludeFile(name, size, lastModifiedMs) {
    if (!name || name.startsWith('.') || name.startsWith('~$')) return false;
    const ext = extLower(name);
    if (!ext || SKIP_EXTS.has(ext)) return false;
    if (!size || size <= 0 || size > MAX_SYNC_BYTES) return false;
    // Wait 1.5s after last write so in-progress browser downloads settle cleanly
    if (lastModifiedMs && (Date.now() - lastModifiedMs) < 1500) return false;
    return true;
  }

  async function walkDirectoryHandle(dirHandle, rootLabel, relPrefix, depth, outList) {
    if (depth > 4) return;
    for await (const [entryName, entry] of dirHandle.entries()) {
      if (entryName.startsWith('.') || entryName.startsWith('$')) continue;
      if (entry.kind === 'directory') {
        if (SKIP_DIRS.has(entryName)) continue;
        await walkDirectoryHandle(entry, rootLabel, relPrefix ? `${relPrefix}/${entryName}` : entryName, depth + 1, outList);
      } else if (entry.kind === 'file') {
        try {
          const file = await entry.getFile();
          if (!shouldIncludeFile(file.name, file.size, file.lastModified)) continue;
          const relPath = relPrefix ? `${relPrefix}/${file.name}` : file.name;
          const sourceKey = `fsa::${rootLabel}/${relPath}::${file.size}::${Math.floor((file.lastModified || 0) / 1000)}`;
          outList.push({
            sourceKey,
            folderLabel: rootLabel,
            name: file.name,
            mtimeMs: file.lastModified || 0,
            getFile: async () => entry.getFile()
          });
        } catch (e) {}
      }
    }
  }

  // ===========================================================================
  // Localhost Direct Loopback Scanner Probe
  // ===========================================================================
  async function scanLocalLoopbackIfAvailable() {
    if (localBridgeAvailable === false) return [];
    if (window.AegisE2EE && window.AegisE2EE.isAndroid) {
      localBridgeAvailable = false;
      return [];
    }
    try {
      const res = await fetch('/api/local-device/files');
      if (!res.ok) {
        localBridgeAvailable = false;
        return [];
      }
      const data = await res.json();
      localBridgeAvailable = true;
      localBridgeFolders = data.folders || [];
      return (data.files || []).map(item => ({
        sourceKey: item.source_key,
        folderLabel: item.folder,
        name: item.name,
        mtimeMs: item.mtime_ms || 0,
        getFile: async () => {
          const r = await fetch(`/api/local-device/read?token=${encodeURIComponent(item.token)}`);
          if (!r.ok) throw new Error('File moved or unavailable');
          const blob = await r.blob();
          return new File([blob], item.name, {
            type: item.mime_type || blob.type || 'application/octet-stream',
            lastModified: item.mtime_ms || Date.now()
          });
        }
      }));
    } catch (e) {
      localBridgeAvailable = false;
      return [];
    }
  }

  // ===========================================================================
  // Core Auto-Sync Cycle & Non-Blocking Encryption Queue
  // ===========================================================================
  let initialScanCompleted = false;

  async function runSyncCycle(fromLiveTick = false) {
    if (isScanning || isPaused()) {
      renderAutoSyncUI();
      return;
    }
    if (!window.AegisE2EE || !window.AegisE2EE.isUnlocked()) {
      renderAutoSyncUI();
      return;
    }

    isScanning = true;
    try {
      const vaultKeys = await window.AegisE2EE.getVaultSourceKeys();
      const seen = loadSeenKeys();
      for (const k of vaultKeys) seen.add(k);

      const candidates = [];

      // 1. Scan direct localhost folders if running on local PC
      const localItems = await scanLocalLoopbackIfAvailable();
      candidates.push(...localItems);

      // 2. Scan all granted browser DirectoryHandles (`Downloads`, `Documents`, etc.)
      for (const h of activeHandles) {
        if (h.permission !== 'granted') continue;
        try {
          const list = [];
          await walkDirectoryHandle(h.handle, h.name, '', 0, list);
          candidates.push(...list);
        } catch (e) {}
      }

      // Sort newest first so fresh downloads sync immediately!
      candidates.sort((a, b) => (b.mtimeMs || 0) - (a.mtimeMs || 0));

      let newlyAddedCount = 0;
      for (const item of candidates) {
        if (seen.has(item.sourceKey) || queuedKeys.has(item.sourceKey)) continue;
        queuedKeys.add(item.sourceKey);
        importQueue.push({ ...item, isLiveDownload: initialScanCompleted && fromLiveTick });
        newlyAddedCount++;
      }

      if (newlyAddedCount > 0) {
        syncStats.totalQueued += newlyAddedCount;
        processQueue();
      }
      initialScanCompleted = true;
    } finally {
      isScanning = false;
      renderAutoSyncUI();
    }
  }

  async function processQueue() {
    if (isProcessingQueue) return;
    isProcessingQueue = true;
    renderAutoSyncUI();

    let importedSinceRefresh = 0;
    try {
      while (importQueue.length > 0) {
        if (isPaused() || !window.AegisE2EE || !window.AegisE2EE.isUnlocked()) break;
        const job = importQueue.shift();
        syncStats.currentFile = job.name;
        renderAutoSyncUI();

        try {
          const fileObj = await job.getFile();
          const saved = await window.AegisE2EE.encryptAndUploadSingleFile(fileObj, {
            autoRename: isAutoRenameEnabled(),
            sourceKey: job.sourceKey,
            folderLabel: job.folderLabel,
            initialTags: job.folderLabel && job.folderLabel.toLowerCase().includes('download') ? ['downloaded'] : []
          });
          markKeySeen(job.sourceKey);
          syncStats.completedInBatch++;
          syncStats.totalAutoSyncedEver++;
          importedSinceRefresh++;

          if (job.isLiveDownload && window.showToast) {
            window.showToast(`⚡ Auto-Synced new download: "${saved.filename}" → ${saved.context_category}`, 'success');
          }

          // Refresh grid immediately for live single downloads, or every 4 files during bulk initial import
          if (job.isLiveDownload || importedSinceRefresh >= 4 || importQueue.length === 0) {
            importedSinceRefresh = 0;
            if (window.fetchFiles) window.fetchFiles();
          }
        } catch (err) {
          // Mark unparseable/locked file as seen if missing so queue never loops infinitely
          markKeySeen(job.sourceKey);
        } finally {
          queuedKeys.delete(job.sourceKey);
        }

        // Yield to UI event loop so scrolling, searching & clicking stay 60fps smooth
        await new Promise(r => setTimeout(r, 45));
      }
    } finally {
      isProcessingQueue = false;
      if (importQueue.length === 0) {
        syncStats.totalQueued = 0;
        syncStats.completedInBatch = 0;
        syncStats.currentFile = '';
      }
      renderAutoSyncUI();
      if (importedSinceRefresh > 0 && window.fetchFiles) window.fetchFiles();
    }
  }

  // ===========================================================================
  // User Actions: Connect Folder, Resume Permission, Fallback Input, Pause/Rescan
  // ===========================================================================
  async function connectDeviceFolder() {
    if (!window.AegisE2EE || !window.AegisE2EE.isUnlocked()) {
      if (window.showToast) window.showToast('Unlock your E2EE Vault first.', 'warning');
      return;
    }
    if (typeof window.showDirectoryPicker === 'function') {
      try {
        const handle = await window.showDirectoryPicker({ mode: 'read' });
        await saveDirectoryHandle(handle);
        if (window.showToast) {
          window.showToast(`Connected "${handle.name}"! Auto-importing existing files & watching new downloads live.`, 'success');
        }
        initialScanCompleted = false;
        await runSyncCycle(false);
      } catch (err) {
        if (err && err.name !== 'AbortError' && window.showToast) {
          window.showToast('Folder access notice: ' + (err.message || err), 'warning');
        }
      }
      renderAutoSyncUI();
      return;
    }
    // Fallback for browsers without showDirectoryPicker (Firefox / Safari)
    const fallback = document.getElementById('fallbackDirectoryInput');
    if (fallback) fallback.click();
  }

  async function handleFallbackDirectoryInput(event) {
    const fileList = Array.from((event && event.target && event.target.files) || []);
    if (!fileList.length) return;
    const seen = loadSeenKeys();
    let count = 0;
    for (const f of fileList) {
      if (!shouldIncludeFile(f.name, f.size, f.lastModified)) continue;
      const rel = f.webkitRelativePath || f.name;
      const folderLabel = rel.split('/')[0] || 'Device';
      const sourceKey = `webkitdir::${rel}::${f.size}::${Math.floor((f.lastModified || 0) / 1000)}`;
      if (seen.has(sourceKey) || queuedKeys.has(sourceKey)) continue;
      queuedKeys.add(sourceKey);
      importQueue.push({ sourceKey, folderLabel, name: f.name, mtimeMs: f.lastModified || 0, getFile: async () => f, isLiveDownload: false });
      count++;
    }
    event.target.value = '';
    if (count > 0) {
      syncStats.totalQueued += count;
      if (window.showToast) window.showToast(`Auto-importing ${count} existing device files...`, 'info');
      processQueue();
    } else if (window.showToast) {
      window.showToast('All eligible files in that folder are already synced!', 'info');
    }
  }

  async function resumeSavedFolders() {
    let grantedAny = false;
    for (const h of activeHandles) {
      if (h.permission !== 'granted') {
        try {
          const p = await h.handle.requestPermission({ mode: 'read' });
          h.permission = p;
          if (p === 'granted') {
            attachObserverIfSupported(h.id, h.handle);
            grantedAny = true;
          }
        } catch (e) {}
      }
    }
    renderAutoSyncUI();
    if (grantedAny) {
      if (window.showToast) window.showToast('Live Auto-Sync resumed for connected folders!', 'success');
      runSyncCycle(false);
    }
  }

  function toggleAutoSyncPause() {
    const nextPaused = !isPaused();
    localStorage.setItem('aegis_autosync_paused', String(nextPaused));
    renderAutoSyncUI();
    if (!nextPaused) {
      if (window.showToast) window.showToast('Auto-Sync resumed — scanning device & Downloads.', 'success');
      runSyncCycle(false);
      processQueue();
    } else if (window.showToast) {
      window.showToast('Auto-Sync paused.', 'info');
    }
  }

  function toggleAutoSyncRename(checked) {
    localStorage.setItem('aegis_autosync_autorename', String(Boolean(checked)));
    if (window.showToast) {
      window.showToast(checked ? 'Auto-synced files will use AI names automatically.' : 'Auto-synced files will keep original filenames (with AI suggestions).', 'info');
    }
  }

  async function rescanAllDeviceFiles() {
    localStorage.removeItem(seenStorageKey());
    initialScanCompleted = false;
    if (window.showToast) window.showToast('Rescanning device folders for unsynced files...', 'info');
    await runSyncCycle(false);
  }

  // ===========================================================================
  // UI Rendering for the Live Auto-Sync Banner & Sidebar Card
  // ===========================================================================
  function renderAutoSyncUI() {
    const banner = document.getElementById('autoSyncBanner');
    if (!banner) return;

    if (window.AegisE2EE && window.AegisE2EE.isAndroid) {
      banner.classList.add('hidden');
      return;
    }
    banner.classList.remove('hidden');

    const paused = isPaused();
    const grantedHandles = activeHandles.filter(h => h.permission === 'granted');
    const promptHandles = activeHandles.filter(h => h.permission !== 'granted');
    const hasActiveWatch = Boolean(localBridgeAvailable) || grantedHandles.length > 0;

    const statusBadge = document.getElementById('autoSyncStatusBadge');
    const statusText = document.getElementById('autoSyncStatusText');
    const subText = document.getElementById('autoSyncSubText');
    const pauseBtn = document.getElementById('autoSyncPauseBtn');
    const resumeBtn = document.getElementById('autoSyncResumeBtn');
    const renameToggle = document.getElementById('autoSyncRenameCheckbox');
    const chipsBox = document.getElementById('autoSyncFoldersChips');
    const progressWrap = document.getElementById('autoSyncProgressWrap');
    const progressFill = document.getElementById('autoSyncProgressFill');

    if (renameToggle) renameToggle.checked = isAutoRenameEnabled();
    if (resumeBtn) resumeBtn.classList.toggle('hidden', promptHandles.length === 0);

    // Folder chips
    const chips = [];
    if (localBridgeAvailable) {
      for (const f of localBridgeFolders) {
        chips.push(`<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-lg bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 text-[10px] font-mono">💻 ${f} (Live)</span>`);
      }
    }
    for (const h of grantedHandles) {
      chips.push(`
        <span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-lg bg-indigo-500/15 text-indigo-300 border border-indigo-500/30 text-[10px] font-mono">
          <span>📁 ${h.name} (Live)</span>
          <button onclick="removeAutoSyncFolder('${h.id}')" class="hover:text-rose-300 ml-0.5" title="Disconnect folder">×</button>
        </span>
      `);
    }
    for (const h of promptHandles) {
      chips.push(`<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-lg bg-amber-500/15 text-amber-300 border border-amber-500/30 text-[10px] font-mono">⏸️ ${h.name} (Click Resume)</span>`);
    }
    if (chipsBox) chipsBox.innerHTML = chips.join('');

    if (pauseBtn) {
      pauseBtn.classList.toggle('hidden', !hasActiveWatch);
      pauseBtn.textContent = paused ? 'Resume Sync' : 'Pause';
    }

    if (isProcessingQueue && !paused) {
      const total = Math.max(1, syncStats.totalQueued);
      const pct = Math.min(98, Math.round((syncStats.completedInBatch / total) * 100));
      if (statusBadge) {
        statusBadge.className = 'px-2 py-0.5 rounded-full text-[10px] font-bold bg-indigo-500/20 text-indigo-300 border border-indigo-500/30 animate-pulse';
        statusBadge.textContent = `SYNCING ${syncStats.completedInBatch + 1}/${total}`;
      }
      if (statusText) statusText.textContent = `Encrypting & importing "${syncStats.currentFile}"...`;
      if (subText) subText.textContent = 'Reading content with AI & encrypting locally (AES-256-GCM) — no manual file selection needed.';
      if (progressWrap) progressWrap.classList.remove('hidden');
      if (progressFill) progressFill.style.width = `${pct}%`;
    } else if (paused && hasActiveWatch) {
      if (statusBadge) {
        statusBadge.className = 'px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-500/20 text-amber-300 border border-amber-500/30';
        statusBadge.textContent = 'PAUSED';
      }
      if (statusText) statusText.textContent = 'Automatic Device & Downloads Sync is paused';
      if (subText) subText.textContent = 'Click Resume Sync to continue watching existing & newly downloaded files.';
      if (progressWrap) progressWrap.classList.add('hidden');
    } else if (hasActiveWatch) {
      if (statusBadge) {
        statusBadge.className = 'px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-500/20 text-emerald-300 border border-emerald-500/30';
        statusBadge.textContent = 'LIVE AUTO-SYNC';
      }
      if (statusText) statusText.textContent = 'Automatically accessing existing files & live Downloads';
      if (subText) subText.textContent = 'Any existing file or new file you download is automatically AI-sorted & E2EE encrypted without selecting files.';
      if (progressWrap) progressWrap.classList.add('hidden');
    } else {
      if (statusBadge) {
        statusBadge.className = 'px-2 py-0.5 rounded-full text-[10px] font-bold bg-cyan-500/20 text-cyan-300 border border-cyan-500/30';
        statusBadge.textContent = 'AUTO-ACCESS READY';
      }
      if (statusText) statusText.textContent = 'Enable Automatic Device & Downloads Sync (Zero File Picking)';
      if (subText) {
        subText.textContent = promptHandles.length > 0
          ? 'Click "Resume Saved Folders" to restore automatic access to your existing files & live downloads.'
          : 'Grant access once to your Downloads / Documents / User folder — Aegis automatically imports all existing files and watches every new download live!';
      }
      if (progressWrap) progressWrap.classList.add('hidden');
    }

    if (window.renderIcons) window.renderIcons();
  }

  async function start() {
    if (window.AegisE2EE && window.AegisE2EE.isAndroid) return;
    await loadSavedHandles();
    renderAutoSyncUI();
    if (pollTimer) clearInterval(pollTimer);
    if (window.AegisE2EE && window.AegisE2EE.isUnlocked()) {
      await runSyncCycle(false);
    }
    pollTimer = setInterval(() => {
      if (window.AegisE2EE && window.AegisE2EE.isUnlocked() && !isPaused()) {
        runSyncCycle(true);
      }
    }, POLL_INTERVAL_MS);
  }

  window.AegisDeviceSync = {
    start,
    runSyncCycle,
    connectDeviceFolder,
    handleFallbackDirectoryInput,
    resumeSavedFolders,
    removeFolder: removeDirectoryHandle,
    togglePause: toggleAutoSyncPause,
    toggleAutoRename: toggleAutoSyncRename,
    rescanAll: rescanAllDeviceFiles,
    renderUI: renderAutoSyncUI
  };
})();
