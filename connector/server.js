#!/usr/bin/env node

// Notus Connector - Local bridge between Notus PWA and Claude Code
// All data stays on your machine. Nothing is sent to external servers.

const http = require('http');
const { execSync, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

// ── CLI Argument Parsing ─────────────────────────────────
const VERSION = require('./package.json').version;

function parseArgs(argv) {
  const args = { port: 9471, verbose: false, help: false, version: false };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else if (arg === '--version' || arg === '-v') {
      args.version = true;
    } else if (arg === '--verbose') {
      args.verbose = true;
    } else if (arg === '--port' && argv[i + 1]) {
      args.port = parseInt(argv[++i], 10);
    } else if (arg.startsWith('--port=')) {
      args.port = parseInt(arg.split('=')[1], 10);
    }
  }
  return args;
}

const ARGS = parseArgs(process.argv);

if (ARGS.help) {
  console.log(`
Notus Connector v${VERSION}
Local bridge between Notus PWA and Claude Code CLI.

Usage:
  notus-connector [options]

Options:
  --port <number>   Port to listen on (default: 9471)
  --port=<number>   Same as above, alternate syntax
  --verbose         Enable detailed request logging
  --version, -v     Show version number
  --help, -h        Show this help message

Endpoints:
  GET  /health        Health check (is Claude available?)
  GET  /status        Detailed server status and diagnostics
  GET  /history       Get past analysis history
  POST /analyze       Analyze a single note
  POST /analyze-all   Analyze multiple notes at once
  POST /backup        Backup notes to local disk

Examples:
  notus-connector
  notus-connector --port=8080 --verbose
`);
  process.exit(0);
}

if (ARGS.version) {
  console.log(VERSION);
  process.exit(0);
}

const PORT = ARGS.port;
const VERBOSE = ARGS.verbose;
const DATA_DIR = path.join(os.homedir(), '.notus');

