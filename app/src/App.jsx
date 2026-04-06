import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { MantineProvider, Button, ActionIcon, Modal, Group, Text } from '@mantine/core';
import { NoteEditor, blocksToText, blocksToMarkdown } from './Editor.jsx';
import { initDB, getAllNotes, saveNote, deleteNote as dbDelete } from './db.js';
import { checkHealth, transform, analyze } from './claude.js';
import { markdownToBlocks, txt } from './markdown.js';

export function App() {
  const [notes, setNotes] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [search, setSearch] = useState('');
  const [tagFilter, setTagFilter] = useState(null);
  const [theme, setTheme] = useState(localStorage.getItem('nv-theme') || 'dark');
  const [connected, setConnected] = useState(false);
  const [claudePanel, setClaudePanel] = useState(false);
  const [claudeScope, setClaudeScope] = useState('all');
  const [claudeTag, setClaudeTag] = useState(null);
  const [claudeResult, setClaudeResult] = useState('');
  const [claudeLoading, setClaudeLoading] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [versions, setVersions] = useState([]);
  const [claudeEditLoading, setClaudeEditLoading] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [updateStatus, setUpdateStatus] = useState(null); // null | 'downloading' | 'ready'
  const saveTimer = useRef(null);

  const activeNote = notes.find(n => n.id === activeId) || null;

  // Init
  useEffect(() => {
    (async () => {
      await initDB();
      const all = await getAllNotes();
      setNotes(all);
    })();
  }, []);

  // Theme
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('nv-theme', theme);
  }, [theme]);

  // Connector health check
  useEffect(() => {
    const check = () => checkHealth().then(setConnected);
    check();
    const iv = setInterval(check, 10000);
    return () => clearInterval(iv);
  }, []);

  // Auto-update listener (Electron only)
  useEffect(() => {
    if (window.electronAPI?.onUpdateStatus) {
      window.electronAPI.onUpdateStatus(setUpdateStatus);
    }
  }, []);

  // Tags
  const allTags = [...new Set(notes.flatMap(n => n.tags || []))].sort();

  // Filtered notes
  const filtered = notes.filter(n => {
    if (tagFilter && !(n.tags || []).includes(tagFilter)) return false;
    if (search) {
      const q = search.toLowerCase();
      return n.title.toLowerCase().includes(q) || blocksToText(n.body).toLowerCase().includes(q);
    }
    return true;
  });

  // Save
  const doSave = useCallback(async (note) => {
    note.updatedAt = Date.now();
    await saveNote(note);
    setNotes(prev => prev.map(n => n.id === note.id ? { ...note } : n));
  }, []);

  const onContentChange = useCallback((bodyJson) => {
    if (!activeNote) return;
    setNotes(prev => prev.map(n => n.id === activeNote.id ? { ...n, body: bodyJson } : n));
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      saveNote({ ...activeNote, body: bodyJson, updatedAt: Date.now() });
    }, 600);
  }, [activeNote]);

  const onTitleChange = useCallback((val) => {
    if (!activeNote) return;
    setNotes(prev => prev.map(n => n.id === activeNote.id ? { ...n, title: val } : n));
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      saveNote({ ...activeNote, title: val, updatedAt: Date.now() });
    }, 400);
  }, [activeNote]);

  // Create
  const createNote = async () => {
    const note = { id: crypto.randomUUID(), title: '', body: '[]', tags: [], createdAt: Date.now(), updatedAt: Date.now() };
    await saveNote(note);
    setNotes(prev => [note, ...prev]);
    setActiveId(note.id);
    setVersions([]);
    setSidebarOpen(false);
  };

  // Delete
  const handleDelete = () => {
    if (!activeNote) return;
    setDeleteConfirm(true);
  };
  const confirmDelete = async () => {
    if (!activeNote) return;
    await dbDelete(activeNote.id);
    setNotes(prev => prev.filter(n => n.id !== activeNote.id));
    setActiveId(null);
    setVersions([]);
    setDeleteConfirm(false);
  };

  // Select
  const selectNote = (id) => {
    setActiveId(id);
    setVersions([]);
    setSidebarOpen(false);
  };

  // Tags
  const addTag = (tag) => {
    if (!activeNote || !tag || (activeNote.tags || []).includes(tag)) return;
    activeNote.tags = [...(activeNote.tags || []), tag];
    doSave(activeNote);
  };
  const removeTag = (tag) => {
    if (!activeNote) return;
    activeNote.tags = (activeNote.tags || []).filter(t => t !== tag);
    doSave(activeNote);
  };

  // Claude: edit note
  const sendClaudeEdit = async (prompt, files) => {
    if ((!prompt && (!files || files.length === 0)) || !activeNote) return;
    const imageFiles = files ? files.filter(f => f.type.startsWith('image/')) : [];
    const otherFiles = files ? files.filter(f => !f.type.startsWith('image/')) : [];
    if (!connected && imageFiles.length === 0) return;
    setClaudeEditLoading(true);
    try {
      // Save version for undo
      setVersions(prev => [...prev, { body: activeNote.body, timestamp: Date.now(), prompt: prompt || 'Add images' }].slice(-30));

      // Parse existing blocks (native BlockNote format — no lossy conversion)
      let existingBlocks = [];
      try {
        const parsed = typeof activeNote.body === 'string' ? JSON.parse(activeNote.body) : activeNote.body;
        existingBlocks = Array.isArray(parsed) ? parsed : [];
      } catch { existingBlocks = []; }

      let finalBlocks;

      if (imageFiles.length > 0) {
        // ── IMAGE FLOW: preserve existing blocks, append image + analysis ──
        const imageBlocks = imageFiles.map(f => ({
          type: 'image',
          props: {
            url: `data:${f.type};base64,${f.data}`,
            caption: '',
            previewWidth: 512,
            name: f.name,
            showPreview: true,
            textAlignment: 'left',
            backgroundColor: 'default'
          },
          children: []
        }));

        // Ask Claude to analyze images only (don't send full note — avoids lossy round-trip)
        let analysisBlocks = [];
        if (connected) {
          const result = await transform(prompt || '', '', files);
          if (result) {
            analysisBlocks = markdownToBlocks(result);
          }
        }

        finalBlocks = [...existingBlocks, ...imageBlocks, ...analysisBlocks];
      } else {
        // ── TEXT EDIT FLOW: Claude rewrites the note ──
        // Preserve image/file blocks — markdown round-trip can't carry them
        const FILE_TYPES = ['image', 'video', 'audio', 'file'];
        const preservedBlocks = existingBlocks.filter(b => FILE_TYPES.includes(b.type));

        if (connected) {
          const md = blocksToMarkdown(activeNote.body);
          const result = await transform(prompt || '', md, otherFiles.length > 0 ? otherFiles : null);
          if (result) {
            finalBlocks = [...markdownToBlocks(result), ...preservedBlocks];
          } else {
            finalBlocks = existingBlocks;
          }
        } else {
          finalBlocks = existingBlocks;
        }
      }

      activeNote.body = JSON.stringify(finalBlocks);
      activeNote.updatedAt = Date.now();
      await saveNote(activeNote);
      setNotes(prev => prev.map(n => n.id === activeNote.id ? { ...activeNote } : n));
      setActiveId(null);
      setTimeout(() => setActiveId(activeNote.id), 50);
    } catch (e) { alert('AI error: ' + e.message); }
    setClaudeEditLoading(false);
  };

  // Undo
  const undo = async () => {
    if (versions.length === 0 || !activeNote) return;
    const prev = versions[versions.length - 1];
    activeNote.body = prev.body;
    activeNote.updatedAt = Date.now();
    await saveNote(activeNote);
    setVersions(v => v.slice(0, -1));
    setNotes(prev2 => prev2.map(n => n.id === activeNote.id ? { ...activeNote } : n));
    setActiveId(null);
    setTimeout(() => setActiveId(activeNote.id), 50);
  };

  // Claude: global analyze
  const sendGlobalClaude = async (prompt) => {
    if (!prompt || !connected) return;
    setClaudeLoading(true);
    setClaudeResult('');
    try {
      let targets;
      if (claudeScope === 'current' && activeNote) targets = [activeNote];
      else if (claudeScope === 'tag' && claudeTag) targets = notes.filter(n => (n.tags || []).includes(claudeTag));
      else targets = notes;
      const data = targets.map(n => ({ title: n.title, body: blocksToText(n.body), tags: n.tags }));
      const result = await analyze(prompt, data);
      setClaudeResult(result);
    } catch (e) { setClaudeResult('Error: ' + e.message); }
    setClaudeLoading(false);
  };

  // Import/Export
  const exportAll = () => {
    const blob = new Blob([JSON.stringify(notes, null, 2)], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'notevault.json'; a.click();
  };
  const importNotes = () => {
    const input = document.createElement('input'); input.type = 'file'; input.accept = '.json';
    input.onchange = async (e) => {
      try {
        const data = JSON.parse(await e.target.files[0].text());
        const arr = Array.isArray(data) ? data : [data];
        for (const n of arr) if (n.id) await saveNote(n);
        setNotes(await getAllNotes());
      } catch { alert('Invalid file'); }
    };
    input.click();
  };

  const formatDate = (ts) => {
    if (!ts) return '';
    const d = Date.now() - ts;
    if (d < 60000) return 'Now';
    if (d < 3600000) return `${Math.floor(d / 60000)}m`;
    if (d < 86400000) return `${Math.floor(d / 3600000)}h`;
    return new Date(ts).toLocaleDateString();
  };

  return (
    <MantineProvider forceColorScheme={theme}>
    <div className="app" data-theme={theme}>
      {/* Header */}
      <header className="header">
        <div className="header-left">
          <ActionIcon variant="subtle" color="gray" className="hamburger" onClick={() => setSidebarOpen(!sidebarOpen)}>
            <MenuIcon />
          </ActionIcon>
          <div className="logo">Notus</div>
        </div>
        <div className="header-actions">
          <Button variant="filled" color="#D97757" size="compact-sm" onClick={() => setClaudePanel(true)}>
            <span className="btn-label">Ask AI</span>
          </Button>
          <div className="header-divider" />
          <ActionIcon variant="subtle" color="gray" onClick={() => setTheme(t => t === 'dark' ? 'light' : 'dark')}>
            {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
          </ActionIcon>
        </div>
      </header>

      {/* Sidebar overlay */}
      {sidebarOpen && <div className="sidebar-overlay" onClick={() => setSidebarOpen(false)} />}

      {/* Sidebar */}
      <aside className={`sidebar ${sidebarOpen ? 'mobile-open' : ''}`}>
        <div className="sidebar-header">
          <Button variant="default" fullWidth leftSection={<PlusIcon />} onClick={createNote}>New Note</Button>
          <div className="search-box">
            <SearchIcon />
            <input placeholder="Search..." value={search} onChange={e => setSearch(e.target.value)} />
          </div>
          {allTags.length > 0 && (
            <div className="tags-filter">
              {allTags.map(t => (
                <span key={t} className={`tag-pill ${tagFilter === t ? 'active' : ''}`} onClick={() => setTagFilter(f => f === t ? null : t)}>{t}</span>
              ))}
            </div>
          )}
        </div>
        <div className="notes-list">
          {filtered.map(n => (
            <div key={n.id} className={`note-item ${n.id === activeId ? 'active' : ''}`} onClick={() => selectNote(n.id)}>
              <div className="note-item-title">{n.title || 'Untitled'}</div>
              <div className="note-item-preview">{blocksToText(n.body).slice(0, 80)}</div>
              <div className="note-item-meta">
                <span>{formatDate(n.updatedAt)}</span>
                <div className="note-item-tags">{(n.tags || []).slice(0, 2).map(t => <span key={t} className="note-item-tag">{t}</span>)}</div>
              </div>
            </div>
          ))}
          {filtered.length === 0 && <div className="empty-state"><p>{search ? 'No results' : 'No notes yet'}</p></div>}
        </div>
      </aside>

      {/* Editor */}
      <main className="editor-area">
        {activeNote ? (
          <>
            <div className="editor-topbar">
              <input className="note-title-input" value={activeNote.title} onChange={e => onTitleChange(e.target.value)} placeholder="Untitled" />
              <ActionIcon variant="subtle" color="red" onClick={handleDelete}><TrashIcon /></ActionIcon>
            </div>
            <div className="tags-bar">
              {(activeNote.tags || []).map(t => (
                <span key={t} className="current-tag">{t} <span className="remove-tag" onClick={() => removeTag(t)}>&times;</span></span>
              ))}
              <input className="tags-input" placeholder="Add tag..." onKeyDown={e => { if (e.key === 'Enter') { addTag(e.target.value.trim().toLowerCase()); e.target.value = ''; } }} />
            </div>
            {versions.length > 0 && (
              <div className="undo-bar">
                <span>AI edited ({versions.length} version{versions.length > 1 ? 's' : ''})</span>
                <Button variant="subtle" color="#D97757" size="compact-xs" onClick={undo}>Undo</Button>
              </div>
            )}
            <div className="editor-content">
              <NoteEditor note={activeNote} onContentChange={onContentChange} theme={theme} />
            </div>
            <ClaudeBar loading={claudeEditLoading} connected={connected} onSend={sendClaudeEdit} />
          </>
        ) : (
          <div className="empty-state">
            <EditIcon />
            <p>Select a note or create a new one</p>
          </div>
        )}
      </main>

      {/* Status bar */}
      <footer className="status-bar">
        <span>{notes.length} notes</span>
        <div className="status-right">
          {updateStatus === 'ready' && (
            <Button size="compact-xs" color="blue" onClick={() => window.electronAPI?.installUpdate()}>Update available — restart</Button>
          )}
          {updateStatus === 'downloading' && (
            <span className="update-downloading">Downloading update...</span>
          )}
          <div className="connector-status">
            <span className={`status-dot ${connected ? 'connected' : ''}`} />
            <span>{connected ? 'AI connected' : 'Connector offline'}</span>
          </div>
        </div>
      </footer>

      {/* Delete confirmation modal */}
      <Modal opened={deleteConfirm} onClose={() => setDeleteConfirm(false)} centered withCloseButton={false} radius="lg" size="sm" overlayProps={{ backgroundOpacity: 0.5, blur: 4 }}>
        <div style={{ textAlign: 'center', padding: '8px 0' }}>
          <div style={{ marginBottom: 16, color: 'var(--danger)' }}><TrashIcon /></div>
          <Text fw={600} size="lg" mb={8}>Delete note</Text>
          <Text size="sm" c="dimmed" mb={24}>This note will be permanently deleted. This action cannot be undone.</Text>
          <Group grow>
            <Button variant="default" onClick={() => setDeleteConfirm(false)}>Cancel</Button>
            <Button color="red" onClick={confirmDelete}>Delete</Button>
          </Group>
        </div>
      </Modal>

      {/* Claude panel */}
      {claudePanel && (
        <ClaudePanel
          scope={claudeScope}
          setScope={setClaudeScope}
          tags={allTags}
          selectedTag={claudeTag}
          onSelectTag={setClaudeTag}
          loading={claudeLoading}
          result={claudeResult}
          onSend={sendGlobalClaude}
          onClose={() => setClaudePanel(false)}
        />
      )}
    </div>
    </MantineProvider>
  );
}

// ── Claude prompt bar ─────────────────────────
function ClaudeBar({ loading, connected, onSend }) {
  const [prompt, setPrompt] = useState('');
  const [files, setFiles] = useState([]);
  const [dragOver, setDragOver] = useState(false);
  const dragCounterRef = useRef(0);
  const fileInputRef = useRef(null);

  const ALLOWED_TYPES = ['image/png','image/jpeg','image/webp','image/gif','application/pdf','text/plain','text/markdown','text/csv','application/json'];
  const MAX_FILES = 5;
  const MAX_FILE_SIZE = 10 * 1024 * 1024;
  const MAX_TOTAL_SIZE = 14 * 1024 * 1024; // ~10MB after base64 overhead within 20MB server limit

  const addFiles = useCallback((fileList) => {
    setFiles(prev => {
      const currentSize = prev.reduce((s, f) => s + f.size, 0);
      let totalSize = currentSize;
      const newFiles = [];
      for (const f of Array.from(fileList)) {
        if (prev.length + newFiles.length >= MAX_FILES) { alert(`Max ${MAX_FILES} files at a time`); break; }
        if (f.size > MAX_FILE_SIZE) { alert(`${f.name} is too large (max 10MB)`); continue; }
        if (!ALLOWED_TYPES.includes(f.type) && !f.name.match(/\.(txt|md|csv|json|pdf|png|jpe?g|webp|gif)$/i)) { alert(`${f.name}: unsupported file type`); continue; }
        totalSize += f.size;
        if (totalSize > MAX_TOTAL_SIZE) { alert('Total file size too large'); break; }
        newFiles.push({ file: f, name: f.name, type: f.type, size: f.size, id: `${f.name}-${f.size}-${Date.now()}`,
          preview: f.type.startsWith('image/') ? URL.createObjectURL(f) : null });
      }
      return [...prev, ...newFiles];
    });
  }, []);

  const removeFile = (idx) => {
    setFiles(prev => {
      if (prev[idx].preview) URL.revokeObjectURL(prev[idx].preview);
      return prev.filter((_, i) => i !== idx);
    });
  };

  const handleSend = async () => {
    if (!prompt.trim() && files.length === 0) return;
    // Convert files to base64
    let fileData = null;
    if (files.length > 0) {
      fileData = await Promise.all(files.map(f => new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve({ name: f.name, type: f.type, data: reader.result.split(',')[1] });
        reader.onerror = reject;
        reader.readAsDataURL(f.file);
      })));
    }
    onSend(prompt.trim(), fileData);
    setPrompt('');
    files.forEach(f => { if (f.preview) URL.revokeObjectURL(f.preview); });
    setFiles([]);
  };

  const handlePaste = (e) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const imageFiles = [];
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (file) imageFiles.push(file);
      }
    }
    if (imageFiles.length > 0) { e.preventDefault(); addFiles(imageFiles); }
  };

  const handleDrop = (e) => {
    e.preventDefault();
    setDragOver(false);
    if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
  };

  const canSend = !loading && ((connected && (prompt.trim() || files.length > 0)) || files.some(f => f.type.startsWith('image/')));

  return (
    <div
      className={`claude-bar ${!connected ? 'offline' : ''} ${dragOver ? 'drag-over' : ''}`}
      onDragEnter={e => { e.preventDefault(); dragCounterRef.current++; setDragOver(true); }}
      onDragOver={e => e.preventDefault()}
      onDragLeave={() => { dragCounterRef.current--; if (dragCounterRef.current === 0) setDragOver(false); }}
      onDrop={e => { dragCounterRef.current = 0; handleDrop(e); }}
    >
      {files.length > 0 && (
        <div className="claude-files">
          {files.map((f, i) => (
            <div key={f.id} className="file-chip">
              {f.preview ? <img src={f.preview} className="file-thumb" alt="" /> : <FileIcon />}
              <span className="file-name">{f.name}</span>
              <span className="file-remove" onClick={() => removeFile(i)}>&times;</span>
            </div>
          ))}
        </div>
      )}
      <input
        value={prompt}
        onChange={e => setPrompt(e.target.value)}
        onKeyDown={e => e.key === 'Enter' && canSend && handleSend()}
        onPaste={handlePaste}
        placeholder={loading ? 'AI is editing...' : files.length > 0 ? 'Describe what to do with the file(s)...' : 'Ask AI to edit this note...'}
        disabled={loading || !connected}
      />
      <input ref={fileInputRef} type="file" hidden multiple accept="image/*,.pdf,.txt,.md,.csv,.json" onChange={e => { addFiles(e.target.files); e.target.value = ''; }} />
      <ActionIcon variant="subtle" color="gray" onClick={() => fileInputRef.current?.click()} disabled={loading || !connected} title="Attach file">
        <AttachIcon />
      </ActionIcon>
      <Button variant="filled" color="#D97757" h={36} px={20} onClick={handleSend} disabled={!canSend}>
        {loading ? '...' : 'Send'}
      </Button>
    </div>
  );
}

