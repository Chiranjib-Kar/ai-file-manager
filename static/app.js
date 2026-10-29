/**
 * Aegis AI File Manager - Core Frontend Logic
 */

let state = {
  files: [],
  stats: null,
  activeContext: 'All',
  activeFileType: 'All',
  activeTag: 'All',
  activeRetentionFilter: 'All',
  searchQuery: '',
  groupingMode: 'context', // 'context' | 'type' | 'none'
  sortBy: 'date-desc',
  currentInspectedFile: null,
  selectedExpiredIds: new Set(),
  activeRenameFileId: null,
  activeTagTargetFileId: null
};

// Lucide icon helper
function renderIcons() {
  if (window.lucide) {
    window.lucide.createIcons();
  }
}

// Toast notification helper
function showToast(message, type = 'info') {
  const container = document.getElementById('toastContainer');
  if (!container) return;

  const toast = document.createElement('div');
  const bgColors = {
    info: 'bg-indigo-900/90 border-indigo-500/40 text-indigo-100',
    success: 'bg-emerald-900/90 border-emerald-500/40 text-emerald-100',
    warning: 'bg-amber-900/90 border-amber-500/40 text-amber-100',
    error: 'bg-rose-900/90 border-rose-500/40 text-rose-100'
  };

  toast.className = `px-4 py-3 rounded-2xl border shadow-2xl text-xs font-semibold flex items-center gap-2 transform transition-all duration-300 pointer-events-auto backdrop-blur-md ${bgColors[type] || bgColors.info}`;
  toast.innerHTML = `<span>${message}</span>`;
  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(10px)';
    setTimeout(() => toast.remove(), 300);
  }, 3500);
}

// Lifecycle Init
document.addEventListener('DOMContentLoaded', () => {
  initTheme();
  fetchFiles();
  fetchStats();
  checkRetentionOverview();
  setupKeyboardShortcuts();
  setupHeroDropZone();
});

// Color Template Theme System
function initTheme() {
  const savedTheme = localStorage.getItem('aegis_theme') || 'emerald';
  applyTheme(savedTheme, false);
}

function changeTheme(themeName) {
  applyTheme(themeName, true);
}

function applyTheme(themeName, notify = true) {
  document.documentElement.setAttribute('data-theme', themeName);
  localStorage.setItem('aegis_theme', themeName);

  const select = document.getElementById('themeSelect');
  if (select) select.value = themeName;

  const names = {
    emerald: '🌿 Emerald Mint',
    amethyst: '👑 Royal Amethyst',
    cyber: '🌌 Cyber Titanium',
    light: '💎 Nordic Light'
  };

  if (notify) {
    showToast(`Color template changed to ${names[themeName] || themeName}`, 'success');
  }
}

function setupKeyboardShortcuts() {
  window.addEventListener('keydown', (e) => {
    // Ctrl + K shortcut to focus search
    if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
      e.preventDefault();
      const searchInput = document.getElementById('searchInput');
      if (searchInput) {
        searchInput.focus();
        searchInput.select();
      }
    }
    // Escape to close modals
    if (e.key === 'Escape') {
      closeUploadModal();
      closeRetentionModal();
      closeInspectorModal();
      closeRenameModal();
      closeQuickTagModal();
      hideSearchDropdown();
    }
  });

  // Close search dropdown on click outside
  document.addEventListener('click', (e) => {
    const dropdown = document.getElementById('searchDropdown');
    const searchInput = document.getElementById('searchInput');
    if (dropdown && !dropdown.contains(e.target) && e.target !== searchInput) {
      hideSearchDropdown();
    }
  });
}

// Setup direct drag-and-drop on hero area
function setupHeroDropZone() {
  const emptyState = document.getElementById('emptyState');
  if (!emptyState) return;

  ['dragenter', 'dragover'].forEach(name => {
    emptyState.addEventListener(name, (e) => {
      e.preventDefault();
      emptyState.classList.add('dragover');
    });
  });

  ['dragleave', 'drop'].forEach(name => {
    emptyState.addEventListener(name, (e) => {
      e.preventDefault();
      emptyState.classList.remove('dragover');
    });
  });

  emptyState.addEventListener('drop', (e) => {
    e.preventDefault();
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      openUploadModal();
      handleFiles(Array.from(e.dataTransfer.files));
    }
  });
}

// API Calls
async function fetchFiles() {
  toggleLoading(true);
  try {
    const params = new URLSearchParams();
    if (state.searchQuery) params.append('query', state.searchQuery);
    if (state.activeContext !== 'All') params.append('context', state.activeContext);
    if (state.activeFileType !== 'All') params.append('type', state.activeFileType);
    if (state.activeTag !== 'All') params.append('tag', state.activeTag);
    if (state.activeRetentionFilter !== 'All') params.append('retention', state.activeRetentionFilter);

    const [field, order] = state.sortBy.split('-');
    params.append('sort_by', field);
    params.append('sort_order', order);

    const res = await fetch(`/api/files?${params.toString()}`);
    if (!res.ok) throw new Error('Failed loading files');
    state.files = await res.json();
    renderWorkspace();
    fetchStats();
    checkRetentionOverview();
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    toggleLoading(false);
  }
}

async function fetchStats() {
  try {
    const res = await fetch('/api/stats');
    if (!res.ok) return;
    state.stats = await res.json();
    updateStatsUI();
  } catch (err) {
    console.error('Stats fetch error:', err);
  }
}

async function checkRetentionOverview() {
  try {
    const res = await fetch('/api/retention/overview');
    if (!res.ok) return;
    const overview = await res.json();
    
    // Update banner
    const banner = document.getElementById('retentionAlertBanner');
    const alertText = document.getElementById('retentionAlertText');
    const expiredCount = overview.counts?.expired || 0;

    if (expiredCount > 0) {
      alertText.textContent = `⚠️ ${expiredCount} file${expiredCount > 1 ? 's are' : ' is'} older than ${overview.retention_days} days and require your permission before deletion.`;
      banner.classList.remove('hidden');
    } else {
      banner.classList.add('hidden');
    }

    // Update retention select element
    const retSelect = document.getElementById('retentionSelect');
    if (retSelect && overview.retention_days) {
      retSelect.value = overview.retention_days.toString();
    }

    // Update sidebar counts
    const countRetExpired = document.getElementById('countRetExpired');
    const countRetProtected = document.getElementById('countRetProtected');
    const countRetExpiringSoon = document.getElementById('countRetExpiringSoon');
    if (countRetExpired) countRetExpired.textContent = overview.counts?.expired || 0;
    if (countRetProtected) countRetProtected.textContent = overview.counts?.protected || 0;
    if (countRetExpiringSoon) countRetExpiringSoon.textContent = overview.counts?.expiring_soon || 0;
  } catch (err) {
    console.error('Retention check error:', err);
  }
}