if (isNaN(PORT) || PORT < 1 || PORT > 65535) {
  console.error(`Error: Invalid port number. Must be between 1 and 65535.`);
  process.exit(1);
}

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// ── Logging ──────────────────────────────────────────────
function log(msg) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] ${msg}`);
}

function verbose(msg) {
  if (VERBOSE) log(`  ${msg}`);
}

// ── Rate Limiting (in-memory) ────────────────────────────
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute
const RATE_LIMIT_MAX = 30; // max requests per window per IP
const rateLimitMap = new Map();

function checkRateLimit(ip) {
  const now = Date.now();
  let entry = rateLimitMap.get(ip);
  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    entry = { windowStart: now, count: 0 };
    rateLimitMap.set(ip, entry);
  }
  entry.count++;
  return {
    allowed: entry.count <= RATE_LIMIT_MAX,
    remaining: Math.max(0, RATE_LIMIT_MAX - entry.count),
    resetMs: entry.windowStart + RATE_LIMIT_WINDOW_MS - now
  };
}

// Clean up stale rate limit entries every 5 minutes
const rateLimitCleanupInterval = setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimitMap) {
    if (now - entry.windowStart > RATE_LIMIT_WINDOW_MS * 2) {
      rateLimitMap.delete(ip);
    }
  }
}, 5 * 60 * 1000);
rateLimitCleanupInterval.unref();

// ── Server Stats ─────────────────────────────────────────
const stats = {
  startedAt: null,
  requestCount: 0,
  analysisCount: 0,
  errorCount: 0,
  lastRequestAt: null,
};

// ── Claude Code Bridge ───────────────────────────────────
const CLAUDE_TIMEOUT_MS = 180000; // 3 minutes

let cachedClaudePath = undefined; // undefined = not checked yet

function findClaudeCode() {
  if (cachedClaudePath !== undefined) return cachedClaudePath;
  try {
    const result = execSync('which claude', {
      encoding: 'utf-8',
      timeout: 5000
    }).trim();
    cachedClaudePath = result || null;
  } catch {
    cachedClaudePath = null;
  }
  return cachedClaudePath;
}

// Allow re-checking if Claude wasn't found (user might install it later)
function findClaudeCodeFresh() {
  cachedClaudePath = undefined;
  return findClaudeCode();
}

async function askClaude(prompt, options = {}) {
  const claudePath = findClaudeCodeFresh();
  if (!claudePath) {
    throw new Error(
      'Claude Code CLI not found. Install it with: npm install -g @anthropic-ai/claude-code\n' +
      'Then verify with: claude --version'
    );
  }

  const MAX_PROMPT_LENGTH = 512 * 1024;
  if (prompt.length > MAX_PROMPT_LENGTH) {
    throw new Error(
      `Prompt too large (${(prompt.length / 1024).toFixed(0)}KB). ` +
      `Maximum is ${MAX_PROMPT_LENGTH / 1024}KB. Try sending fewer or shorter notes.`
    );
  }

  return new Promise((resolve, reject) => {
    verbose('Sending to Claude Code...');

    const args = ['--print'];
    // Grant access to additional directories (e.g. temp file uploads)
    if (options.addDirs) {
      for (const dir of options.addDirs) {
        args.push('--add-dir', dir);
      }
    }

    const child = spawn(claudePath, args, {
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe']
    });

    child.stdin.write(prompt);
    child.stdin.end();

    let stdout = '';
    let stderr = '';
    let killed = false;

    // Enforce timeout -- spawn's timeout option does not reliably kill
    const timer = setTimeout(() => {
      killed = true;
      child.kill('SIGTERM');
      // Force kill after 5s if SIGTERM didn't work
      setTimeout(() => {
        if (!child.killed) child.kill('SIGKILL');
      }, 5000).unref();
      reject(new Error(
        `Claude Code timed out after ${CLAUDE_TIMEOUT_MS / 1000}s. ` +
        'The prompt may be too large or Claude may be unresponsive.'
      ));
    }, CLAUDE_TIMEOUT_MS);
    timer.unref();

    child.stdout.on('data', (data) => { stdout += data.toString(); });
    child.stderr.on('data', (data) => { stderr += data.toString(); });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (killed) return; // already rejected
      if (code !== 0) {
        verbose(`Claude Code exited with code ${code}`);
        reject(new Error(stderr.trim() || `Claude Code exited with code ${code}`));
      } else {
        resolve(stdout.trim());
      }
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      if (killed) return;
      reject(new Error(`Failed to run Claude Code: ${err.message}`));
    });
  });
}

// ── Analysis Prompts ─────────────────────────────────────
const VALID_ACTIONS = ['summarize', 'insights', 'actions', 'improve', 'themes', 'connections', 'custom'];

function buildPrompt(action, noteData) {
  const noteText = typeof noteData === 'string'
    ? noteData
    : `Title: ${noteData.title || 'Untitled'}\nTags: ${(noteData.tags || []).join(', ')}\n\n${noteData.body || ''}`;

  const prompts = {
    summarize: `Summarize the following personal note concisely. Highlight the key points and main ideas:\n\n${noteText}`,
    insights: `Analyze this personal note and extract meaningful insights. What patterns, important ideas, or non-obvious observations can you identify?\n\n${noteText}`,
    actions: `Review this personal note and extract any action items, tasks, or things that need follow-up. List them clearly:\n\n${noteText}`,
    improve: `Review this personal note and suggest improvements for clarity, organization, and completeness. Be constructive and specific:\n\n${noteText}`,
    themes: `Analyze these personal notes and identify recurring themes, topics, and patterns across all of them:\n\n${noteText}`,
    connections: `Analyze these personal notes and find connections, relationships, and links between different notes. What ideas connect across notes?\n\n${noteText}`,
    custom: noteText
  };

  return prompts[action] || prompts.summarize;
}

function formatNotesForBulk(notes) {
  return notes.map((n, i) =>
    `--- Note ${i + 1}: ${n.title || 'Untitled'} ---\nTags: ${(n.tags || []).join(', ')}\n${n.body || ''}\n`
  ).join('\n');
}

// ── Request Body Reader with Size Limit ──────────────────
const MAX_BODY_SIZE = 20 * 1024 * 1024; // 20 MB (for file uploads with base64)

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;

    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_SIZE) {
        req.destroy();
        reject(new Error(`Request body too large (max ${MAX_BODY_SIZE / 1024}KB)`));
        return;
      }
      body += chunk;
    });

    req.on('end', () => {
      if (!body.length) {
        reject(new Error('Request body is empty'));
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error('Invalid JSON in request body'));
      }
    });

    req.on('error', (err) => reject(new Error(`Request read error: ${err.message}`)));
  });
}

// ── Payload Validation ───────────────────────────────────
function validateAnalyzePayload(body) {
  const errors = [];
  if (!body.action || typeof body.action !== 'string') {
    errors.push('Missing or invalid "action" field (string required)');
  } else if (!VALID_ACTIONS.includes(body.action)) {
    errors.push(`Invalid action "${body.action}". Valid actions: ${VALID_ACTIONS.join(', ')}`);
  }
  if (body.action === 'custom') {
    if (!body.prompt || typeof body.prompt !== 'string' || !body.prompt.trim()) {
      errors.push('Custom action requires a non-empty "prompt" field');
    }
  } else {
    if (!body.note || typeof body.note !== 'object') {
      errors.push('Missing or invalid "note" field (object required)');
    } else if (!body.note.body && !body.note.title) {
      errors.push('Note must have at least a "title" or "body" field');
    }
  }
  return errors;
}

function validateAnalyzeAllPayload(body) {
  const errors = [];
  if (!body.action || typeof body.action !== 'string') {
    errors.push('Missing or invalid "action" field (string required)');
  } else if (!VALID_ACTIONS.includes(body.action)) {
    errors.push(`Invalid action "${body.action}". Valid actions: ${VALID_ACTIONS.join(', ')}`);
  }
  if (body.action === 'custom') {
    if (!body.prompt || typeof body.prompt !== 'string' || !body.prompt.trim()) {
      errors.push('Custom action requires a non-empty "prompt" field');
    }
  }
  if (!Array.isArray(body.notes)) {
    errors.push('Missing or invalid "notes" field (array required)');
  } else if (body.notes.length === 0) {
    errors.push('"notes" array must not be empty');
  }
  return errors;
}

function validateBackupPayload(body) {
  if (!Array.isArray(body.notes)) {
    return ['Missing or invalid "notes" field (array required)'];
  }
  return [];
}

// ── HTTP Server ──────────────────────────────────────────
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json'
};

function sendJSON(res, statusCode, data) {
  res.writeHead(statusCode, CORS_HEADERS);
  res.end(JSON.stringify(data));
}

const server = http.createServer(async (req, res) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }

  const clientIP = req.socket.remoteAddress || 'unknown';

  // Rate limiting (skip for health/status checks)
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const isReadOnly = req.method === 'GET' && ['/health', '/status'].includes(url.pathname);

  if (!isReadOnly) {
    const rateResult = checkRateLimit(clientIP);
    res.setHeader('X-RateLimit-Remaining', rateResult.remaining);
    res.setHeader('X-RateLimit-Reset', Math.ceil(rateResult.resetMs / 1000));
    if (!rateResult.allowed) {
      verbose(`Rate limited: ${clientIP}`);
      sendJSON(res, 429, {
        error: 'Too many requests',
        retryAfterSeconds: Math.ceil(rateResult.resetMs / 1000)
      });
      return;
    }
  }

  stats.requestCount++;
  stats.lastRequestAt = Date.now();
  verbose(`${req.method} ${url.pathname} from ${clientIP}`);

  try {
    // Health check
    if (url.pathname === '/health' && req.method === 'GET') {
      const claudePath = findClaudeCode();
      sendJSON(res, 200, {
        status: 'ok',
        version: VERSION,
        claude: !!claudePath,
        claudePath: claudePath || null
      });
      return;
    }

    // Detailed status
    if (url.pathname === '/status' && req.method === 'GET') {
      const claudePath = findClaudeCodeFresh();
      const uptimeSeconds = stats.startedAt ? Math.floor((Date.now() - stats.startedAt) / 1000) : 0;
      const historyCount = loadHistory().length;

      sendJSON(res, 200, {
        status: 'ok',
        version: VERSION,
        uptime: {
          seconds: uptimeSeconds,
          human: formatUptime(uptimeSeconds)
        },
        claude: {
          available: !!claudePath,
          path: claudePath || null,
          timeoutSeconds: CLAUDE_TIMEOUT_MS / 1000
        },
        server: {
          port: PORT,
          verbose: VERBOSE,
          dataDir: DATA_DIR,
          startedAt: stats.startedAt ? new Date(stats.startedAt).toISOString() : null,
        },
        stats: {
          totalRequests: stats.requestCount,
          totalAnalyses: stats.analysisCount,
          totalErrors: stats.errorCount,
          lastRequestAt: stats.lastRequestAt ? new Date(stats.lastRequestAt).toISOString() : null,
          historyEntries: historyCount
        },
        limits: {
          maxBodySizeKB: MAX_BODY_SIZE / 1024,
          rateLimitPerMinute: RATE_LIMIT_MAX,
          validActions: VALID_ACTIONS
        }
      });
      return;
    }

    // Analyze single note
    if (url.pathname === '/analyze' && req.method === 'POST') {
      const body = await readBody(req);
      const errors = validateAnalyzePayload(body);
      if (errors.length > 0) {
        sendJSON(res, 400, { error: 'Validation failed', details: errors });
        return;
      }

      const { action, note, prompt: customPrompt } = body;
      const noteTitle = note?.title || customPrompt?.slice(0, 40) || 'Untitled';
      log(`Analyzing: "${noteTitle}" (action: ${action})`);

      let fullPrompt;
      if (action === 'custom') {
        // If note data was also provided alongside the custom prompt,
        // append it so Claude has context to work with.
        if (note && (note.title || note.body)) {
          const noteText = `Title: ${note.title || 'Untitled'}\nTags: ${(note.tags || []).join(', ')}\n\n${note.body || ''}`;
          fullPrompt = `${customPrompt}\n\n${noteText}`;
        } else {
          fullPrompt = customPrompt;
        }
      } else {
        fullPrompt = buildPrompt(action, note);
      }

      const result = await askClaude(fullPrompt);
      stats.analysisCount++;
      log(`Analysis complete for "${noteTitle}"`);

      saveAnalysis(action, noteTitle, result);
      sendJSON(res, 200, { result });
      return;
    }

    // Transform note content (Claude rewrites the note)
    if (url.pathname === '/transform' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body.prompt && (!body.files || body.files.length === 0)) {
        sendJSON(res, 400, { error: 'Missing "prompt" or "files" field' });
        return;
      }

      const hasFiles = body.files && Array.isArray(body.files) && body.files.length > 0;
      log(`Transforming note (prompt: "${(body.prompt || '').slice(0, 60)}..."${hasFiles ? `, ${body.files.length} file(s)` : ''})`);

      // Process attached files
      let fileContext = '';
      const tempFiles = [];

      const ALLOWED_TYPES = /^(image\/(png|jpeg|webp|gif)|application\/pdf|text\/(plain|markdown|csv)|application\/json)$/;

      if (hasFiles) {
        const uploadDir = path.join(os.tmpdir(), 'notus-uploads');
        if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

        for (const file of body.files.slice(0, 5)) {
          const safeName = path.basename(file.name).replace(/[^a-zA-Z0-9._-]/g, '_');
          const ext = path.extname(safeName) || '.bin';

          if (!ALLOWED_TYPES.test(file.type) && !['.txt','.md','.csv','.json','.pdf','.png','.jpg','.jpeg','.webp','.gif'].includes(ext.toLowerCase())) {
            log(`Rejected file type: ${file.type} / ${safeName}`);
            continue;
          }

          const isText = /^text\/|csv|json|markdown/.test(file.type) || ['.txt', '.md', '.csv', '.json'].includes(ext.toLowerCase());

          if (isText) {
            const content = Buffer.from(file.data, 'base64').toString('utf-8');
            fileContext += `\n--- Attached file: "${safeName}" ---\n${content}\n--- End of file ---\n`;
          } else {
            const tempPath = path.join(uploadDir, `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
            fs.writeFileSync(tempPath, Buffer.from(file.data, 'base64'));
            tempFiles.push(tempPath);
            fileContext += `\n--- Attached file: "${safeName}" (saved at ${tempPath}) ---\nPlease read this file using the Read tool to analyze its contents.\n--- End of file reference ---\n`;
          }
        }
      }

      // Build smart default prompt if no user prompt
      let userPrompt = body.prompt || '';
      if (!userPrompt && hasFiles) {
        const fileTypes = body.files.map(f => f.type);
        if (fileTypes.some(t => t.startsWith('image/'))) {
          userPrompt = 'Analyze the attached image(s) and add all relevant information, text, and data from them into the note.';
        } else if (fileTypes.some(t => t === 'application/pdf')) {
          userPrompt = 'Read the attached PDF and create a structured summary with key points in the note.';
        } else if (fileTypes.some(t => t.includes('csv'))) {
          userPrompt = 'Convert the attached CSV data into a formatted table in the note.';
        } else {
          userPrompt = 'Analyze the attached file(s) and incorporate the relevant information into the note.';
        }
      }

      const noteText = body.text || '';
      const fullPrompt = `You are a note editor. Transform/update the user's note based on their instruction and any attached files.

RULES:
- Return ONLY the final text. No explanations, no "Here is...", no commentary.
- Use markdown formatting: **bold**, *italic*, ~~strikethrough~~, # headers, - bullets, 1. numbered lists
- For tasks/checklists use: - [ ] unchecked item, - [x] checked item
- For tables use: | Column | Column | format with |---|---| separator
- If files are attached, extract and incorporate their content into the note.
- Keep existing note content unless told otherwise.

User instruction: ${userPrompt}
${fileContext}
${noteText ? `Current note content:\n${noteText}` : 'The note is currently empty.'}`;

      const uploadDir = path.join(os.tmpdir(), 'notus-uploads');
      let result;
      try {
        result = await askClaude(fullPrompt, {
          addDirs: tempFiles.length > 0 ? [uploadDir] : undefined
        });
      } finally {
        // Clean up temp files even on error
        for (const f of tempFiles) {
          try { fs.unlinkSync(f); } catch {}
        }
      }

      stats.analysisCount++;
      log('Transform complete');
      sendJSON(res, 200, { result });
      return;
    }

    // Analyze all notes
    if (url.pathname === '/analyze-all' && req.method === 'POST') {
      const body = await readBody(req);
      const errors = validateAnalyzeAllPayload(body);
      if (errors.length > 0) {
        sendJSON(res, 400, { error: 'Validation failed', details: errors });
        return;
      }

      const { action, notes: notesData, prompt: customPrompt } = body;
      log(`Analyzing ${notesData.length} notes (action: ${action})`);

      const bulkText = formatNotesForBulk(notesData);
      const fullPrompt = action === 'custom'
        ? `${customPrompt}\n\n${bulkText}`
        : buildPrompt(action, bulkText);
      const result = await askClaude(fullPrompt);
      stats.analysisCount++;
      log('Bulk analysis complete');

      saveAnalysis(action, `${notesData.length} notes`, result);
      sendJSON(res, 200, { result });
      return;
    }

    // Get analysis history
    if (url.pathname === '/history' && req.method === 'GET') {
      const history = loadHistory();
      sendJSON(res, 200, { history });
      return;
    }

    // Save notes locally (for backup)
    if (url.pathname === '/backup' && req.method === 'POST') {
      const body = await readBody(req);
      const errors = validateBackupPayload(body);
      if (errors.length > 0) {
        sendJSON(res, 400, { error: 'Validation failed', details: errors });
        return;
      }

      const backupPath = path.join(DATA_DIR, `backup-${Date.now()}.json`);
      fs.writeFileSync(backupPath, JSON.stringify(body.notes, null, 2));
      log(`Backup saved: ${backupPath} (${body.notes.length} notes)`);
      sendJSON(res, 200, { path: backupPath, noteCount: body.notes.length });
      return;
    }

    // 404
    sendJSON(res, 404, {
      error: 'Not found',
      hint: `Available endpoints: GET /health, GET /status, GET /history, POST /analyze, POST /analyze-all, POST /backup`
    });
  } catch (err) {
    stats.errorCount++;
    log(`Error: ${err.message}`);

    const statusCode = err.message.includes('too large') ? 413
      : err.message.includes('Invalid JSON') || err.message.includes('empty') ? 400
      : 500;

    sendJSON(res, statusCode, { error: err.message });
  }
});