// ── Claude global panel ───────────────────────
function ClaudePanel({ scope, setScope, tags, selectedTag, onSelectTag, loading, result, onSend, onClose }) {
  const [prompt, setPrompt] = useState('');
  return (
    <aside className="claude-panel open">
      <div className="claude-panel-header">
        <h3>Ask AI</h3>
        <ActionIcon variant="subtle" color="gray" onClick={onClose}><XIcon /></ActionIcon>
      </div>
      <div className="claude-panel-scope">
        <label>Scope</label>
        <Button.Group>
          {['all', 'current', 'tag'].map(s => (
            <Button key={s} variant={scope === s ? 'filled' : 'default'} color={scope === s ? '#D97757' : 'gray'} size="compact-sm" onClick={() => setScope(s)}>
              {s === 'all' ? 'All notes' : s === 'current' ? 'Current' : 'By tag'}
            </Button>
          ))}
        </Button.Group>
        {scope === 'tag' && tags.length > 0 && (
          <div className="scope-tags">
            {tags.map(t => (
              <span key={t} className={`tag-pill ${selectedTag === t ? 'active' : ''}`} onClick={() => onSelectTag(selectedTag === t ? null : t)}>{t}</span>
            ))}
          </div>
        )}
        {scope === 'tag' && tags.length === 0 && (
          <Text size="xs" c="dimmed" mt={8}>No tags yet</Text>
        )}
      </div>
      <div className="claude-panel-prompt">
        <textarea value={prompt} onChange={e => setPrompt(e.target.value)} placeholder="Ask about your notes..." rows={3} />
        <Button variant="filled" color="#D97757" fullWidth onClick={() => { onSend(prompt.trim()); setPrompt(''); }} disabled={loading}>
          {loading ? 'Analyzing...' : 'Send'}
        </Button>
      </div>
      <div className="claude-panel-result">
        {result ? <div className="claude-result" dangerouslySetInnerHTML={{ __html: formatResult(result) }} /> : <div className="empty-state"><p>Ask Claude something</p></div>}
      </div>
    </aside>
  );
}