function updateStatsUI() {
  if (!state.stats) return;
  const statTotalFiles = document.getElementById('statTotalFiles');
  const statTotalSize = document.getElementById('statTotalSize');
  const statProtectedCount = document.getElementById('statProtectedCount');
  const statExpiredCount = document.getElementById('statExpiredCount');

  if (statTotalFiles) statTotalFiles.textContent = `${state.stats.total_files} files`;
  if (statTotalSize) statTotalSize.textContent = formatBytes(state.stats.total_size_bytes);
  if (statProtectedCount) statProtectedCount.textContent = state.stats.protected_files_count;
  if (statExpiredCount) statExpiredCount.textContent = state.stats.expired_files_count;

  renderSidebarNavs();
}

function renderSidebarNavs() {
  if (!state.stats) return;

  // 1. Context Nav
  const contextNav = document.getElementById('contextNav');
  if (contextNav) {
    const contexts = [
      { name: 'All', icon: 'layers', color: 'text-indigo-400' },
      { name: 'Study & Education', icon: 'book-open', color: 'text-emerald-400' },
      { name: 'Finance & Invoices', icon: 'credit-card', color: 'text-violet-400' },
      { name: 'Work & Projects', icon: 'briefcase', color: 'text-blue-400' },
      { name: 'Legal & Identity', icon: 'scale', color: 'text-amber-400' },
      { name: 'Code & Technical', icon: 'code', color: 'text-cyan-400' },
      { name: 'Personal & Notes', icon: 'file-heart', color: 'text-pink-400' },
    ];

    contextNav.innerHTML = contexts.map(c => {
      const count = c.name === 'All' ? state.stats.total_files : (state.stats.categories[c.name] || 0);
      const isActive = state.activeContext === c.name;
      return `
        <button 
          onclick="setContextFilter('${c.name}')" 
          class="w-full flex items-center justify-between px-2.5 py-1.5 rounded-xl transition-all ${
            isActive ? 'bg-indigo-600 text-white font-semibold shadow-md shadow-indigo-600/30' : 'text-slate-300 hover:bg-slate-800/80 hover:text-white'
          }"
        >
          <span class="flex items-center gap-2 truncate">
            <i data-lucide="${c.icon}" class="w-3.5 h-3.5 ${isActive ? 'text-white' : c.color}"></i>
            <span class="truncate">${c.name}</span>
          </span>
          <span class="text-[11px] ${isActive ? 'text-indigo-100' : 'text-slate-500'} font-mono">${count}</span>
        </button>
      `;
    }).join('');
  }

  // 2. File Type Nav
  const fileTypeNav = document.getElementById('fileTypeNav');
  if (fileTypeNav) {
    const types = [
      { name: 'All', icon: 'layout-grid' },
      { name: 'Document', icon: 'file-text' },
      { name: 'Spreadsheet', icon: 'table' },
      { name: 'Code & Data', icon: 'terminal' },
      { name: 'Image', icon: 'image' },
      { name: 'Archive', icon: 'archive' }
    ];

    fileTypeNav.innerHTML = types.map(t => {
      const isActive = state.activeFileType === t.name;
      return `
        <button 
          onclick="setFileTypeFilter('${t.name}')" 
          class="w-full flex items-center justify-between px-2.5 py-1.5 rounded-xl transition-all ${
            isActive ? 'bg-cyan-600 text-white font-semibold shadow-md shadow-cyan-600/30' : 'text-slate-300 hover:bg-slate-800/80 hover:text-white'
          }"
        >
          <span class="flex items-center gap-2 truncate">
            <i data-lucide="${t.icon}" class="w-3.5 h-3.5 ${isActive ? 'text-white' : 'text-cyan-400'}"></i>
            <span class="truncate">${t.name}</span>
          </span>
        </button>
      `;
    }).join('');
  }

  // 3. Tag Cloud
  const tagCloud = document.getElementById('tagCloud');
  if (tagCloud) {
    const tagsMap = state.stats.tags_count || {};
    const tagEntries = Object.entries(tagsMap);

    if (tagEntries.length === 0) {
      tagCloud.innerHTML = '<span class="text-[11px] text-slate-500">No tags yet.</span>';
    } else {
      tagCloud.innerHTML = tagEntries.map(([t, count]) => {
        const isActive = state.activeTag.toLowerCase() === t.toLowerCase();
        let colorClasses = 'bg-slate-800 text-slate-300 border-slate-700 hover:border-slate-500';
        if (t.toLowerCase() === 'important') colorClasses = 'bg-amber-500/15 text-amber-300 border-amber-500/30 hover:border-amber-400 font-semibold';
        else if (t.toLowerCase() === 'temporary') colorClasses = 'bg-rose-500/15 text-rose-300 border-rose-500/30 hover:border-rose-400';
        else if (t.toLowerCase() === 'study') colorClasses = 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30 hover:border-emerald-400 font-semibold';
        else if (t.toLowerCase() === 'work') colorClasses = 'bg-blue-500/15 text-blue-300 border-blue-500/30 hover:border-blue-400';
        else if (t.toLowerCase() === 'finance') colorClasses = 'bg-violet-500/15 text-violet-300 border-violet-500/30 hover:border-violet-400';

        if (isActive) {
          colorClasses = 'bg-indigo-600 text-white border-indigo-400 font-bold shadow-md shadow-indigo-600/30';
        }

        return `
          <button 
            onclick="setTagFilter('${t}')" 
            class="px-2.5 py-1 rounded-xl border text-[11px] transition-all flex items-center gap-1 ${colorClasses}"
          >
            <span>#${t}</span>
            <span class="text-[9px] opacity-75 font-mono">(${count})</span>
          </button>
        `;
      }).join('');
    }
  }

  renderIcons();
}

