import React, { useEffect, useMemo, useRef, useCallback } from 'react';
import { BlockNoteView } from '@blocknote/mantine';
import { useCreateBlockNote } from '@blocknote/react';
import '@blocknote/core/fonts/inter.css';
import '@blocknote/mantine/style.css';

// File-type blocks have no inline content
const FILE_BLOCK_TYPES = ['image', 'video', 'audio', 'file'];

// All valid default BlockNote block types
const VALID_BLOCK_TYPES = [
  'paragraph', 'heading', 'bulletListItem', 'numberedListItem',
  'checkListItem', 'table', 'image', 'video', 'audio', 'file', 'codeBlock'
];

function sanitizeInline(item) {
  if (!item || typeof item !== 'object') {
    return { type: 'text', text: String(item || ''), styles: {} };
  }
  const out = { ...item };
  // CRITICAL: styles must be an object, never undefined/null
  if (!out.styles || typeof out.styles !== 'object') {
    out.styles = {};
  }
  if (out.type === 'link' && Array.isArray(out.content)) {
    out.content = out.content.map(sanitizeInline);
  }
  return out;
}

export function sanitizeBlocks(blocks) {
  if (!Array.isArray(blocks)) return [{ type: 'paragraph', content: [] }];

  return blocks
    .filter(b => b && typeof b === 'object')
    .map(b => {
      // Default or fix invalid type
      let type = b.type;
      if (!type || !VALID_BLOCK_TYPES.includes(type)) {
        type = 'paragraph';
      }

      const clean = { type };

      // Preserve id
      if (b.id) clean.id = b.id;

      // Props — always pass if present
      if (b.props && typeof b.props === 'object') {
        clean.props = { ...b.props };
      }

      // Children
      clean.children = Array.isArray(b.children) ? sanitizeBlocks(b.children) : [];

      // Content — depends on block type
      if (FILE_BLOCK_TYPES.includes(type)) {
        // No content for file-type blocks
      } else if (type === 'table' && b.content && typeof b.content === 'object' && b.content.type === 'tableContent') {
        // Table content — sanitize cell inline items
        const rows = (b.content.rows || []).map(row => ({
          cells: (row.cells || []).map(cell =>
            Array.isArray(cell) ? cell.map(sanitizeInline) : []
          )
        }));
        clean.content = { type: 'tableContent', rows };
      } else if (Array.isArray(b.content)) {
        clean.content = b.content.map(sanitizeInline);
      } else {
        // Fallback: try to extract text from whatever content is
        let text = '';
        if (typeof b.content === 'string') text = b.content;
        else if (b.content && b.content.text) text = b.content.text;
        clean.content = text ? [{ type: 'text', text, styles: {} }] : [];
      }

      return clean;
    });
}

export function NoteEditor({ note, onContentChange, theme }) {
  const prevNoteId = useRef(null);

  const editor = useCreateBlockNote({
    domAttributes: {
      editor: { class: 'notus-editor' },
    },
    uploadFile: async (file) => {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
    },
  });

  // Load content when note changes
  useEffect(() => {
    if (!editor || !note) return;
    if (prevNoteId.current === note.id) return;
    prevNoteId.current = note.id;

    try {
      let blocks;
      if (note.body) {
        if (typeof note.body === 'string') {
          try {
            const parsed = JSON.parse(note.body);
            blocks = Array.isArray(parsed) ? parsed : parsed.blocks || parsed;
          } catch {
            const text = note.body.replace(/<[^>]+>/g, '');
            blocks = [{ type: 'paragraph', content: [{ type: 'text', text, styles: {} }] }];
          }
        } else {
          blocks = Array.isArray(note.body) ? note.body : [];
        }
      }

      if (blocks && blocks.length > 0) {
        editor.replaceBlocks(editor.document, sanitizeBlocks(blocks));
      } else {
        editor.replaceBlocks(editor.document, [{ type: 'paragraph', content: [] }]);
      }
    } catch (e) {
      console.warn('Failed to load note content:', e);
      editor.replaceBlocks(editor.document, [{ type: 'paragraph', content: [] }]);
    }
  }, [editor, note?.id]);

  // Auto-save on change
  const handleChange = useCallback(() => {
    if (!editor || !note) return;
    const blocks = editor.document;
    onContentChange(JSON.stringify(blocks));
  }, [editor, note, onContentChange]);

  if (!note) return null;

  return (
    <BlockNoteView
      editor={editor}
      theme={theme === 'light' ? 'light' : 'dark'}
      onChange={handleChange}
      data-theming-css-variables-demo
    />
  );
}

