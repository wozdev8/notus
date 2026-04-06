import { describe, it, expect } from 'vitest';
import { blocksToText, blocksToMarkdown, sanitizeBlocks } from '../app/src/Editor.jsx';

// ── blocksToText ────────────────────────────────────────

describe('blocksToText', () => {
  it('converts blocks to plain text', () => {
    const blocks = [
      { type: 'paragraph', content: [{ type: 'text', text: 'Hello world', styles: {} }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'Second line', styles: {} }] },
    ];
    expect(blocksToText(blocks)).toBe('Hello world\nSecond line');
  });

  it('handles JSON string input', () => {
    const blocks = [
      { type: 'paragraph', content: [{ type: 'text', text: 'From JSON', styles: {} }] },
    ];
    expect(blocksToText(JSON.stringify(blocks))).toBe('From JSON');
  });

  it('handles empty input', () => {
    expect(blocksToText('')).toBe('');
    expect(blocksToText(null)).toBe('');
    expect(blocksToText(undefined)).toBe('');
  });

  it('handles nested children', () => {
    const blocks = [
      {
        type: 'bulletListItem',
        content: [{ type: 'text', text: 'Parent', styles: {} }],
        children: [
          { type: 'bulletListItem', content: [{ type: 'text', text: 'Child', styles: {} }] },
        ],
      },
    ];
    expect(blocksToText(blocks)).toContain('Parent');
    expect(blocksToText(blocks)).toContain('Child');
  });

  it('handles blocks with no content', () => {
    const blocks = [{ type: 'paragraph', content: [] }];
    expect(blocksToText(blocks)).toBe('');
  });
});

// ── blocksToMarkdown ────────────────────────────────────

describe('blocksToMarkdown', () => {
  it('converts headings properly', () => {
    const blocks = [
      { type: 'heading', props: { level: 1 }, content: [{ type: 'text', text: 'Title', styles: {} }] },
      { type: 'heading', props: { level: 2 }, content: [{ type: 'text', text: 'Subtitle', styles: {} }] },
      { type: 'heading', props: { level: 3 }, content: [{ type: 'text', text: 'Section', styles: {} }] },
    ];
    const md = blocksToMarkdown(blocks);
    expect(md).toContain('# Title');
    expect(md).toContain('## Subtitle');
    expect(md).toContain('### Section');
  });

  it('converts checkListItem (checked and unchecked)', () => {
    const blocks = [
      { type: 'checkListItem', props: { checked: true }, content: [{ type: 'text', text: 'Done', styles: {} }] },
      { type: 'checkListItem', props: { checked: false }, content: [{ type: 'text', text: 'Todo', styles: {} }] },
    ];
    const md = blocksToMarkdown(blocks);
    expect(md).toContain('- [x] Done');
    expect(md).toContain('- [ ] Todo');
  });

  it('converts bulletListItem', () => {
    const blocks = [
      { type: 'bulletListItem', content: [{ type: 'text', text: 'Item one', styles: {} }] },
      { type: 'bulletListItem', content: [{ type: 'text', text: 'Item two', styles: {} }] },
    ];
    const md = blocksToMarkdown(blocks);
    expect(md).toContain('- Item one');
    expect(md).toContain('- Item two');
  });

  it('converts numberedListItem', () => {
    const blocks = [
      { type: 'numberedListItem', content: [{ type: 'text', text: 'First', styles: {} }] },
      { type: 'numberedListItem', content: [{ type: 'text', text: 'Second', styles: {} }] },
    ];
    const md = blocksToMarkdown(blocks);
    expect(md).toContain('1. First');
    expect(md).toContain('2. Second');
  });

  it('converts tables', () => {
    const blocks = [
      {
        type: 'table',
        content: {
          type: 'tableContent',
          rows: [
            { cells: [[{ type: 'text', text: 'Name', styles: {} }], [{ type: 'text', text: 'Age', styles: {} }]] },
            { cells: [[{ type: 'text', text: 'Alice', styles: {} }], [{ type: 'text', text: '30', styles: {} }]] },
          ],
        },
      },
    ];
    const md = blocksToMarkdown(blocks);
    expect(md).toContain('| Name | Age |');
    expect(md).toContain('| --- | --- |');
    expect(md).toContain('| Alice | 30 |');
  });

  it('skips image blocks (returns empty)', () => {
    const blocks = [
      { type: 'image', props: { url: 'data:image/png;base64,...' } },
      { type: 'paragraph', content: [{ type: 'text', text: 'After image', styles: {} }] },
    ];
    const md = blocksToMarkdown(blocks);
    expect(md).not.toContain('data:image');
    expect(md).toContain('After image');
  });

  it('handles empty input', () => {
    expect(blocksToMarkdown('')).toBe('');
    expect(blocksToMarkdown(null)).toBe('');
    expect(blocksToMarkdown(undefined)).toBe('');
  });

  it('handles bold/italic/strikethrough/code inline styles', () => {
    const blocks = [
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'bold', styles: { bold: true } },
          { type: 'text', text: ' and ', styles: {} },
          { type: 'text', text: 'italic', styles: { italic: true } },
        ],
      },
    ];
    const md = blocksToMarkdown(blocks);
    expect(md).toContain('**bold**');
    expect(md).toContain('*italic*');
  });
});

