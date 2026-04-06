// Notus — Private Local Notes with Editor.js (Notion-like block editor)

const DB_NAME = 'notus';
const DB_VERSION = 1;
const STORE_NAME = 'notes';

// ── Database ──────────────────────────────────────────────
class NotesDB {
  constructor() { this.db = null; }
  async init() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onerror = () => reject(req.error);
      req.onsuccess = () => { this.db = req.result; resolve(); };
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
          store.createIndex('updatedAt', 'updatedAt');
          store.createIndex('tags', 'tags', { multiEntry: true });
        }
      };
    });
  }
  async getAll() {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).index('updatedAt').getAll();
      req.onsuccess = () => resolve(req.result.reverse());
      req.onerror = () => reject(req.error);
    });
  }
  async save(note) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put(note);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
  async delete(id) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
  async getAllTags() {
    const notes = await this.getAll();
    const tags = new Set();
    notes.forEach(n => (n.tags || []).forEach(t => tags.add(t)));
    return [...tags].sort();
  }
}

// ── State ─────────────────────────────────────────────────
const db = new NotesDB();
let notes = [];
let activeNote = null;
let activeFilter = null;
let searchQuery = '';
let connectorPort = 9471;
let connectorConnected = false;
let saveTimeout = null;
let editor = null; // Editor.js instance
let claudeScope = 'all';
let noteVersions = []; // for undo

const $ = (sel) => document.querySelector(sel);

// ── Init ──────────────────────────────────────────────────
async function init() {
  await db.init();
  notes = await db.getAll();
  loadTheme();
  const savedPort = localStorage.getItem('notus-port');
  if (savedPort) connectorPort = parseInt(savedPort);
  renderNotesList();
  renderTags();
  checkConnector();
  setInterval(checkConnector, 10000);
  bindEvents();
  updateStats();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
}

// ── Render notes list ─────────────────────────────────────
function renderNotesList() {
  const list = $('#notes-list');
  const filtered = notes.filter(n => {
    if (activeFilter && !(n.tags || []).includes(activeFilter)) return false;
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      return n.title.toLowerCase().includes(q) || blocksToText(n.body).toLowerCase().includes(q);
    }
    return true;
  });

  if (filtered.length === 0) {
    list.innerHTML = `<div class="empty-state" style="padding:40px 0"><p>${searchQuery || activeFilter ? 'No matching notes' : 'Create your first note'}</p></div>`;
    return;
  }

  list.innerHTML = filtered.map(n => `
    <div class="note-item ${activeNote?.id === n.id ? 'active' : ''}" onclick="selectNote('${n.id}')">
      <div class="note-item-title">${esc(n.title || 'Untitled')}</div>
      <div class="note-item-preview">${esc(truncate(blocksToText(n.body), 80))}</div>
      <div class="note-item-meta">
        <span>${formatDate(n.updatedAt)}</span>
        <div class="note-item-tags">${(n.tags || []).slice(0, 2).map(t => `<span class="note-item-tag">${esc(t)}</span>`).join('')}</div>
      </div>
    </div>`).join('');
}

function renderTags() {
  db.getAllTags().then(tags => {
    $('#tags-filter').innerHTML = tags.map(t =>
      `<span class="tag-pill ${activeFilter === t ? 'active' : ''}" onclick="filterByTag('${esc(t)}')">${esc(t)}</span>`
    ).join('');
  });
}

