// Helper: create a text inline content with styles
export function txt(text) { return { type: 'text', text, styles: {} }; }

export function markdownToBlocks(md) {
  if (!md || typeof md !== 'string') return [{ type: 'paragraph', content: [] }];
  const lines = md.split('\n');
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    // Skip markdown image references — actual images are handled as BlockNote blocks
    if (/^!\[.*\]\(.*\)$/.test(line.trim())) { i++; continue; }
    // Skip [Image] / [Image: ...] placeholders
    if (/^\[Image(:.*)?\]$/.test(line.trim())) { i++; continue; }
    if (/^---+$/.test(line.trim())) { blocks.push({ type: 'paragraph', content: [txt('---')] }); i++; continue; }
    const hm = line.match(/^(#{1,4})\s+(.+)/);
    if (hm) { blocks.push({ type: 'heading', props: { level: hm[1].length }, content: [txt(hm[2].replace(/\*\*/g, ''))] }); i++; continue; }
    if (line.startsWith('```')) { const cl = []; i++; while (i < lines.length && !lines[i].startsWith('```')) { cl.push(lines[i]); i++; } i++; blocks.push({ type: 'codeBlock', content: [txt(cl.join('\n'))] }); continue; }
    if (/^- \[[ x]\] /.test(line)) {
      while (i < lines.length && /^- \[[ x]\] /.test(lines[i])) {
        const m = lines[i].match(/^- \[([ x])\] (.+)/);
        blocks.push({ type: 'checkListItem', props: { checked: m[1] === 'x' }, content: [txt(m[2])] });
        i++;
      }
      continue;
    }
    if (/^[\-\*] /.test(line)) {
      while (i < lines.length && /^[\-\*] /.test(lines[i])) {
        blocks.push({ type: 'bulletListItem', content: [txt(lines[i].replace(/^[\-\*] /, ''))] });
        i++;
      }
      continue;
    }
    if (/^\d+\.\s/.test(line)) {
      while (i < lines.length && /^\d+\.\s/.test(lines[i])) {
        blocks.push({ type: 'numberedListItem', content: [txt(lines[i].replace(/^\d+\.\s+/, ''))] });
        i++;
      }
      continue;
    }
    if (line.includes('|') && line.trim().startsWith('|')) {
      const rows = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim().startsWith('|')) {
        const cells = lines[i].split('|').map(c => c.trim()).filter((_, j, a) => j > 0 && j < a.length - 1);
        if (!/^[\-:\s]+$/.test(cells.join(''))) rows.push(cells);
        i++;
      }
      if (rows.length > 0) {
        blocks.push({ type: 'table', content: { type: 'tableContent', rows: rows.map(r => ({ cells: r.map(c => [txt(c)]) })) } });
      }
      continue;
    }
    blocks.push({ type: 'paragraph', content: [txt(line.replace(/\*\*(.+?)\*\*/g, '$1'))] });
    i++;
  }
  return blocks.length > 0 ? blocks : [{ type: 'paragraph', content: [] }];
}