// RENDERING WORKSPACE
function renderWorkspace() {
  const container = document.getElementById('filesContainer');
  const emptyState = document.getElementById('emptyState');
  const inlineDropzone = document.getElementById('inlineDropzone');
  const activeFilterBar = document.getElementById('activeFilterBar');
  const filterPills = document.getElementById('filterPills');

  // Update Horizontal Quick Filter Pills
  document.querySelectorAll('.quick-pill').forEach(pill => {
    const c = pill.getAttribute('data-context');
    const t = pill.getAttribute('data-tag');
    let isActive = false;
    if (c) isActive = (state.activeContext === c);
    if (t) isActive = (state.activeTag.toLowerCase() === t.toLowerCase());

    if (isActive) {
      pill.className = 'quick-pill px-3 py-1.5 rounded-xl font-bold transition-all shrink-0 bg-indigo-600 text-white shadow-md shadow-indigo-600/30';
    } else {
      pill.className = 'quick-pill px-3 py-1.5 rounded-xl font-medium transition-all shrink-0 bg-slate-900/80 hover:bg-slate-800 text-slate-300 border border-slate-800/80';
    }
  });

  // Render Filter Pills
  const activeFilters = [];
  if (state.activeContext !== 'All') activeFilters.push({ label: `Context: ${state.activeContext}`, clear: () => setContextFilter('All') });
  if (state.activeFileType !== 'All') activeFilters.push({ label: `Type: ${state.activeFileType}`, clear: () => setFileTypeFilter('All') });
  if (state.activeTag !== 'All') activeFilters.push({ label: `Tag: #${state.activeTag}`, clear: () => setTagFilter('All') });
  if (state.activeRetentionFilter !== 'All') activeFilters.push({ label: `Retention: ${state.activeRetentionFilter}`, clear: () => setRetentionFilter('All') });
  if (state.searchQuery) activeFilters.push({ label: `Search: "${state.searchQuery}"`, clear: () => clearSearch() });

  if (activeFilters.length > 0) {
    activeFilterBar.classList.remove('hidden');
    filterPills.innerHTML = activeFilters.map((f, i) => `
      <span class="inline-flex items-center gap-1 px-3 py-1 rounded-xl text-[11px] bg-indigo-500/15 text-indigo-300 border border-indigo-500/30">
        <span>${f.label}</span>
        <button onclick="clearSpecificFilter(${i})" class="hover:text-white p-0.5 text-xs">×</button>
      </span>
    `).join('');
    window._activeFilterClears = activeFilters.map(f => f.clear);
  } else {
    activeFilterBar.classList.add('hidden');
  }

  // Handle Empty State
  if (state.files.length === 0) {
    container.innerHTML = '';
    emptyState.classList.remove('hidden');
    if (inlineDropzone) inlineDropzone.classList.add('hidden');
    return;
  }
  emptyState.classList.add('hidden');
  if (inlineDropzone) inlineDropzone.classList.remove('hidden');

  // Render Grouped or Flat
  if (state.groupingMode === 'context') {
    renderGroupedByContext(container);
  } else if (state.groupingMode === 'type') {
    renderGroupedByType(container);
  } else {
    renderFlatGrid(container);
  }

  renderIcons();
}

function clearSpecificFilter(index) {
  if (window._activeFilterClears && window._activeFilterClears[index]) {
    window._activeFilterClears[index]();
  }
}

// 1. Group by Context (Core Feature 1)
function renderGroupedByContext(container) {
  const groups = {};
  state.files.forEach(f => {
    const cat = f.context_category || 'Personal & Notes';
    if (!groups[cat]) groups[cat] = [];
    groups[cat].push(f);
  });

  const categoryConfigs = {
    'Study & Education': { icon: 'book-open', color: 'emerald', title: 'Study & Education' },
    'Finance & Invoices': { icon: 'credit-card', color: 'violet', title: 'Finance & Invoices' },
    'Work & Projects': { icon: 'briefcase', color: 'blue', title: 'Work & Projects' },
    'Legal & Identity': { icon: 'scale', color: 'amber', title: 'Legal & Identity' },
    'Code & Technical': { icon: 'code', color: 'cyan', title: 'Code & Technical' },
    'Personal & Notes': { icon: 'file-heart', color: 'pink', title: 'Personal & Notes' }
  };

  let html = '';
  for (const [catName, catFiles] of Object.entries(groups)) {
    const conf = categoryConfigs[catName] || { icon: 'folder', color: 'indigo', title: catName };
    html += `
      <section class="space-y-3">
        <div class="flex items-center justify-between pb-1 border-b border-slate-800/80">
          <div class="flex items-center gap-2">
            <span class="w-7 h-7 rounded-lg bg-${conf.color}-500/15 text-${conf.color}-400 flex items-center justify-center border border-${conf.color}-500/30">
              <i data-lucide="${conf.icon}" class="w-4 h-4"></i>
            </span>
            <h3 class="font-bold text-sm text-slate-100 tracking-tight">${conf.title}</h3>
            <span class="px-2 py-0.5 rounded-full text-[10px] font-mono bg-slate-800/80 text-slate-400 border border-slate-700/80">${catFiles.length} files</span>
          </div>
        </div>
        <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          ${catFiles.map(f => renderFileCard(f)).join('')}
        </div>
      </section>
    `;
  }
  container.innerHTML = html;
}

// 2. Group by Type
function renderGroupedByType(container) {
  const groups = {};
  state.files.forEach(f => {
    const t = f.file_type || 'Other';
    if (!groups[t]) groups[t] = [];
    groups[t].push(f);
  });

  let html = '';
  for (const [typeName, typeFiles] of Object.entries(groups)) {
    html += `
      <section class="space-y-3">
        <div class="flex items-center justify-between pb-1 border-b border-slate-800/80">
          <div class="flex items-center gap-2">
            <span class="w-7 h-7 rounded-lg bg-cyan-500/15 text-cyan-400 flex items-center justify-center border border-cyan-500/30">
              <i data-lucide="folder" class="w-4 h-4"></i>
            </span>
            <h3 class="font-bold text-sm text-slate-100 tracking-tight">${typeName}</h3>
            <span class="px-2 py-0.5 rounded-full text-[10px] font-mono bg-slate-800 text-slate-400 border border-slate-700">${typeFiles.length}</span>
          </div>
        </div>
        <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          ${typeFiles.map(f => renderFileCard(f)).join('')}
        </div>
      </section>
    `;
  }
  container.innerHTML = html;
}

// 3. Flat Grid
function renderFlatGrid(container) {
  container.innerHTML = `
    <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
      ${state.files.map(f => renderFileCard(f)).join('')}
    </div>
  `;
}

