// Claude connector bridge
let port = parseInt(localStorage.getItem('notus-port') || '9471');

export function setPort(p) { port = p; localStorage.setItem('notus-port', String(p)); }
export function getPort() { return port; }

export async function checkHealth() {
  try {
    const res = await fetch(`http://localhost:${port}/health`, { signal: AbortSignal.timeout(2000) });
    return (await res.json()).status === 'ok';
  } catch { return false; }
}

export async function transform(prompt, text, files) {
  const body = { prompt, text };
  if (files && files.length > 0) body.files = files;
  const res = await fetch(`http://localhost:${port}/transform`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data.result;
}

export async function analyze(prompt, notesData) {
  const isMulti = notesData.length > 1;
  const endpoint = isMulti ? '/analyze-all' : '/analyze';
  const body = isMulti
    ? { action: 'custom', notes: notesData, prompt }
    : { action: 'custom', note: notesData[0], prompt };
  const res = await fetch(`http://localhost:${port}${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data.result;
}
