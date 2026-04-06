import { describe, it, expect } from 'vitest';
import { markdownToBlocks, txt } from '../app/src/markdown.js';

describe('txt helper', () => {
  it('creates a text inline content with styles: {}', () => {
    const result = txt('hello');
    expect(result).toEqual({ type: 'text', text: 'hello', styles: {} });
  });
});

describe('markdownToBlocks', () => {
  it('converts h1 heading', () => {
    const blocks = markdownToBlocks('# Title');
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe('heading');
    expect(blocks[0].props.level).toBe(1);
    expect(blocks[0].content[0].text).toBe('Title');
  });

  it('converts h2 heading', () => {
    const blocks = markdownToBlocks('## Subtitle');
    expect(blocks[0].type).toBe('heading');
    expect(blocks[0].props.level).toBe(2);
    expect(blocks[0].content[0].text).toBe('Subtitle');
  });

  it('converts h3 heading', () => {
    const blocks = markdownToBlocks('### Section');
    expect(blocks[0].type).toBe('heading');
    expect(blocks[0].props.level).toBe(3);
  });

  it('converts h4 heading', () => {
    const blocks = markdownToBlocks('#### Deep');
    expect(blocks[0].type).toBe('heading');
    expect(blocks[0].props.level).toBe(4);
  });

  it('converts bullet lists', () => {
    const md = '- Item A\n- Item B\n- Item C';
    const blocks = markdownToBlocks(md);
    expect(blocks).toHaveLength(3);
    blocks.forEach(b => expect(b.type).toBe('bulletListItem'));
    expect(blocks[0].content[0].text).toBe('Item A');
    expect(blocks[1].content[0].text).toBe('Item B');
    expect(blocks[2].content[0].text).toBe('Item C');
  });

  it('converts numbered lists', () => {
    const md = '1. First\n2. Second\n3. Third';
    const blocks = markdownToBlocks(md);
    expect(blocks).toHaveLength(3);
    blocks.forEach(b => expect(b.type).toBe('numberedListItem'));
    expect(blocks[0].content[0].text).toBe('First');
    expect(blocks[1].content[0].text).toBe('Second');
    expect(blocks[2].content[0].text).toBe('Third');
  });

  it('converts checklists (unchecked)', () => {
    const md = '- [ ] Todo item';
    const blocks = markdownToBlocks(md);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe('checkListItem');
    expect(blocks[0].props.checked).toBe(false);
    expect(blocks[0].content[0].text).toBe('Todo item');
  });

  it('converts checklists (checked)', () => {
    const md = '- [x] Done item';
    const blocks = markdownToBlocks(md);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe('checkListItem');
    expect(blocks[0].props.checked).toBe(true);
    expect(blocks[0].content[0].text).toBe('Done item');
  });

  it('converts code blocks', () => {
    const md = '```\nconst x = 1;\nconsole.log(x);\n```';
    const blocks = markdownToBlocks(md);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe('codeBlock');
    expect(blocks[0].content[0].text).toBe('const x = 1;\nconsole.log(x);');
  });

  it('converts tables', () => {
    const md = '| Name | Age |\n| --- | --- |\n| Alice | 30 |';
    const blocks = markdownToBlocks(md);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe('table');
    expect(blocks[0].content.type).toBe('tableContent');
    const rows = blocks[0].content.rows;
    // The separator row is skipped, so we get header + data row
    expect(rows).toHaveLength(2);
    expect(rows[0].cells[0][0].text).toBe('Name');
    expect(rows[0].cells[1][0].text).toBe('Age');
    expect(rows[1].cells[0][0].text).toBe('Alice');
    expect(rows[1].cells[1][0].text).toBe('30');
  });

  it('skips image markdown ![]()', () => {
    const md = '![alt text](http://example.com/image.png)';
    const blocks = markdownToBlocks(md);
    // Should return empty paragraph since image was skipped
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe('paragraph');
    expect(blocks[0].content).toEqual([]);
  });

  it('skips [Image] placeholders', () => {
    const md = '[Image]\nSome text after';
    const blocks = markdownToBlocks(md);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe('paragraph');
    expect(blocks[0].content[0].text).toBe('Some text after');
  });

  it('skips [Image: description] placeholders', () => {
    const md = '[Image: a photo]';
    const blocks = markdownToBlocks(md);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe('paragraph');
    expect(blocks[0].content).toEqual([]);
  });

  it('returns empty paragraph for empty input', () => {
    expect(markdownToBlocks('')).toEqual([{ type: 'paragraph', content: [] }]);
    expect(markdownToBlocks(null)).toEqual([{ type: 'paragraph', content: [] }]);
    expect(markdownToBlocks(undefined)).toEqual([{ type: 'paragraph', content: [] }]);
  });

  it('all text content has styles: {} (the critical bug we fixed)', () => {
    const md = '# Heading\n- Bullet\n1. Number\n- [ ] Check\nParagraph text';
    const blocks = markdownToBlocks(md);
    for (const block of blocks) {
      if (Array.isArray(block.content)) {
        for (const item of block.content) {
          expect(item.styles).toEqual({});
        }
      }
    }
  });

  it('handles horizontal rules ---', () => {
    const md = '---';
    const blocks = markdownToBlocks(md);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe('paragraph');
    expect(blocks[0].content[0].text).toBe('---');
  });

  it('handles multiple horizontal rules', () => {
    const md = '-----';
    const blocks = markdownToBlocks(md);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].content[0].text).toBe('---');
  });

  it('strips bold markdown from headings', () => {
    const md = '# **Bold Title**';
    const blocks = markdownToBlocks(md);
    expect(blocks[0].content[0].text).toBe('Bold Title');
  });

  it('strips bold markdown from paragraph text', () => {
    const md = 'This is **bold** text';
    const blocks = markdownToBlocks(md);
    expect(blocks[0].content[0].text).toBe('This is bold text');
  });

  it('handles mixed content', () => {
    const md = '# Title\n\nSome paragraph\n\n- Bullet one\n- Bullet two\n\n1. Numbered one\n2. Numbered two';
    const blocks = markdownToBlocks(md);
    expect(blocks[0].type).toBe('heading');
    expect(blocks[1].type).toBe('paragraph');
    expect(blocks[2].type).toBe('bulletListItem');
    expect(blocks[3].type).toBe('bulletListItem');
    expect(blocks[4].type).toBe('numberedListItem');
    expect(blocks[5].type).toBe('numberedListItem');
  });
});