// Convert BlockNote blocks to markdown (preserves structure for Claude)
export function blocksToMarkdown(body) {
  if (!body) return '';
  let blocks;
  try {
    blocks = typeof body === 'string' ? JSON.parse(body) : body;
  } catch { return body.replace(/<[^>]+>/g, ''); }
  if (!Array.isArray(blocks)) blocks = blocks?.blocks || [];

  function inlineToMd(content) {
    if (!content) return '';
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) return content.map(inlineToMd).join('');
    if (content.type === 'link') return `[${inlineToMd(content.content)}](${content.href || ''})`;
    let t = content.text || '';
    if (content.styles) {
      if (content.styles.bold) t = `**${t}**`;
      if (content.styles.italic) t = `*${t}*`;
      if (content.styles.strikethrough) t = `~~${t}~~`;
      if (content.styles.code) t = '`' + t + '`';
    }
    return t;
  }

  let numIdx = 0;
  return blocks.map((b, idx) => {
    const text = inlineToMd(b.content);
    const childMd = Array.isArray(b.children) && b.children.length > 0
      ? '\n' + blocksToMarkdownInner(b.children, '  ')
      : '';

    switch (b.type) {
      case 'heading': {
        const lvl = b.props?.level || 1;
        return '#'.repeat(lvl) + ' ' + text + childMd;
      }
      case 'bulletListItem':
        numIdx = 0;
        return '- ' + text + childMd;
      case 'numberedListItem':
        numIdx++;
        return numIdx + '. ' + text + childMd;
      case 'checkListItem':
        numIdx = 0;
        return (b.props?.checked ? '- [x] ' : '- [ ] ') + text + childMd;
      case 'codeBlock':
        return '```\n' + text + '\n```';
      case 'table': {
        if (!b.content || b.content.type !== 'tableContent') return text;
        const rows = b.content.rows || [];
        if (rows.length === 0) return '';
        const mdRows = rows.map(r =>
          '| ' + (r.cells || []).map(cell =>
            Array.isArray(cell) ? cell.map(inlineToMd).join('') : ''
          ).join(' | ') + ' |'
        );
        if (mdRows.length > 0) {
          const colCount = (rows[0].cells || []).length;
          const sep = '| ' + Array(colCount).fill('---').join(' | ') + ' |';
          mdRows.splice(1, 0, sep);
        }
        return mdRows.join('\n');
      }
      case 'image':
        return '';
      default:
        if (b.type !== 'paragraph') numIdx = 0;
        else if (idx > 0 && blocks[idx - 1]?.type !== 'numberedListItem') numIdx = 0;
        return text + childMd;
    }
  }).join('\n');
}

function blocksToMarkdownInner(blocks, indent) {
  if (!Array.isArray(blocks)) return '';
  return blocks.map(b => {
    const content = Array.isArray(b.content) ? b.content.map(c => c?.text || '').join('') : '';
    const prefix = b.type === 'bulletListItem' ? '- '
      : b.type === 'checkListItem' ? (b.props?.checked ? '- [x] ' : '- [ ] ')
      : b.type === 'numberedListItem' ? '1. '
      : '';
    return indent + prefix + content;
  }).join('\n');
}

// Extract plain text from BlockNote blocks
export function blocksToText(body) {
  if (!body) return '';
  let blocks;
  try {
    blocks = typeof body === 'string' ? JSON.parse(body) : body;
  } catch { return body.replace(/<[^>]+>/g, ''); }
  if (!Array.isArray(blocks)) blocks = blocks?.blocks || [];

  function extractText(content) {
    if (!content) return '';
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) return content.map(extractText).join('');
    if (content.text) return content.text;
    if (content.content) return extractText(content.content);
    return '';
  }

  return blocks.map(b => {
    let text = extractText(b.content);
    if (b.children) text += '\n' + blocks2text(b.children);
    return text;
  }).filter(Boolean).join('\n');
}

function blocks2text(blocks) {
  if (!Array.isArray(blocks)) return '';
  return blocks.map(b => {
    let t = '';
    if (b.content) t = Array.isArray(b.content) ? b.content.map(c => c.text || '').join('') : '';
    if (b.children?.length) t += '\n' + blocks2text(b.children);
    return t;
  }).join('\n');
}