// ── sanitizeBlocks ──────────────────────────────────────

describe('sanitizeBlocks', () => {
  it('fixes missing styles on inline content', () => {
    const blocks = [
      {
        type: 'paragraph',
        content: [{ type: 'text', text: 'no styles' }],
      },
    ];
    const result = sanitizeBlocks(blocks);
    expect(result[0].content[0].styles).toEqual({});
  });

  it('converts unknown block types to paragraph', () => {
    const blocks = [
      { type: 'unknownWidget', content: [{ type: 'text', text: 'test', styles: {} }] },
    ];
    const result = sanitizeBlocks(blocks);
    expect(result[0].type).toBe('paragraph');
  });

  it('handles null/undefined blocks', () => {
    expect(sanitizeBlocks(null)).toEqual([{ type: 'paragraph', content: [] }]);
    expect(sanitizeBlocks(undefined)).toEqual([{ type: 'paragraph', content: [] }]);
  });

  it('handles empty array', () => {
    expect(sanitizeBlocks([])).toEqual([]);
  });

  it('strips content from file-type blocks (image, video, audio, file)', () => {
    const blocks = [
      { type: 'image', props: { url: 'test.png' }, content: [{ type: 'text', text: 'should be stripped' }] },
      { type: 'video', props: { url: 'test.mp4' }, content: [{ type: 'text', text: 'should be stripped' }] },
      { type: 'audio', props: { url: 'test.mp3' }, content: [{ type: 'text', text: 'should be stripped' }] },
      { type: 'file', props: { url: 'test.zip' }, content: [{ type: 'text', text: 'should be stripped' }] },
    ];
    const result = sanitizeBlocks(blocks);
    for (const b of result) {
      expect(b.content).toBeUndefined();
    }
  });

  it('sanitizes table content cells', () => {
    const blocks = [
      {
        type: 'table',
        content: {
          type: 'tableContent',
          rows: [
            { cells: [[{ type: 'text', text: 'Cell 1' }], [{ type: 'text', text: 'Cell 2' }]] },
          ],
        },
      },
    ];
    const result = sanitizeBlocks(blocks);
    const rows = result[0].content.rows;
    expect(rows[0].cells[0][0].styles).toEqual({});
    expect(rows[0].cells[1][0].styles).toEqual({});
  });

  it('preserves id when present', () => {
    const blocks = [
      { id: 'abc123', type: 'paragraph', content: [{ type: 'text', text: 'test', styles: {} }] },
    ];
    const result = sanitizeBlocks(blocks);
    expect(result[0].id).toBe('abc123');
  });

  it('always sets children array', () => {
    const blocks = [
      { type: 'paragraph', content: [] },
    ];
    const result = sanitizeBlocks(blocks);
    expect(Array.isArray(result[0].children)).toBe(true);
  });

  it('handles string content fallback', () => {
    const blocks = [
      { type: 'paragraph', content: 'just a string' },
    ];
    const result = sanitizeBlocks(blocks);
    expect(result[0].content[0].text).toBe('just a string');
    expect(result[0].content[0].styles).toEqual({});
  });

  it('filters out null/undefined entries in blocks array', () => {
    const blocks = [null, undefined, { type: 'paragraph', content: [] }];
    const result = sanitizeBlocks(blocks);
    expect(result.length).toBe(1);
    expect(result[0].type).toBe('paragraph');
  });
});
