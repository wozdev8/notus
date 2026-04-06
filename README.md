# NoteVault

**Private notes that never leave your device. AI-powered analysis via Claude Code.**

NoteVault is a local-first notes app built as a PWA. Your notes are stored in your browser's IndexedDB — no cloud, no accounts, no sync. Connect the local connector to Claude Code for AI-powered analysis of your notes.

## Architecture

```
┌─────────────────┐     localhost:9471     ┌───────────────┐     CLI subprocess     ┌─────────────┐
│  NoteVault PWA  │ ───────────────────▶  │   Connector   │ ──────────────────▶   │ Claude Code │
│  (IndexedDB)    │                        │  (Node.js)    │                        │   (Local)   │
└─────────────────┘                        └───────────────┘                        └─────────────┘
```

All three components run locally on your machine. No external network requests.

## Quick Start

### 1. Launch the App

```bash
cd app
npx serve .
# Open http://localhost:3000
# Install as PWA from your browser
```

### 2. Start the Connector

```bash
cd connector
node server.js
# Runs on http://localhost:9471
```

### Or use the launcher script:

```bash
./start.sh
# Starts both app and connector
```

## Components

### App (`app/`)

PWA notes application with:
- Create, edit, delete notes
- Tag-based organization
- Full-text search
- Import/export as JSON
- Keyboard shortcuts (Cmd/Ctrl+N, Cmd/Ctrl+F, Cmd/Ctrl+E)
- Works offline after first load
- Installable on Windows and macOS

### Connector (`connector/`)

Local Node.js server that bridges notes to Claude Code:
- Runs on `localhost:9471`
- Endpoints: `/health`, `/analyze`, `/analyze-all`, `/backup`, `/history`
- Sends notes to Claude Code CLI for analysis
- Supports: summarize, insights, action items, improvements, themes, connections
- Zero external network calls

### Website (`website/`)

Landing page with:
- Hero section
- Features grid
- How it works (3-step guide)
- Architecture diagram
- Download/install instructions
- FAQ section

```bash
cd website
npx serve .
# Open http://localhost:8080
```

## Requirements

- Node.js 18+
- A modern browser (Chrome, Edge, Firefox, Safari)
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) (for AI analysis features)

## Privacy

- All notes stored in IndexedDB (local browser storage)
- Connector only listens on `127.0.0.1` (localhost)
- Claude Code processes notes locally using your own API key
- No analytics, no tracking, no cookies, no external requests
- You can use the app without the connector for basic note-taking

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| Cmd/Ctrl + N | New note |
| Cmd/Ctrl + F | Focus search |
| Cmd/Ctrl + E | Export all notes |
| Enter (in tag input) | Add tag |

## License

MIT
