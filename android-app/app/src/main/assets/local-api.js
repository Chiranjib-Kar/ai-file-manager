/**
 * Aegis AI File Manager — Android On-Device Zero-Knowledge IndexedDB Adapter
 *
 * Implements the `/api/e2ee/...` storage contract in IndexedDB (`aegis-vault-e2ee`)
 * BEFORE `e2ee.js` wraps `window.fetch`. As a result, all files and metadata stored
 * on the Android phone in IndexedDB are ALSO AES-256-GCM encrypted at rest!
 */
(function () {
  'use strict';

  const DB_NAME = 'aegis-vault-e2ee';
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
    putBlob: (id, u8) => tx('blobs', 'readwrite', s => { s.put(u8, id); }),
    getBlob: (id) => tx('blobs', 'readonly', s => reqP(s.get(id))),
    delBlob: (id) => tx('blobs', 'readwrite', s => { s.delete(id); })
  };

  const uuid = () => (crypto.randomUUID ? crypto.randomUUID()
    : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
      }));

  function getRetentionDays(vaultId) {
    try {
      const map = JSON.parse(localStorage.getItem('aegis_vault_retention') || '{}');
      return parseInt(map[vaultId] || 30, 10);
    } catch (e) {
      return 30;
    }
  }

  function setRetentionDays(vaultId, days) {
    let map = {};
    try { map = JSON.parse(localStorage.getItem('aegis_vault_retention') || '{}'); } catch (e) {}
    map[vaultId] = days;
    localStorage.setItem('aegis_vault_retention', JSON.stringify(map));
    return days;
  }

  const toHex = (u8) => Array.from(u8, b => b.toString(16).padStart(2, '0')).join('');

  const nativeFetch = window.fetch.bind(window);

  window.fetch = async function (input, init = {}) {
    const url = new URL(typeof input === 'string' ? input : input.url, location.href);
    const path = url.pathname;
    if (!path.startsWith('/api/e2ee/')) {
      return nativeFetch(input, init);
    }

    const method = (init.method || 'GET').toUpperCase();
    const headers = new Headers(init.headers || {});
    const vaultId = (headers.get('X-Vault-Id') || '').trim().toLowerCase();
    if (!vaultId) {
      return new Response(JSON.stringify({ detail: 'Missing X-Vault-Id' }), { status: 401 });
    }

    try {
      if (method === 'GET' && path === '/api/e2ee/files') {
        const all = (await db.all()).filter(f => f.vault_id === vaultId);
        return new Response(JSON.stringify({ retention_days: getRetentionDays(vaultId), files: all }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      if (method === 'POST' && path === '/api/e2ee/files') {
        const fd = init.body;
        const blobFile = fd.get('encrypted_blob');
        const cipherU8 = new Uint8Array(await blobFile.arrayBuffer());
        const id = uuid();
        const now = new Date().toISOString();
        const rec = {
          id,
          vault_id: vaultId,
          e2ee: true,
          cipher: 'AES-256-GCM',
          kdf: 'PBKDF2-SHA256-210000',
          encrypted_meta: String(fd.get('encrypted_meta') || ''),
          size_bytes: parseInt(fd.get('size_bytes') || '0', 10),
          cipher_size_bytes: cipherU8.byteLength,
          is_protected: String(fd.get('is_protected')) === 'true',
          created_at: now,
          updated_at: now,
          extended_until: null
        };
        await db.putBlob(id, cipherU8);
        await db.put(rec);
        return new Response(JSON.stringify(rec), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      if (method === 'POST' && path === '/api/e2ee/retention/settings') {
        const body = JSON.parse(init.body || '{}');
        const days = setRetentionDays(vaultId, parseInt(body.retention_days || 30, 10));
        return new Response(JSON.stringify({ message: `Updated to ${days} days`, settings: { retention_days: days } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      if (method === 'POST' && path === '/api/e2ee/retention/action') {
        const body = JSON.parse(init.body || '{}');
        const results = { success: [], skipped_protected: [], errors: [] };
        for (const item of body.items || []) {
          const rec = await db.get(item.id);
          if (!rec || rec.vault_id !== vaultId) { results.errors.push({ id: item.id, error: 'Not found' }); continue; }
          if (body.action === 'delete') {
            if (rec.is_protected) {
              results.skipped_protected.push({ id: item.id, reason: "Protected by 'important' tag" });
              continue;
            }
            await db.delBlob(item.id);
            await db.del(item.id);
            results.success.push({ id: item.id, action: 'deleted' });
          } else if (body.action === 'extend') {
            const d = body.custom_extension_days || 30;
            rec.extended_until = new Date(Date.now() + d * 86400000).toISOString();
            rec.updated_at = new Date().toISOString();
            await db.put(rec);
            results.success.push({ id: item.id, action: `extended_${d}_days` });
          } else if (body.action === 'protect') {
            rec.is_protected = true;
            if (item.encrypted_meta) rec.encrypted_meta = item.encrypted_meta;
            rec.updated_at = new Date().toISOString();
            await db.put(rec);
            results.success.push({ id: item.id, action: 'marked_important' });
          }
        }
        return new Response(JSON.stringify(results), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      let m;
      if ((m = path.match(/^\/api\/e2ee\/files\/([^/]+)\/blob$/)) && method === 'GET') {
        const id = decodeURIComponent(m[1]);
        const rec = await db.get(id);
        if (!rec || rec.vault_id !== vaultId) return new Response(JSON.stringify({ detail: 'Not found' }), { status: 404 });
        const u8 = await db.getBlob(id);
        if (!u8) return new Response(JSON.stringify({ detail: 'Blob missing' }), { status: 404 });
        return new Response(u8, { status: 200, headers: { 'Content-Type': 'application/octet-stream' } });
      }

      if ((m = path.match(/^\/api\/e2ee\/files\/([^/]+)\/proof$/)) && method === 'GET') {
        const id = decodeURIComponent(m[1]);
        const rec = await db.get(id);
        const u8 = rec && await db.getBlob(id);
        if (!rec || rec.vault_id !== vaultId || !u8) return new Response(JSON.stringify({ detail: 'Not found' }), { status: 404 });
        return new Response(JSON.stringify({
          file_id: id,
          disk_filename: `IndexedDB::blobs/${id}.enc`,
          e2ee: true,
          cipher: 'AES-256-GCM',
          kdf: 'PBKDF2-SHA256-210000',
          magic_header_hex: toHex(u8.subarray(0, 5)),
          blob_iv_hex: toHex(u8.subarray(5, 17)),
          ciphertext_sample_hex: toHex(u8.subarray(17, Math.min(49, u8.length))),
          cipher_size_bytes: u8.byteLength,
          encrypted_meta_preview: (rec.encrypted_meta || '').slice(0, 96) + '...',
          server_visible_fields: Object.keys(rec),
          plaintext_stored_on_server: false
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      if ((m = path.match(/^\/api\/e2ee\/files\/([^/]+)$/))) {
        const id = decodeURIComponent(m[1]);
        const rec = await db.get(id);
        if (!rec || rec.vault_id !== vaultId) return new Response(JSON.stringify({ detail: 'Not found' }), { status: 404 });
        if (method === 'PUT') {
          const body = JSON.parse(init.body || '{}');
          if (body.encrypted_meta !== undefined) rec.encrypted_meta = body.encrypted_meta;
          if (body.is_protected !== undefined) rec.is_protected = Boolean(body.is_protected);
          if (body.clear_extended_until) rec.extended_until = null;
          else if (body.extended_until !== undefined) rec.extended_until = body.extended_until;
          if (body.created_at !== undefined) rec.created_at = body.created_at;
          rec.updated_at = new Date().toISOString();
          await db.put(rec);
          return new Response(JSON.stringify(rec), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        if (method === 'DELETE') {
          await db.delBlob(id);
          await db.del(id);
          return new Response(JSON.stringify({ message: 'Deleted', id }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
      }

      return new Response(JSON.stringify({ detail: 'Route not found' }), { status: 404 });
    } catch (err) {
      return new Response(JSON.stringify({ detail: err.message || String(err) }), { status: 500 });
    }
  };

  window.aegisHandleBack = function () {
    const modals = [
      ['shareModal', () => window.closeShareModal && window.closeShareModal()],
      ['sharedReceiveModal', () => window.closeSharedReceiveModal && window.closeSharedReceiveModal()],
      ['vaultInfoModal', () => window.closeVaultInfoModal && window.closeVaultInfoModal()],
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
      if (window.AegisE2EE && !window.AegisE2EE.isUnlocked()) {
        window.AegisE2EE.queueAndroidImport(filename, mimeType, b64);
        if (window.showToast) window.showToast('Unlock your encrypted vault to finish importing shared file.', 'info');
        return;
      }
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const file = new File([bytes], filename || 'shared_document', { type: mimeType || 'application/octet-stream' });
      const fd = new FormData();
      fd.append('files', file);
      fd.append('auto_rename', 'false');
      fd.append('initial_tags', '');
      await window.fetch('/api/files/upload', { method: 'POST', body: fd });
      if (window.fetchFiles) window.fetchFiles();
      if (window.showToast) window.showToast(`Encrypted & imported "${filename}" into Aegis Vault!`, 'success');
    } catch (e) {
      if (window.showToast) window.showToast('Import failed: ' + (e.message || e), 'error');
    }
  };

  const hideWebOnlyElements = () => {
    const card = document.getElementById('downloadApkCard');
    if (card) card.remove();
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', hideWebOnlyElements);
  } else {
    hideWebOnlyElements();
  }
})();