// ── Analysis History ─────────────────────────────────────
function saveAnalysis(action, title, result) {
  const historyPath = path.join(DATA_DIR, 'history.json');
  let history = [];
  try {
    history = JSON.parse(fs.readFileSync(historyPath, 'utf-8'));
  } catch {
    // File doesn't exist or is corrupt -- start fresh
  }
  history.unshift({
    action,
    title,
    result: result.slice(0, 500),
    timestamp: Date.now()
  });
  history = history.slice(0, 50); // Keep last 50
  try {
    fs.writeFileSync(historyPath, JSON.stringify(history, null, 2));
  } catch (err) {
    log(`Warning: Failed to save history: ${err.message}`);
  }
}

function loadHistory() {
  const historyPath = path.join(DATA_DIR, 'history.json');
  try {
    return JSON.parse(fs.readFileSync(historyPath, 'utf-8'));
  } catch {
    return [];
  }
}

// ── Utilities ────────────────────────────────────────────
function formatUptime(seconds) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const parts = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  parts.push(`${s}s`);
  return parts.join(' ');
}

// ── Graceful Shutdown ────────────────────────────────────
let isShuttingDown = false;

function shutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  log(`${signal} received. Shutting down gracefully...`);

  server.close(() => {
    log('All connections closed. Goodbye.');
    process.exit(0);
  });

  // Force exit after 10 seconds if connections won't close
  setTimeout(() => {
    log('Forcing shutdown after timeout.');
    process.exit(1);
  }, 10000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// ── Start ────────────────────────────────────────────────
server.listen(PORT, '127.0.0.1', () => {
  stats.startedAt = Date.now();
  const claudePath = findClaudeCode();
  const claudeStatus = claudePath ? 'Available' : 'NOT FOUND';
  const addr = `http://127.0.0.1:${PORT}`;

  console.log('');
  console.log('  +--------------------------------------------+');
  console.log(`  |        Notus Connector v${VERSION.padEnd(15)}|`);
  console.log('  +--------------------------------------------+');
  console.log(`  |  Server:      ${addr.padEnd(29)}|`);
  console.log(`  |  Claude Code: ${claudeStatus.padEnd(29)}|`);
  console.log(`  |  Data dir:    ${'~/.notus'.padEnd(29)}|`);
  console.log(`  |  Verbose:     ${String(VERBOSE).padEnd(29)}|`);
  console.log('  +--------------------------------------------+');
  console.log('');

  if (!claudePath) {
    console.log('  WARNING: Claude Code CLI not found.');
    console.log('  Analysis requests will fail until it is installed.');
    console.log('  Install: npm install -g @anthropic-ai/claude-code');
    console.log('');
  }

  log('Connector ready. Waiting for requests...');
  log(`Run with --help for usage information.`);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\nError: Port ${PORT} is already in use.`);
    console.error(`  - Another instance of Notus Connector may be running`);
    console.error(`  - Try a different port: notus-connector --port=${PORT + 1}`);
  } else if (err.code === 'EACCES') {
    console.error(`\nError: Permission denied for port ${PORT}.`);
    console.error(`  - Ports below 1024 require elevated privileges`);
    console.error(`  - Try a higher port: notus-connector --port=9471`);
  } else {
    console.error(`\nServer error: ${err.message}`);
  }
  process.exit(1);
});