// Render Individual File Card
function renderFileCard(file) {
  const ret = file.retention_info || {};
  const isProtected = ret.is_protected;
  const isExpired = ret.status === 'expired';
  const isExpiringSoon = ret.status === 'expiring_soon';

  const ext = (file.extension || '').toLowerCase();
  const fileIcon = getIconForExtension(ext);
  const extBadge = getExtensionBadgeClass(ext);

  // Check if AI proposed name differs from current name
  const hasAiProposal = file.ai_suggested_name && file.ai_suggested_name !== file.filename;

  // Retention badge style
  let retBadgeClass = 'bg-slate-800/90 text-slate-400 border-slate-700';
  let retBadgeIcon = 'clock';
  if (isProtected) {
    retBadgeClass = 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30 font-semibold';
    retBadgeIcon = 'shield-check';
  } else if (isExpired) {
    retBadgeClass = 'bg-rose-500/15 text-rose-300 border-rose-500/30 animate-pulse font-semibold';
    retBadgeIcon = 'alert-triangle';
  } else if (isExpiringSoon) {
    retBadgeClass = 'bg-amber-500/15 text-amber-300 border-amber-500/30 font-medium';
    retBadgeIcon = 'clock';
  }

  // Tags rendering
  const tagsHtml = (file.tags || []).map(t => {
    let tStyle = 'bg-slate-800 text-slate-300 border-slate-700';
    if (t.toLowerCase() === 'important') tStyle = 'bg-amber-500/20 text-amber-300 border-amber-500/40 font-bold';
    else if (t.toLowerCase() === 'temporary') tStyle = 'bg-rose-500/20 text-rose-300 border-rose-500/40 font-medium';
    else if (t.toLowerCase() === 'study') tStyle = 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40 font-bold';
    else if (t.toLowerCase() === 'finance') tStyle = 'bg-violet-500/20 text-violet-300 border-violet-500/40 font-medium';
    else if (t.toLowerCase() === 'work') tStyle = 'bg-blue-500/20 text-blue-300 border-blue-500/40 font-medium';

    return `
      <span class="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-lg border text-[11px] ${tStyle}">
        <span>#${t}</span>
        <button onclick="event.stopPropagation(); removeTag('${file.id}', '${t}')" class="hover:text-white p-0.5" title="Remove tag">×</button>
      </span>
    `;
  }).join('');

  return `
    <div class="glass-card rounded-2xl p-4 flex flex-col justify-between gap-3.5 relative group cursor-pointer" onclick="openInspectorModal('${file.id}')">
      
      <!-- Top Row: Icon + Filename + Inline Edit -->
      <div class="flex items-start gap-3">
        <div class="w-11 h-11 rounded-xl flex items-center justify-center shrink-0 border transition-all ${extBadge.box}">
          <i data-lucide="${fileIcon}" class="w-5 h-5 ${extBadge.text}"></i>
        </div>

        <div class="flex-1 min-w-0">
          <div class="flex items-center justify-between gap-1.5">
            <h4 class="font-bold text-xs text-slate-100 truncate hover:text-indigo-300 transition-colors font-mono" title="${file.filename}">
              ${escapeHtml(file.filename)}
            </h4>
            <!-- Manual Rename Button -->
            <button 
              onclick="event.stopPropagation(); openRenameModal('${file.id}', '${escapeQuotes(file.filename)}')" 
              class="opacity-0 group-hover:opacity-100 text-slate-400 hover:text-indigo-400 p-1 rounded-md hover:bg-slate-800 transition-all" 
              title="Rename file"
            >
              <i data-lucide="edit-3" class="w-3.5 h-3.5"></i>
            </button>
          </div>

          <div class="flex items-center gap-2 text-[11px] text-slate-400 mt-1">
            <span class="px-1.5 py-0.2 rounded font-mono font-bold text-[9px] uppercase ${extBadge.pill}">${ext.replace('.', '')}</span>
            <span>${formatBytes(file.size_bytes)}</span>
            <span>•</span>
            <span>${file.word_count || 0} words</span>
            <span>•</span>
            <span class="text-slate-500 font-mono">${ret.days_old || 0}d old</span>
          </div>
        </div>
      </div>

      <!-- AI Renaming Suggestion Box (Core Feature 2) -->
      ${hasAiProposal ? `
        <div class="p-2.5 bg-indigo-950/40 border border-indigo-500/30 rounded-xl flex items-center justify-between gap-2 text-xs" onclick="event.stopPropagation()">
          <div class="min-w-0 flex items-center gap-2 text-indigo-300 truncate" title="AI Proposed Name: ${file.ai_suggested_name}">
            <i data-lucide="wand-2" class="w-3.5 h-3.5 shrink-0 text-cyan-400"></i>
            <span class="truncate font-mono text-[11px] font-semibold">${escapeHtml(file.ai_suggested_name)}</span>
          </div>
          <button 
            onclick="applyAiRename('${file.id}')" 
            class="px-2.5 py-1 bg-gradient-to-r from-indigo-600 to-cyan-600 hover:from-indigo-500 hover:to-cyan-500 text-white font-bold rounded-lg text-[10px] shrink-0 transition-all shadow-sm flex items-center gap-1"
            title="Accept standard AI filename"
          >
            <span>Accept</span>
            <i data-lucide="check" class="w-3 h-3"></i>
          </button>
        </div>
      ` : ''}

      <!-- Document Content Summary Preview -->
      <p class="text-slate-300 text-xs line-clamp-2 leading-relaxed">
        ${escapeHtml(file.ai_summary || file.extracted_text || 'No preview available.')}
      </p>

      <!-- Tags Section (Core Feature 5) -->
      <div class="flex flex-wrap items-center gap-1.5 pt-1" onclick="event.stopPropagation()">
        ${tagsHtml}
        <button 
          onclick="openQuickTagModal('${file.id}')" 
          class="px-2 py-0.5 rounded-lg border border-dashed border-slate-700 text-slate-400 hover:text-slate-200 hover:border-slate-500 text-[10px] transition-colors flex items-center gap-1"
          title="Add tag"
        >
          <i data-lucide="plus" class="w-3 h-3"></i>
          <span>tag</span>
        </button>
      </div>

      <!-- Bottom Status & Actions -->
      <div class="flex items-center justify-between pt-2.5 border-t border-slate-800/80 text-xs" onclick="event.stopPropagation()">
        
        <!-- Retention Badge (Core Feature 4) -->
        <span class="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full border text-[10px] ${retBadgeClass}" title="${ret.reason || ''}">
          <i data-lucide="${retBadgeIcon}" class="w-3 h-3"></i>
          <span>${ret.badge_text || 'Active'}</span>
        </span>

        <!-- Quick Action Buttons -->
        <div class="flex items-center gap-1">
          <!-- Inspect & Preview Button -->
          <button 
            onclick="openInspectorModal('${file.id}')" 
            class="p-1.5 hover:bg-slate-800 text-slate-300 hover:text-indigo-400 rounded-lg transition-colors flex items-center gap-1 text-[11px] font-medium"
            title="Inspect document & AI summary"
          >
            <i data-lucide="eye" class="w-3.5 h-3.5"></i>
          </button>

          <!-- Download -->
          <a 
            href="/api/download/${file.id}" 
            download 
            class="p-1.5 hover:bg-slate-800 text-slate-400 hover:text-slate-200 rounded-lg transition-colors"
            title="Download file"
          >
            <i data-lucide="download" class="w-3.5 h-3.5"></i>
          </a>

          <!-- Delete File -->
          <button 
            onclick="confirmDeleteFile('${file.id}', '${escapeQuotes(file.filename)}')" 
            class="p-1.5 hover:bg-rose-950/40 text-slate-400 hover:text-rose-400 rounded-lg transition-colors"
            title="Delete file"
          >
            <i data-lucide="trash-2" class="w-3.5 h-3.5"></i>
          </button>
        </div>

      </div>

    </div>
  `;
}