// ── Editor ────────────────────────────────────────────────
async function renderEditor() {
  const area = $('#editor-area');
  if (editor) { await editor.destroy(); editor = null; }

  if (!activeNote) {
    area.innerHTML = `<div class="empty-state"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg><p>Select a note or create a new one</p></div>`;
    return;
  }

  area.innerHTML = `
    <div class="editor-topbar">
      <input type="text" class="note-title-input" id="note-title" value="${escAttr(activeNote.title)}" placeholder="Untitled" oninput="onTitleChange(this.value)">
      <div class="editor-topbar-right">
        <button class="btn btn-icon btn-danger" onclick="deleteNote()" title="Delete"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg></button>
      </div>
    </div>
    <div class="tags-bar">
      <div class="current-tags">${(activeNote.tags || []).map(t => `<span class="current-tag">${esc(t)} <span class="remove-tag" onclick="removeTag('${esc(t)}')">&times;</span></span>`).join('')}</div>
      <input type="text" class="tags-input" placeholder="Add tag..." onkeydown="onTagKeydown(event)">
    </div>
    ${noteVersions.length > 0 ? `<div class="undo-bar"><span>Claude edited — ${noteVersions.length} version(s)</span><button class="btn btn-sm" onclick="undoClaudeEdit()">Undo</button></div>` : ''}
    <div class="editor-content" id="editorjs"></div>
    <div class="claude-bar">
      <svg class="claude-icon" viewBox="0 0 24 24" width="16" height="16"><use href="#claude-logo"/></svg>
      <input type="text" id="claude-prompt" placeholder="Ask Claude to edit this note..." onkeydown="if(event.key==='Enter'){event.preventDefault();sendClaude();}">
      <button class="btn btn-sm btn-claude-send" onclick="sendClaude()">Send</button>
    </div>`;

  // Parse body — support both legacy HTML and new Editor.js JSON
  let editorData = { blocks: [] };
  if (activeNote.body) {
    if (typeof activeNote.body === 'string') {
      try {
        const parsed = JSON.parse(activeNote.body);
        if (parsed.blocks) editorData = parsed;
        else editorData = { blocks: [{ type: 'paragraph', data: { text: activeNote.body } }] };
      } catch {
        // Legacy HTML — convert to paragraph
        editorData = { blocks: [{ type: 'paragraph', data: { text: stripHtml(activeNote.body) } }] };
      }
    } else if (activeNote.body.blocks) {
      editorData = activeNote.body;
    }
  }

  editor = new EditorJS({
    holder: 'editorjs',
    data: editorData,
    placeholder: 'Start writing... Use / for block menu',
    autofocus: !activeNote.title,
    tools: {
      header: { class: Header, config: { levels: [1, 2, 3, 4], defaultLevel: 2 }, shortcut: 'CMD+SHIFT+H' },
      list: { class: NestedList, inlineToolbar: true, config: { defaultStyle: 'unordered' }, shortcut: 'CMD+SHIFT+L' },
      checklist: { class: Checklist, inlineToolbar: true, shortcut: 'CMD+SHIFT+X' },
      table: { class: Table, inlineToolbar: true, config: { rows: 2, cols: 3 } },
      quote: { class: Quote, config: { quotePlaceholder: 'Enter a quote', captionPlaceholder: 'Quote author' }, shortcut: 'CMD+SHIFT+O' },
      code: { class: CodeTool, shortcut: 'CMD+SHIFT+C' },
      delimiter: { class: Delimiter },
      warning: { class: Warning, config: { titlePlaceholder: 'Title', messagePlaceholder: 'Message' } },
      marker: { class: Marker, shortcut: 'CMD+SHIFT+M' },
      inlineCode: { class: InlineCode, shortcut: 'CMD+SHIFT+E' },
    },
    onChange: () => scheduleSave(),
  });

  if (activeNote.title) setTimeout(() => $('#note-title')?.focus(), 50);
}

// ── Save ──────────────────────────────────────────────────
function scheduleSave() {
  clearTimeout(saveTimeout);
  saveTimeout = setTimeout(async () => {
    if (!activeNote || !editor) return;
    const data = await editor.save();
    activeNote.body = JSON.stringify(data);
    activeNote.updatedAt = Date.now();
    await db.save(activeNote);
    renderNotesList();
  }, 600);
}

// ── Note actions ──────────────────────────────────────────
async function createNote() {
  // Flush current note
  if (editor && activeNote) {
    const data = await editor.save();
    activeNote.body = JSON.stringify(data);
    activeNote.updatedAt = Date.now();
    await db.save(activeNote);
  }
  const note = { id: crypto.randomUUID(), title: '', body: JSON.stringify({ blocks: [] }), tags: [], createdAt: Date.now(), updatedAt: Date.now() };
  await db.save(note);
  notes.unshift(note);
  activeNote = note;
  noteVersions = [];
  renderNotesList();
  renderEditor();
  renderTags();
  updateStats();
  closeSidebar();
}

async function selectNote(id) {
  if (editor && activeNote) {
    const data = await editor.save();
    activeNote.body = JSON.stringify(data);
    activeNote.updatedAt = Date.now();
    await db.save(activeNote);
  }
  activeNote = notes.find(n => n.id === id) || null;
  noteVersions = [];
  renderNotesList();
  renderEditor();
  closeSidebar();
}

