// IndexedDB wrapper — all notes stay local
const DB_NAME = 'notevault';
const DB_VERSION = 1;
const STORE = 'notes';

let db = null;

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => { db = req.result; resolve(); };
    req.onupgradeneeded = (e) => {
      const d = e.target.result;
      if (!d.objectStoreNames.contains(STORE)) {
        const s = d.createObjectStore(STORE, { keyPath: 'id' });
        s.createIndex('updatedAt', 'updatedAt');
        s.createIndex('tags', 'tags', { multiEntry: true });
      }
    };
  });
}

function tx(mode) { return db.transaction(STORE, mode).objectStore(STORE); }

export async function initDB() { await open(); }

export async function getAllNotes() {
  return new Promise((res, rej) => {
    const req = tx('readonly').index('updatedAt').getAll();
    req.onsuccess = () => res(req.result.reverse());
    req.onerror = () => rej(req.error);
  });
}

export async function saveNote(note) {
  return new Promise((res, rej) => {
    const t = db.transaction(STORE, 'readwrite');
    t.objectStore(STORE).put(note);
    t.oncomplete = () => res();
    t.onerror = () => rej(t.error);
  });
}

export async function deleteNote(id) {
  return new Promise((res, rej) => {
    const t = db.transaction(STORE, 'readwrite');
    t.objectStore(STORE).delete(id);
    t.oncomplete = () => res();
    t.onerror = () => rej(t.error);
  });
}