// ICON & BADGE SELECTOR
function getIconForExtension(ext) {
  const e = (ext || '').toLowerCase();
  if (['.pdf'].includes(e)) return 'file-text';
  if (['.doc', '.docx'].includes(e)) return 'file-type';
  if (['.txt', '.md'].includes(e)) return 'align-left';
  if (['.csv', '.xlsx', '.xls'].includes(e)) return 'table';
  if (['.py', '.js', '.ts', '.html', '.css', '.json'].includes(e)) return 'code';
  if (['.png', '.jpg', '.jpeg', '.svg', '.webp'].includes(e)) return 'image';
  if (['.zip', '.tar', '.gz'].includes(e)) return 'archive';
  return 'file';
}

function getExtensionBadgeClass(ext) {
  const e = (ext || '').toLowerCase();
  if (e === '.pdf') {
    return { box: 'bg-rose-500/10 border-rose-500/20', text: 'text-rose-400', pill: 'bg-rose-500/20 text-rose-300' };
  }
  if (e === '.docx' || e === '.doc') {
    return { box: 'bg-blue-500/10 border-blue-500/20', text: 'text-blue-400', pill: 'bg-blue-500/20 text-blue-300' };
  }
  if (e === '.csv' || e === '.xlsx' || e === '.xls') {
    return { box: 'bg-emerald-500/10 border-emerald-500/20', text: 'text-emerald-400', pill: 'bg-emerald-500/20 text-emerald-300' };
  }
  if (['.py', '.js', '.ts', '.html', '.css', '.json', '.sql'].includes(e)) {
    return { box: 'bg-cyan-500/10 border-cyan-500/20', text: 'text-cyan-400', pill: 'bg-cyan-500/20 text-cyan-300' };
  }
  if (['.txt', '.md', '.markdown'].includes(e)) {
    return { box: 'bg-violet-500/10 border-violet-500/20', text: 'text-violet-400', pill: 'bg-violet-500/20 text-violet-300' };
  }
  return { box: 'bg-indigo-500/10 border-indigo-500/20', text: 'text-indigo-400', pill: 'bg-slate-800 text-slate-300' };
}

// SEARCH TASKBAR (Core Feature 3)
let searchDebounceTimer = null;
function handleSearchInput(e) {
  const query = e.target.value;
  const clearBtn = document.getElementById('clearSearchBtn');
  if (clearBtn) clearBtn.classList.toggle('hidden', !query);

  clearTimeout(searchDebounceTimer);
  searchDebounceTimer = setTimeout(() => {
    state.searchQuery = query;
    fetchFiles();
    updateLiveSearchDropdown(query);
  }, 220);
}

function handleSearchKeyDown(e) {
  if (e.key === 'Enter') {
    hideSearchDropdown();
    fetchFiles();
  }
}

function clearSearch() {
  const searchInput = document.getElementById('searchInput');
  if (searchInput) searchInput.value = '';
  const clearBtn = document.getElementById('clearSearchBtn');
  if (clearBtn) clearBtn.classList.add('hidden');
  state.searchQuery = '';
  hideSearchDropdown();
  fetchFiles();
}

function updateLiveSearchDropdown(query) {
  const dropdown = document.getElementById('searchDropdown');
  const itemsContainer = document.getElementById('searchDropdownItems');
  const countText = document.getElementById('searchResultCountText');
  if (!query.trim() || state.files.length === 0) {
    hideSearchDropdown();
    return;
  }

  const q = query.toLowerCase();
  const matches = state.files.slice(0, 5);

  countText.textContent = `${state.files.length} match${state.files.length > 1 ? 'es' : ''}`;

  itemsContainer.innerHTML = matches.map(f => `
    <div 
      onclick="openInspectorModal('${f.id}'); hideSearchDropdown();" 
      class="p-3 hover:bg-slate-800/80 cursor-pointer flex items-center justify-between gap-3 text-xs"
    >
      <div class="flex items-center gap-2.5 min-w-0">
        <i data-lucide="${getIconForExtension(f.extension)}" class="w-4 h-4 text-indigo-400 shrink-0"></i>
        <div class="min-w-0">
          <div class="font-bold text-slate-100 truncate font-mono">${escapeHtml(f.filename)}</div>
          <div class="text-[11px] text-slate-400 truncate">${escapeHtml(f.ai_summary || '')}</div>
        </div>
      </div>
      <span class="px-2 py-0.5 rounded-full text-[10px] bg-slate-800 text-slate-300 border border-slate-700 shrink-0">
        ${f.context_category || 'General'}
      </span>
    </div>
  `).join('');

  dropdown.classList.remove('hidden');
  renderIcons();
}

function hideSearchDropdown() {
  const dropdown = document.getElementById('searchDropdown');
  if (dropdown) dropdown.classList.add('hidden');
}

// FILTER HANDLERS
function setContextFilter(context) {
  state.activeContext = context;
  fetchFiles();
}
function setFileTypeFilter(type) {
  state.activeFileType = type;
  fetchFiles();
}
function setTagFilter(tag) {
  state.activeTag = state.activeTag === tag ? 'All' : tag;
  fetchFiles();
}
function setRetentionFilter(status) {
  state.activeRetentionFilter = status;
  fetchFiles();
}
function resetFilters() {
  state.activeContext = 'All';
  state.activeFileType = 'All';
  state.activeTag = 'All';
  state.activeRetentionFilter = 'All';
  state.searchQuery = '';
  const searchInput = document.getElementById('searchInput');
  if (searchInput) searchInput.value = '';
  const clearBtn = document.getElementById('clearSearchBtn');
  if (clearBtn) clearBtn.classList.add('hidden');
  fetchFiles();
}