async function deleteNote() {
  if (!activeNote) return;
  const ok = await showConfirm('Delete note', `Delete "${activeNote.title || 'Untitled'}" permanently?`);
  if (!ok) return;
  await db.delete(activeNote.id);
  notes = notes.filter(n => n.id !== activeNote.id);
  activeNote = notes[0] || null;
  noteVersions = [];
  renderNotesList();
  renderEditor();
  renderTags();
  updateStats();
  toast('Note deleted');
}

function onTitleChange(val) {
  if (!activeNote) return;
  activeNote.title = val;
  clearTimeout(saveTimeout);
  saveTimeout = setTimeout(async () => {
    activeNote.updatedAt = Date.now();
    await db.save(activeNote);
    renderNotesList();
  }, 400);
}

function onTagKeydown(e) {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  const tag = e.target.value.trim().toLowerCase();
  if (tag && activeNote && !(activeNote.tags || []).includes(tag)) {
    activeNote.tags = [...(activeNote.tags || []), tag];
    activeNote.updatedAt = Date.now();
    db.save(activeNote);
    renderEditor();
    renderTags();
    renderNotesList();
  }
  e.target.value = '';
}

function removeTag(tag) {
  if (!activeNote) return;
  activeNote.tags = (activeNote.tags || []).filter(t => t !== tag);
  activeNote.updatedAt = Date.now();
  db.save(activeNote);
  renderEditor();
  renderTags();
  renderNotesList();
}

function filterByTag(tag) {
  activeFilter = activeFilter === tag ? null : tag;
  renderNotesList();
  renderTags();
}

function onSearch(val) { searchQuery = val; renderNotesList(); }

// ── Claude: Edit note directly ────────────────────────────
async function sendClaude() {
  const input = $('#claude-prompt');
  const prompt = input.value.trim();
  if (!prompt || !activeNote || !editor) return;
  if (!connectorConnected) { toast('Connector offline', 'error'); return; }

  // Save snapshot for undo
  const currentData = await editor.save();
  noteVersions.push({ data: JSON.stringify(currentData), timestamp: Date.now(), prompt });
  if (noteVersions.length > 30) noteVersions.shift();

  input.value = '';
  input.disabled = true;
  input.placeholder = 'Claude is editing...';

  try {
    const plainText = blocksToText(activeNote.body);
    const res = await fetch(`http://localhost:${connectorPort}/transform`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, text: plainText })
    });
    const data = await res.json();
    if (data.result && !data.error) {
      // Convert Claude's markdown to Editor.js blocks
      const newBlocks = markdownToBlocks(data.result);
      await editor.render({ blocks: newBlocks });
      // Save
      activeNote.body = JSON.stringify({ blocks: newBlocks });
      activeNote.updatedAt = Date.now();
      await db.save(activeNote);
      renderNotesList();
      renderEditor(); // re-render to show undo bar
      toast('Note edited by Claude');
    } else {
      toast(data.error || 'No response', 'error');
      noteVersions.pop();
    }
  } catch {
    toast('Connection failed', 'error');
    noteVersions.pop();
  }

  input.disabled = false;
  input.placeholder = 'Ask Claude to edit this note...';
}

function undoClaudeEdit() {
  if (noteVersions.length === 0 || !editor || !activeNote) return;
  const prev = noteVersions.pop();
  const prevData = JSON.parse(prev.data);
  editor.render(prevData);
  activeNote.body = prev.data;
  activeNote.updatedAt = Date.now();
  db.save(activeNote);
  renderNotesList();
  renderEditor();
  toast('Reverted');
}

// ── Claude: Global panel ──────────────────────────────────
function openGlobalClaude() {
  $('#claude-panel').classList.add('open');
  if (activeNote) setClaudeScope('current');
  db.getAllTags().then(tags => {
    $('#claude-tag-select').innerHTML = '<option value="">Select tag...</option>' + tags.map(t => `<option>${esc(t)}</option>`).join('');
  });
  setTimeout(() => $('#claude-global-prompt')?.focus(), 100);
}
function closeGlobalClaude() { $('#claude-panel').classList.remove('open'); }
function setClaudeScope(scope) {
  claudeScope = scope;
  document.querySelectorAll('.scope-btn').forEach(b => b.classList.toggle('active', b.dataset.scope === scope));
  $('#claude-tag-select').style.display = scope === 'tag' ? 'block' : 'none';
}

