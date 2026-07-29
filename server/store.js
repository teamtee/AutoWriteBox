import { mkdir, readFile, writeFile, rename, readdir } from 'node:fs/promises';
import { join } from 'node:path';

let DATA_ROOT = join(process.cwd(), 'data');
export function setDataRoot(p) { DATA_ROOT = p; }
const booksDir = () => join(DATA_ROOT, 'books');
const bookDir = (id) => join(booksDir(), id);

export async function atomicWriteJson(absPath, obj) {
  const tmp = absPath + '.tmp';
  await writeFile(tmp, JSON.stringify(obj, null, 2), 'utf8');
  await rename(tmp, absPath);
}

function emptyOutline() { return { content: '', history: [] }; }
function emptyCore() {
  return { core: { world: '', style: '', constraints: '', pacing: '' }, history: [] };
}

export async function createBook({ premise, title }) {
  const id = 'book_' + new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 17);
  const now = new Date().toISOString();
  const book = {
    id, title: title || premise.slice(0, 20), createdAt: now, updatedAt: now,
    premise, outline: emptyOutline(), settings: emptyCore(),
    characters: [], summary: '', progress: '', sections: [],
  };
  await mkdir(bookDir(id), { recursive: true });
  await atomicWriteJson(join(bookDir(id), 'book.json'), book);
  return book;
}

export async function readBook(id) {
  try {
    return JSON.parse(await readFile(join(bookDir(id), 'book.json'), 'utf8'));
  } catch {
    throw new Error('BOOK_NOT_FOUND');
  }
}

export async function writeBook(id, book) {
  book.updatedAt = new Date().toISOString();
  await atomicWriteJson(join(bookDir(id), 'book.json'), book);
}

export async function listBooks() {
  let ids = [];
  try { ids = await readdir(booksDir()); } catch { return []; }
  const out = [];
  for (const id of ids) {
    try {
      const b = JSON.parse(await readFile(join(bookDir(id), 'book.json'), 'utf8'));
      out.push({ id: b.id, title: b.title, updatedAt: b.updatedAt });
    } catch { /* 跳过非法目录 */ }
  }
  return out;
}