function setGroupingMode(mode) {
  state.groupingMode = mode;
  document.querySelectorAll('.group-mode-btn').forEach(btn => {
    btn.className = 'flex items-center gap-1.5 px-3 py-1.5 rounded-lg font-medium transition-all group-mode-btn text-slate-400 hover:text-slate-200';
  });
  if (mode === 'context') {
    document.getElementById('groupContextBtn').className = 'flex items-center gap-1.5 px-3 py-1.5 rounded-lg font-semibold transition-all group-mode-btn bg-indigo-600 text-white shadow-sm';
  } else if (mode === 'type') {
    document.getElementById('groupTypeBtn').className = 'flex items-center gap-1.5 px-3 py-1.5 rounded-lg font-semibold transition-all group-mode-btn bg-cyan-600 text-white shadow-sm';
  } else {
    document.getElementById('groupNoneBtn').className = 'flex items-center gap-1.5 px-3 py-1.5 rounded-lg font-semibold transition-all group-mode-btn bg-slate-700 text-white shadow-sm';
  }
  renderWorkspace();
}

function handleSortChange(val) {
  state.sortBy = val;
  fetchFiles();
}

// AI RENAMING (Core Feature 2)
async function applyAiRename(fileId) {
  try {
    const res = await fetch(`/api/files/${fileId}/rename`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ use_ai_suggested: true })
    });
    if (!res.ok) throw new Error('Failed to rename');
    const data = await res.json();
    showToast(`Renamed to "${data.file.filename}"`, 'success');
    fetchFiles();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function batchAiRenameAll() {
  const eligible = state.files.filter(f => f.ai_suggested_name && f.ai_suggested_name !== f.filename);
  if (eligible.length === 0) {
    showToast('All files are already using optimized AI names!', 'info');
    return;
  }

  if (!confirm(`Apply AI standardized names to ${eligible.length} files?`)) return;

  try {
    const res = await fetch('/api/files/batch-ai-rename', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file_ids: eligible.map(f => f.id) })
    });
    if (!res.ok) throw new Error('Batch rename failed');
    const data = await res.json();
    showToast(`Successfully renamed ${data.renamed_count} files with AI names!`, 'success');
    fetchFiles();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// MANUAL RENAMING (Core Feature 2)
function openRenameModal(fileId, currentName) {
  state.activeRenameFileId = fileId;
  const input = document.getElementById('manualRenameInput');
  if (input) input.value = currentName;
  document.getElementById('renameModal').classList.remove('hidden');
  input.focus();
}

function closeRenameModal() {
  state.activeRenameFileId = null;
  document.getElementById('renameModal').classList.add('hidden');
}

async function submitManualRename() {
  const newName = document.getElementById('manualRenameInput').value.trim();
  if (!newName || !state.activeRenameFileId) return;

  try {
    const res = await fetch(`/api/files/${state.activeRenameFileId}/rename`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ new_name: newName })
    });
    if (!res.ok) throw new Error('Rename failed');
    const data = await res.json();
    showToast(`Renamed to "${data.file.filename}"`, 'success');
    closeRenameModal();
    fetchFiles();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// QUICK TAG POPOVER MODAL
function openQuickTagModal(fileId) {
  state.activeTagTargetFileId = fileId;
  const input = document.getElementById('customTagModalInput');
  if (input) input.value = '';
  document.getElementById('quickTagModal').classList.remove('hidden');
  if (input) input.focus();
}

function closeQuickTagModal() {
  state.activeTagTargetFileId = null;
  document.getElementById('quickTagModal').classList.add('hidden');
}

async function applyQuickTag(tag) {
  if (!state.activeTagTargetFileId) return;
  try {
    const res = await fetch(`/api/files/${state.activeTagTargetFileId}/tags/add`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tag })
    });
    if (!res.ok) throw new Error('Failed to add tag');
    showToast(`Added #${tag}`, 'success');
    closeQuickTagModal();
    fetchFiles();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function submitCustomTagFromModal() {
  const input = document.getElementById('customTagModalInput');
  const tag = input.value.trim().toLowerCase();
  if (tag) {
    await applyQuickTag(tag);
  }
}

// TAGS REMOVAL
async function removeTag(fileId, tag) {
  try {
    const res = await fetch(`/api/files/${fileId}/tags/remove`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tag })
    });
    if (!res.ok) throw new Error('Failed to remove tag');
    showToast(`Removed #${tag}`, 'info');
    fetchFiles();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function promptCreateCustomTag() {
  const tag = prompt("Create a new tag to organize your files (e.g. project-x, tax-2026):");
  if (tag && tag.trim()) {
    setTagFilter(tag.trim().toLowerCase());
    showToast(`Filtering by new tag #${tag.trim().toLowerCase()}`, 'info');
  }
}