async function sendGlobalClaude() {
  const prompt = $('#claude-global-prompt').value.trim();
  if (!prompt || !connectorConnected) return;
  const resultDiv = $('#claude-global-result');
  resultDiv.innerHTML = '<div class="claude-loading"><div class="spinner"></div> Analyzing...</div>';

  let targetNotes;
  if (claudeScope === 'current' && activeNote) targetNotes = [activeNote];
  else if (claudeScope === 'tag') {
    const tag = $('#claude-tag-select').value;
    targetNotes = tag ? notes.filter(n => (n.tags || []).includes(tag)) : [];
  } else targetNotes = notes;

  if (targetNotes.length === 0) { resultDiv.innerHTML = '<p>No notes to analyze</p>'; return; }

  const notesText = targetNotes.map(n => `Title: ${n.title}\nTags: ${(n.tags||[]).join(', ')}\n${blocksToText(n.body)}`).join('\n\n---\n\n');

  try {
    const endpoint = targetNotes.length === 1 ? '/analyze' : '/analyze-all';
    const body = targetNotes.length === 1
      ? { action: 'custom', note: { title: targetNotes[0].title, body: blocksToText(targetNotes[0].body), tags: targetNotes[0].tags }, prompt: `${prompt}\n\n${notesText}` }
      : { action: 'custom', notes: targetNotes.map(n => ({ title: n.title, body: blocksToText(n.body), tags: n.tags })), prompt: `${prompt}\n\n${notesText}` };
    const res = await fetch(`http://localhost:${connectorPort}${endpoint}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json();
    resultDiv.innerHTML = formatClaudeResult(data.result || data.error || 'No result');
  } catch { resultDiv.innerHTML = '<p style="color:var(--danger)">Connection failed</p>'; }
}

// ── Markdown → Editor.js blocks ───────────────────────────
function markdownToBlocks(md) {
  const lines = md.split('\n');
  const blocks = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Empty line — skip
    if (line.trim() === '') { i++; continue; }

    // Horizontal rule
    if (/^---+$/.test(line.trim())) {
      blocks.push({ type: 'delimiter', data: {} });
      i++; continue;
    }

    // Header
    const hMatch = line.match(/^(#{1,4})\s+(.+)/);
    if (hMatch) {
      blocks.push({ type: 'header', data: { text: inlineMd(hMatch[2]), level: hMatch[1].length } });
      i++; continue;
    }

    // Code block
    if (line.trim().startsWith('```')) {
      const codeLang = line.trim().slice(3);
      const codeLines = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith('```')) { codeLines.push(lines[i]); i++; }
      i++; // skip closing ```
      blocks.push({ type: 'code', data: { code: codeLines.join('\n') } });
      continue;
    }

    // Table
    if (line.includes('|') && line.trim().startsWith('|')) {
      const tableRows = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim().startsWith('|')) {
        const row = lines[i].split('|').map(c => c.trim()).filter((c, j, a) => j > 0 && j < a.length);
        if (!/^[\-:\s]+$/.test(row.join(''))) tableRows.push(row);
        i++;
      }
      if (tableRows.length > 0) {
        const withHeadings = tableRows.length > 1;
        blocks.push({ type: 'table', data: { withHeadings, content: tableRows } });
      }
      continue;
    }

    // Checklist: - [ ] or - [x]
    if (/^- \[[ x]\] /.test(line)) {
      const items = [];
      while (i < lines.length && /^- \[[ x]\] /.test(lines[i])) {
        const m = lines[i].match(/^- \[([ x])\] (.+)/);
        items.push({ text: inlineMd(m[2]), checked: m[1] === 'x' });
        i++;
      }
      blocks.push({ type: 'checklist', data: { items } });
      continue;
    }

    // Unordered list
    if (/^[\-\*] /.test(line)) {
      const items = [];
      while (i < lines.length && /^[\-\*] /.test(lines[i])) {
        items.push({ content: inlineMd(lines[i].replace(/^[\-\*] /, '')), items: [] });
        i++;
      }
      blocks.push({ type: 'list', data: { style: 'unordered', items } });
      continue;
    }

    // Ordered list
    if (/^\d+\.\s/.test(line)) {
      const items = [];
      while (i < lines.length && /^\d+\.\s/.test(lines[i])) {
        items.push({ content: inlineMd(lines[i].replace(/^\d+\.\s+/, '')), items: [] });
        i++;
      }
      blocks.push({ type: 'list', data: { style: 'ordered', items } });
      continue;
    }

    // Blockquote
    if (line.startsWith('> ')) {
      const quoteLines = [];
      while (i < lines.length && lines[i].startsWith('> ')) {
        quoteLines.push(lines[i].slice(2));
        i++;
      }
      blocks.push({ type: 'quote', data: { text: inlineMd(quoteLines.join('<br>')), caption: '' } });
      continue;
    }

    // Warning/callout (custom: ⚠ or !> prefix)
    if (line.startsWith('!> ') || line.startsWith('⚠ ')) {
      blocks.push({ type: 'warning', data: { title: 'Note', message: inlineMd(line.slice(3)) } });
      i++; continue;
    }

    // Paragraph (default)
    blocks.push({ type: 'paragraph', data: { text: inlineMd(line) } });
    i++;
  }

  return blocks.length > 0 ? blocks : [{ type: 'paragraph', data: { text: '' } }];
}

