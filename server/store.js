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
  // 时间戳（毫秒）+ 4 位随机后缀，避免同毫秒建书撞 id
  const ts = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 17);
  const id = 'book_' + ts + '_' + Math.random().toString(36).slice(2, 6);
  const now = new Date().toISOString();
  const book = {
    id, title: title || (premise ?? '').slice(0, 20), createdAt: now, updatedAt: now,
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
  } catch (err) {
    if (err.code === 'ENOENT') throw new Error('BOOK_NOT_FOUND');
    throw err;  // 权限/磁盘/JSON 解析等真实故障原样上抛，不掩盖
  }
}

export async function writeBook(id, book) {
  book.updatedAt = new Date().toISOString();
  await atomicWriteJson(join(bookDir(id), 'book.json'), book);
}

export async function listBooks() {
  let ids = [];
  try { ids = await readdir(booksDir()); }
  catch (err) { if (err.code === 'ENOENT') return []; throw err; }
  const out = [];
  for (const id of ids) {
    try {
      const b = JSON.parse(await readFile(join(bookDir(id), 'book.json'), 'utf8'));
      out.push({ id: b.id, title: b.title, updatedAt: b.updatedAt });
    } catch (err) {
      if (err.code === 'ENOENT') continue;  // 非书目录（无 book.json）跳过
      throw err;  // 其余错误上抛
    }
  }
  return out;
}

// ——— 序号格式化 ———
const pad2 = (n) => String(n).padStart(2, '0');

// ——— section ———
export async function addSection(bookId, { title }) {
  const book = await readBook(bookId);
  const index = book.sections.length + 1;
  const id = `section-${pad2(index)}`;
  const section = {
    id, index, title: title || `第 ${index} 部`,
    outline: { content: '', history: [] },
    characters: [], summary: '', progress: '', chapters: [],
  };
  await mkdir(join(bookDir(bookId), id), { recursive: true });
  await atomicWriteJson(join(bookDir(bookId), id, 'section.json'), section);
  book.sections.push(id);
  await writeBook(bookId, book);
  return section;
}
export async function readSection(bookId, sectionId) {
  return JSON.parse(await readFile(join(bookDir(bookId), sectionId, 'section.json'), 'utf8'));
}
export async function writeSection(bookId, sectionId, obj) {
  await atomicWriteJson(join(bookDir(bookId), sectionId, 'section.json'), obj);
}

// ——— chapter ———
export async function addChapter(bookId, sectionId, { title }) {
  const section = await readSection(bookId, sectionId);
  const index = section.chapters.length + 1;
  const id = `chapter-${pad2(index)}`;
  const chapter = {
    id, index, title: title || `第 ${index} 章`,
    content: '', characters: [], summary: '', progress: '',
    status: 'done', history: [],
  };
  await atomicWriteJson(join(bookDir(bookId), sectionId, `${id}.json`), chapter);
  section.chapters.push(id);
  await writeSection(bookId, sectionId, section);
  return chapter;
}
export async function readChapter(bookId, sectionId, chapterId) {
  return JSON.parse(await readFile(join(bookDir(bookId), sectionId, `${chapterId}.json`), 'utf8'));
}
export async function writeChapter(bookId, sectionId, chapterId, obj) {
  await atomicWriteJson(join(bookDir(bookId), sectionId, `${chapterId}.json`), obj);
}

// ——— history 回退栈（限深 20）———
const HISTORY_MAX = 20;
export function pushHistory(obj, field) {
  if (field === 'content') {
    obj.history = obj.history || [];
    obj.history.push(obj.content);
    if (obj.history.length > HISTORY_MAX) obj.history.shift();
  } else {
    obj[field].history = obj[field].history || [];
    obj[field].history.push(obj[field].content);
    if (obj[field].history.length > HISTORY_MAX) obj[field].history.shift();
  }
  return obj;
}
export function rollback(obj, field) {
  if (field === 'content') {
    if (!obj.history || obj.history.length === 0) return false;
    obj.content = obj.history.pop();
    return true;
  }
  if (!obj[field].history || obj[field].history.length === 0) return false;
  obj[field].content = obj[field].history.pop();
  return true;
}