// RETENTION POLICY & CLEANUP PERMISSION REVIEW (Core Feature 4)
async function changeRetentionPolicy(days) {
  try {
    const res = await fetch('/api/retention/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ retention_days: parseInt(days) })
    });
    if (!res.ok) throw new Error('Failed to update retention policy');
    showToast(`Retention threshold set to ${days} days`, 'success');
    fetchFiles();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function dismissRetentionBanner() {
  document.getElementById('retentionAlertBanner').classList.add('hidden');
}

async function openRetentionModal() {
  try {
    const res = await fetch('/api/retention/overview');
    if (!res.ok) throw new Error('Failed loading retention data');
    const data = await res.json();

    document.getElementById('retentionThresholdText').textContent = data.retention_days;
    document.getElementById('expiredCountPill').textContent = `${data.counts.expired} expired`;

    state.selectedExpiredIds = new Set(data.pending_review_files.map(f => f.id));
    renderExpiredFilesTable(data.pending_review_files);

    document.getElementById('retentionModal').classList.remove('hidden');
    renderIcons();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function closeRetentionModal() {
  document.getElementById('retentionModal').classList.add('hidden');
}

function renderExpiredFilesTable(files) {
  const tbody = document.getElementById('expiredFilesTableBody');
  const countLabel = document.getElementById('selectedExpiredCount');
  const totalLabel = document.getElementById('totalExpiredCount');

  totalLabel.textContent = files.length;
  countLabel.textContent = state.selectedExpiredIds.size;

  if (files.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="6" class="p-6 text-center text-slate-400">
          No files currently require deletion review.
        </td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = files.map(f => {
    const isSelected = state.selectedExpiredIds.has(f.id);
    const tags = (f.tags || []).map(t => `<span class="px-2 py-0.5 rounded-lg bg-slate-800 text-[10px] text-slate-300">#${t}</span>`).join(' ');

    return `
      <tr class="hover:bg-slate-800/50 transition-colors">
        <td class="p-3">
          <input 
            type="checkbox" 
            ${isSelected ? 'checked' : ''} 
            onchange="toggleExpiredSelect('${f.id}', this.checked)"
            class="w-4 h-4 rounded text-rose-600 bg-slate-800 border-slate-700 cursor-pointer"
          >
        </td>
        <td class="p-3">
          <div class="font-bold text-slate-100 font-mono">${escapeHtml(f.filename)}</div>
          <div class="text-[11px] text-slate-400 truncate max-w-xs">${escapeHtml(f.ai_summary || '')}</div>
        </td>
        <td class="p-3">
          <span class="px-2 py-0.5 rounded-full text-[10px] bg-slate-800 text-slate-300">${f.context_category}</span>
        </td>
        <td class="p-3 font-semibold text-rose-400">
          ${f.retention_info.days_old} days old
        </td>
        <td class="p-3">
          <div class="flex flex-wrap gap-1">${tags}</div>
        </td>
        <td class="p-3 text-right">
          <button 
            onclick="quickProtectFile('${f.id}')" 
            class="px-2.5 py-1 bg-emerald-600/20 hover:bg-emerald-600/30 text-emerald-300 border border-emerald-500/30 rounded-lg text-[11px] font-semibold"
            title="Mark Important to protect permanently"
          >
            Protect
          </button>
        </td>
      </tr>
    `;
  }).join('');
}

function toggleExpiredSelect(fileId, checked) {
  if (checked) state.selectedExpiredIds.add(fileId);
  else state.selectedExpiredIds.delete(fileId);
  document.getElementById('selectedExpiredCount').textContent = state.selectedExpiredIds.size;
}

function toggleSelectAllExpired(checked) {
  const checkboxes = document.querySelectorAll('#expiredFilesTableBody input[type="checkbox"]');
  checkboxes.forEach(cb => cb.checked = checked);
  if (checked) {
    state.files.filter(f => f.retention_info?.status === 'expired').forEach(f => state.selectedExpiredIds.add(f.id));
  } else {
    state.selectedExpiredIds.clear();
  }
  document.getElementById('selectedExpiredCount').textContent = state.selectedExpiredIds.size;
}

async function quickProtectFile(fileId) {
  try {
    const res = await fetch('/api/retention/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file_ids: [fileId], action: 'protect' })
    });
    if (!res.ok) throw new Error('Action failed');
    showToast('Marked as Important! Safely immune to deletion.', 'success');
    openRetentionModal();
    fetchFiles();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function handleRetentionBatchAction(action) {
  const ids = Array.from(state.selectedExpiredIds);
  if (ids.length === 0) {
    showToast('Please select at least one file.', 'warning');
    return;
  }

  let promptMsg = `Perform "${action}" on ${ids.length} selected files?`;
  if (action === 'delete') {
    promptMsg = `⚠️ Are you sure you want to PERMANENTLY delete ${ids.length} stale files?\n(Note: Files tagged 'important' are strictly excluded and safe!)`;
  }
  if (!confirm(promptMsg)) return;

  try {
    const res = await fetch('/api/retention/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file_ids: ids, action })
    });
    if (!res.ok) throw new Error('Action failed');
    const data = await res.json();
    showToast(`Retention action "${action}" completed for ${data.success.length} files.`, 'success');
    closeRetentionModal();
    fetchFiles();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// DELETE FILE CONFIRMATION
async function confirmDeleteFile(fileId, filename) {
  if (!confirm(`Delete file "${filename}" permanently?`)) return;

  try {
    const res = await fetch(`/api/files/${fileId}`, { method: 'DELETE' });
    if (!res.ok) throw new Error('Delete failed');
    showToast(`Deleted "${filename}"`, 'info');
    fetchFiles();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// INSPECTOR & PREVIEW MODAL
async function openInspectorModal(fileId) {
  try {
    const res = await fetch(`/api/files/${fileId}`);
    if (!res.ok) throw new Error('Failed fetching file details');
    const file = await res.json();
    state.currentInspectedFile = file;

    document.getElementById('inspectorFilename').textContent = file.filename;
    document.getElementById('inspectorCategoryBadge').textContent = file.context_category;
    document.getElementById('inspectorMetaText').textContent = `Size: ${formatBytes(file.size_bytes)} • ${file.word_count || 0} words • ${file.reading_time_minutes || 1} min read`;
    document.getElementById('inspectorDownloadLink').href = `/api/download/${file.id}`;

    // AI Tab
    document.getElementById('inspectorSummary').textContent = file.ai_summary || 'No summary available.';
    document.getElementById('inspectorAiProposedName').textContent = file.ai_suggested_name || file.filename;
    document.getElementById('inspectorAiReason').textContent = file.ai_rename_reason || 'AI recommendation based on document content.';

    // Tags
    renderInspectorTags(file.tags || []);

    // Content Tab
    document.getElementById('inspectorExtractedText').textContent = file.extracted_text || 'No text extracted.';

    // Retention Tab
    const ret = file.retention_info || {};
    document.getElementById('inspectorCreatedAt').textContent = file.created_at ? new Date(file.created_at).toLocaleDateString() : '-';
    document.getElementById('inspectorAgeText').textContent = `${ret.days_old || 0} days old`;
    document.getElementById('inspectorRetentionStatusBadge').innerHTML = `
      <span class="px-2.5 py-1 rounded-lg text-[10px] font-bold ${
        ret.status === 'protected' ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30' :
        ret.status === 'expired' ? 'bg-rose-500/20 text-rose-300 border border-rose-500/30' : 'bg-slate-800 text-slate-300 border border-slate-700'
      }">${ret.badge_text || ret.status}</span>
    `;
    document.getElementById('inspectorProtectionText').textContent = ret.is_protected ? '🛡️ Protected (Immune to cleanup)' : 'Standard Lifecycle (Subject to retention)';

    switchInspectorTab('ai');
    document.getElementById('inspectorModal').classList.remove('hidden');
    renderIcons();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function closeInspectorModal() {
  state.currentInspectedFile = null;
  document.getElementById('inspectorModal').classList.add('hidden');
}

function switchInspectorTab(tab) {
  document.getElementById('inspectorTabAi').classList.toggle('hidden', tab !== 'ai');
  document.getElementById('inspectorTabContent').classList.toggle('hidden', tab !== 'content');
  document.getElementById('inspectorTabRetention').classList.toggle('hidden', tab !== 'retention');

  const btnAi = document.getElementById('tabBtnAi');
  const btnContent = document.getElementById('tabBtnContent');
  const btnRetention = document.getElementById('tabBtnRetention');

  const activeClasses = 'px-4 py-2.5 font-bold border-b-2 border-indigo-500 text-indigo-400 flex items-center gap-1.5';
  const inactiveClasses = 'px-4 py-2.5 font-medium border-b-2 border-transparent text-slate-400 hover:text-slate-200 flex items-center gap-1.5';

  btnAi.className = tab === 'ai' ? activeClasses : inactiveClasses;
  btnContent.className = tab === 'content' ? activeClasses : inactiveClasses;
  btnRetention.className = tab === 'retention' ? activeClasses : inactiveClasses;
}

function renderInspectorTags(tags) {
  const container = document.getElementById('inspectorTagsList');
  if (!container) return;
  container.innerHTML = tags.map(t => `
    <span class="inline-flex items-center gap-1.5 px-3 py-1 rounded-xl bg-slate-800 text-slate-200 border border-slate-700 text-xs font-mono">
      <span>#${t}</span>
      <button onclick="removeTagFromInspector('${t}')" class="hover:text-rose-400 p-0.5">×</button>
    </span>
  `).join('');
}

async function removeTagFromInspector(tag) {
  if (!state.currentInspectedFile) return;
  await removeTag(state.currentInspectedFile.id, tag);
  openInspectorModal(state.currentInspectedFile.id);
}

async function addTagFromInspector() {
  const input = document.getElementById('inspectorNewTagInput');
  const tag = input.value.trim().toLowerCase();
  if (!tag || !state.currentInspectedFile) return;
  await fetch(`/api/files/${state.currentInspectedFile.id}/tags/add`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tag })
  });
  input.value = '';
  openInspectorModal(state.currentInspectedFile.id);
  fetchFiles();
}

async function applyInspectorAiName() {
  if (!state.currentInspectedFile) return;
  await applyAiRename(state.currentInspectedFile.id);
  openInspectorModal(state.currentInspectedFile.id);
}

async function simulateAgeCurrentFile(days) {
  if (!state.currentInspectedFile) return;
  await fetch(`/api/files/${state.currentInspectedFile.id}/set-age`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ days_old: days })
  });
  showToast(`Simulated age to ${days} days`, 'info');
  openInspectorModal(state.currentInspectedFile.id);
  fetchFiles();
}

function copyExtractedText() {
  const text = document.getElementById('inspectorExtractedText').textContent;
  navigator.clipboard.writeText(text);
  showToast('Document text copied to clipboard!', 'success');
}

// UPLOAD MODAL & DRAG AND DROP
let selectedFiles = [];

function openUploadModal() {
  selectedFiles = [];
  document.getElementById('selectedFilesList').classList.add('hidden');
  document.getElementById('selectedFilesList').innerHTML = '';
  document.getElementById('fileInput').value = '';
  document.getElementById('initialTagsInput').value = '';
  document.getElementById('uploadModal').classList.remove('hidden');
  setupModalDropZone();
}

function closeUploadModal() {
  document.getElementById('uploadModal').classList.add('hidden');
}

function setupModalDropZone() {
  const dropZone = document.getElementById('dropZone');
  if (!dropZone) return;

  ['dragenter', 'dragover'].forEach(name => {
    dropZone.addEventListener(name, (e) => {
      e.preventDefault();
      dropZone.classList.add('dragover');
    });
  });

  ['dragleave', 'drop'].forEach(name => {
    dropZone.addEventListener(name, (e) => {
      e.preventDefault();
      dropZone.classList.remove('dragover');
    });
  });

  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    if (e.dataTransfer.files) {
      handleFiles(Array.from(e.dataTransfer.files));
    }
  });
}

function handleFileSelect(e) {
  if (e.target.files) {
    handleFiles(Array.from(e.target.files));
  }
}

function handleFiles(files) {
  selectedFiles = files;
  const list = document.getElementById('selectedFilesList');
  list.classList.remove('hidden');
  list.innerHTML = selectedFiles.map(f => `
    <div class="flex items-center justify-between p-2.5 rounded-xl bg-slate-800/80 border border-slate-700/80 text-slate-200">
      <span class="font-mono truncate font-semibold">${escapeHtml(f.name)}</span>
      <span class="text-indigo-400 font-mono text-[10px] font-bold">${formatBytes(f.size)}</span>
    </div>
  `).join('');
}

function appendTagToInput(tag) {
  const input = document.getElementById('initialTagsInput');
  const current = input.value.split(',').map(s => s.trim()).filter(Boolean);
  if (!current.includes(tag)) {
    current.push(tag);
    input.value = current.join(', ');
  }
}

async function submitUpload() {
  if (selectedFiles.length === 0) {
    showToast('Please select at least one file to upload', 'warning');
    return;
  }

  const btn = document.getElementById('uploadSubmitBtn');
  btn.disabled = true;
  btn.innerHTML = '<span>Processing documents...</span>';

  const formData = new FormData();
  selectedFiles.forEach(f => formData.append('files', f));
  formData.append('auto_rename', document.getElementById('autoRenameOnUpload').checked);
  formData.append('initial_tags', document.getElementById('initialTagsInput').value);

  try {
    const res = await fetch('/api/files/upload', {
      method: 'POST',
      body: formData
    });
    if (!res.ok) throw new Error('Upload failed');
    const data = await res.json();
    showToast(`Successfully analyzed and uploaded ${data.count} document${data.count > 1 ? 's' : ''}!`, 'success');
    closeUploadModal();
    fetchFiles();
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i data-lucide="check" class="w-3.5 h-3.5"></i><span>Process & Upload</span>';
    renderIcons();
  }
}

// UTILITY FUNCTIONS
function toggleLoading(isLoading) {
  const loading = document.getElementById('loadingState');
  if (loading) loading.classList.toggle('hidden', !isLoading);
}

function formatBytes(bytes, decimals = 1) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function escapeQuotes(str) {
  if (!str) return '';
  return str.replace(/'/g, "\\'").replace(/"/g, '&quot;');
}