// Inline markdown: bold, italic, code, strikethrough, links
function inlineMd(text) {
  return text
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '<i>$1</i>')
    .replace(/~~(.+?)~~/g, '<s>$1</s>')
    .replace(/`([^`]+)`/g, '<code class="inline-code">$1</code>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
}

// ── Editor.js blocks → plain text ─────────────────────────
function blocksToText(body) {
  if (!body) return '';
  let data;
  if (typeof body === 'string') {
    try { data = JSON.parse(body); } catch { return body.replace(/<[^>]+>/g, ''); }
  } else { data = body; }
  if (!data.blocks) return '';
  return data.blocks.map(b => {
    switch (b.type) {
      case 'paragraph': return stripTags(b.data.text || '');
      case 'header': return stripTags(b.data.text || '');
      case 'list': return (b.data.items || []).map(i => stripTags(typeof i === 'string' ? i : i.content || '')).join('\n');
      case 'checklist': return (b.data.items || []).map(i => `${i.checked ? '[x]' : '[ ]'} ${stripTags(i.text)}`).join('\n');
      case 'quote': return stripTags(b.data.text || '');
      case 'code': return b.data.code || '';
      case 'table': return (b.data.content || []).map(r => r.join(' | ')).join('\n');
      case 'warning': return `${b.data.title}: ${b.data.message}`;
      default: return '';
    }
  }).filter(Boolean).join('\n');
}

function stripTags(html) { const d = document.createElement('div'); d.innerHTML = html; return d.textContent || ''; }

// ── Format Claude result for display ──────────────────────
function formatClaudeResult(text) {
  if (!text) return '';
  const codeBlocks = [];
  let html = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, l, c) => { codeBlocks.push(`<pre><code>${esc(c.trim())}</code></pre>`); return `\x00C${codeBlocks.length-1}\x00`; });
  html = esc(html);
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/^### (.+)$/gm, '<h4>$1</h4>');
  html = html.replace(/^## (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^# (.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^[\-\*] (.+)$/gm, '<li>$1</li>');
  html = html.replace(/((<li>.*<\/li>\s*)+)/g, '<ul>$1</ul>');
  html = html.replace(/^\d+\.\s+(.+)$/gm, '<li>$1</li>');
  html = html.replace(/\n\n+/g, '</p><p>');
  html = html.replace(/\n/g, '<br>');
  html = html.replace(/\x00C(\d+)\x00/g, (_, i) => codeBlocks[i]);
  return '<div class="claude-result"><p>' + html + '</p></div>';
}

// ── Confirm modal ─────────────────────────────────────────
function showConfirm(title, message) {
  return new Promise(resolve => {
    const ov = document.createElement('div');
    ov.className = 'modal-overlay visible';
    ov.innerHTML = `<div class="modal confirm-modal" onclick="event.stopPropagation()">
      <h2>${esc(title)}</h2>
      <p style="color:var(--text-secondary);margin-bottom:20px">${esc(message)}</p>
      <div class="modal-actions"><button class="btn" id="c-cancel">Cancel</button><button class="btn" style="background:var(--danger);border-color:var(--danger);color:white" id="c-ok">Delete</button></div>
    </div>`;
    document.body.appendChild(ov);
    const close = (r) => { ov.remove(); resolve(r); };
    ov.querySelector('#c-cancel').onclick = () => close(false);
    ov.querySelector('#c-ok').onclick = () => close(true);
    ov.onclick = (e) => { if (e.target === ov) close(false); };
  });
}

// ── Import / Export ───────────────────────────────────────
function exportAllNotes() {
  const data = JSON.stringify(notes, null, 2);
  const blob = new Blob([data], { type: 'application/json' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'notus-export.json'; a.click();
  toast(`Exported ${notes.length} notes`);
}

function importNotes() {
  const input = document.createElement('input'); input.type = 'file'; input.accept = '.json';
  input.onchange = async (e) => {
    try {
      const data = JSON.parse(await e.target.files[0].text());
      const arr = Array.isArray(data) ? data : [data];
      let count = 0;
      for (const n of arr) {
        if (n.id) { n.updatedAt = n.updatedAt || Date.now(); n.createdAt = n.createdAt || Date.now(); n.tags = n.tags || []; n.title = n.title || 'Imported'; await db.save(n); count++; }
      }
      notes = await db.getAll(); renderNotesList(); renderTags(); updateStats();
      toast(`Imported ${count} note(s)`);
    } catch { toast('Invalid file', 'error'); }
  };
  input.click();
}

// ── Connector ─────────────────────────────────────────────
async function checkConnector() {
  try {
    const res = await fetch(`http://localhost:${connectorPort}/health`, { signal: AbortSignal.timeout(2000) });
    connectorConnected = (await res.json()).status === 'ok';
  } catch { connectorConnected = false; }
  const dot = $('#connector-dot');
  const text = $('#connector-text');
  if (dot) dot.className = `status-dot ${connectorConnected ? 'connected' : ''}`;
  if (text) text.textContent = connectorConnected ? 'Claude connected' : 'Connector offline';
}