function formatResult(text) {
  let h = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  h = h.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  h = h.replace(/^### (.+)$/gm, '<h4>$1</h4>');
  h = h.replace(/^## (.+)$/gm, '<h3>$1</h3>');
  h = h.replace(/^# (.+)$/gm, '<h2>$1</h2>');
  h = h.replace(/^[\-\*] (.+)$/gm, '<li>$1</li>');
  h = h.replace(/((<li>.*<\/li>\s*)+)/g, '<ul>$1</ul>');
  h = h.replace(/\n\n+/g, '</p><p>');
  h = h.replace(/\n/g, '<br>');
  return '<p>' + h + '</p>';
}

// markdownToBlocks and txt imported from ./markdown.js

// ── Icons ─────────────────────────────────────
const ClaudeIcon = () => <svg className="claude-icon" viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M15.58 11.17l-3.07-7.64a.553.553 0 00-1.02 0L8.42 11.17a.553.553 0 01-.29.3l-7.64 3.07a.553.553 0 000 1.02l7.64 3.07c.13.05.24.16.3.3l3.06 7.64a.553.553 0 001.02 0l3.07-7.65c.05-.13.16-.24.3-.3l7.64-3.06a.553.553 0 000-1.02l-7.65-3.07a.553.553 0 01-.3-.3z" /></svg>;
const AgiIcon = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" width="18" height="18"><path d="M12 2a4 4 0 014 4c0 1.1-.9 2-2 2h-4a2 2 0 01-2-2 4 4 0 014-4z" /><path d="M9 8v2M15 8v2" /><circle cx="12" cy="14" r="4" /><path d="M12 18v4M8 14H4M20 14h-4M7 11l-2-2M17 11l2-2" /></svg>;
const MenuIcon = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16"><path d="M3 12h18M3 6h18M3 18h18" /></svg>;
const LockIcon = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16"><rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0110 0v4" /></svg>;
const PlusIcon = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16"><path d="M12 5v14M5 12h14" /></svg>;
const SearchIcon = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="15" height="15"><circle cx="11" cy="11" r="8" /><path d="M21 21l-4.35-4.35" /></svg>;
const TrashIcon = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16"><path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" /></svg>;
const UploadIcon = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M17 8l-5-5-5 5M12 3v12" /></svg>;
const DownloadIcon = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3" /></svg>;
const SunIcon = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16"><circle cx="12" cy="12" r="5" /><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" /></svg>;
const MoonIcon = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16"><path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z" /></svg>;
const XIcon = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16"><path d="M18 6L6 18M6 6l12 12" /></svg>;
const EditIcon = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" width="44" height="44"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" /><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" /></svg>;
const AttachIcon = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16"><path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48" /></svg>;
const FileIcon = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" /><path d="M14 2v6h6" /></svg>;