// ── Settings ──────────────────────────────────────────────
function openSettings() { $('#settings-modal').classList.add('visible'); }
function closeSettings() { $('#settings-modal').classList.remove('visible'); }
function saveSettings() {
  connectorPort = parseInt($('#connector-port-input').value) || 9471;
  localStorage.setItem('notus-port', connectorPort);
  closeSettings(); checkConnector(); toast('Saved');
}

// ── Theme / Sidebar ───────────────────────────────────────
function toggleTheme() {
  const next = (document.documentElement.getAttribute('data-theme') || 'dark') === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('notus-theme', next);
}
function loadTheme() { document.documentElement.setAttribute('data-theme', localStorage.getItem('notus-theme') || 'dark'); }
function toggleSidebar() { $('#sidebar').classList.toggle('mobile-open'); $('#sidebar-overlay')?.classList.toggle('visible'); }
function closeSidebar() { $('#sidebar').classList.remove('mobile-open'); $('#sidebar-overlay')?.classList.remove('visible'); }

// ── Helpers ───────────────────────────────────────────────
function esc(s) { return !s ? '' : s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function escAttr(s) { return esc(s); }
function truncate(s, n) { return !s ? '' : s.length > n ? s.slice(0, n) + '...' : s; }
function formatDate(ts) {
  if (!ts) return '';
  const d = Date.now() - ts;
  if (d < 60000) return 'Just now';
  if (d < 3600000) return `${Math.floor(d/60000)}m ago`;
  if (d < 86400000) return `${Math.floor(d/3600000)}h ago`;
  return new Date(ts).toLocaleDateString();
}
function updateStats() { const el = $('#total-notes'); if (el) el.textContent = `${notes.length} notes`; }
function toast(msg, type = 'success') {
  const el = document.createElement('div'); el.className = `toast ${type}`; el.textContent = msg;
  $('#toast-container').appendChild(el); setTimeout(() => el.remove(), 3000);
}
function stripHtml(html) { const d = document.createElement('div'); d.innerHTML = html; return d.textContent || ''; }

// ── Keyboard shortcuts ────────────────────────────────────
function bindEvents() {
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { closeGlobalClaude(); closeSettings(); closeSidebar(); }
    if ((e.metaKey || e.ctrlKey) && e.key === 'n') { e.preventDefault(); createNote(); }
    if ((e.metaKey || e.ctrlKey) && e.key === 'e') { e.preventDefault(); exportAllNotes(); }
    if ((e.metaKey || e.ctrlKey) && e.key === 'f') { e.preventDefault(); $('#search-input')?.focus(); }
  });
}

document.addEventListener('DOMContentLoaded', init);
