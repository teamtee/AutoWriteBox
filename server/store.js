import { mkdir, readFile, writeFile, rename, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

let DATA_ROOT = join(process.cwd(), 'data');
export function setDataRoot(p) { DATA_ROOT = p; }
const booksDir = () => join(DATA_ROOT, 'books');
// 白名单校验：防止 '../' 之类路径遍历。合法 id 只允许字母/数字/下划线/连字符
export function safeId(id) {
  if (typeof id !== 'string' || !/^[\w-]+$/.test(id)) throw new Error('BAD_ID');
  return id;
}
const bookDir = (id) => join(booksDir(), safeId(id));

export async function atomicWriteJson(absPath, obj) {
  const tmp = absPath + '.tmp';
  await writeFile(tmp, JSON.stringify(obj, null, 2), 'utf8');
  await rename(tmp, absPath);
}

function emptyOutline() { return emptyVersioned(); }
function emptyCore() {
  return { core: {
    world: emptyVersioned(), style: emptyVersioned(),
    constraints: emptyVersioned(), pacing: emptyVersioned(),
  }, history: [] };
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
    const book = JSON.parse(await readFile(join(bookDir(id), 'book.json'), 'utf8'));
    return migrateBookInPlace(book);
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
      let chapterCount = 0;
      for (const sid of b.sections || []) {
        try {
          const sec = JSON.parse(await readFile(join(bookDir(id), safeId(sid), 'section.json'), 'utf8'));
          chapterCount += (sec.chapters || []).length;
        } catch { /* 缺失的部跳过 */ }
      }
      out.push({ id: b.id, title: b.title, updatedAt: b.updatedAt, sectionCount: (b.sections || []).length, chapterCount });
    } catch (err) {
      if (err.code === 'ENOENT') continue;  // 非书目录（无 book.json）跳过
      if (err.message === 'BAD_ID') continue;  // 非法目录名（如 .DS_Store）跳过
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
  return JSON.parse(await readFile(join(bookDir(bookId), safeId(sectionId), 'section.json'), 'utf8'));
}
export async function writeSection(bookId, sectionId, obj) {
  await atomicWriteJson(join(bookDir(bookId), safeId(sectionId), 'section.json'), obj);
}

// ——— chapter ———
export async function addChapter(bookId, sectionId, { title }) {
  const section = await readSection(bookId, sectionId);
  const index = section.chapters.length + 1;
  const id = `chapter-${pad2(index)}`;
  const chapter = {
    id, index, title: title || `第 ${index} 章`,
    body: emptyVersioned(), content: '',
    characters: [], summary: '', progress: '', status: 'done',
  };
  await atomicWriteJson(join(bookDir(bookId), sectionId, `${id}.json`), chapter);
  section.chapters.push(id);
  await writeSection(bookId, sectionId, section);
  return chapter;
}
export async function readChapter(bookId, sectionId, chapterId) {
  const ch = JSON.parse(await readFile(join(bookDir(bookId), safeId(sectionId), `${safeId(chapterId)}.json`), 'utf8'));
  return migrateChapterInPlace(ch);
}
export async function writeChapter(bookId, sectionId, chapterId, obj) {
  if (obj.body) obj.content = currentText(obj.body);  // 派生 content 与 body 保持同步
  await atomicWriteJson(join(bookDir(bookId), safeId(sectionId), `${safeId(chapterId)}.json`), obj);
}

// ——— history 回退栈（限深 20）———
const HISTORY_MAX = 20;

// ——— 可版本化字段原语（纯函数）———
export function emptyVersioned() { return { versions: [''], cursor: 0 }; }
export function currentText(vf) { return (vf && Array.isArray(vf.versions)) ? (vf.versions[vf.cursor] ?? '') : ''; }
export function commitVersion(vf, text) {
  vf.versions.push(text ?? '');
  while (vf.versions.length > HISTORY_MAX) vf.versions.shift();
  vf.cursor = vf.versions.length - 1;
  return vf;
}
export function moveCursor(vf, delta) {
  const n = vf.cursor + delta;
  if (n < 0 || n >= vf.versions.length) return false;
  vf.cursor = n; return true;
}
// 老结构 → 新结构：新结构原样 / 字符串→单版 / {content,history}→合并 / 其它→空
export function migrateVersioned(old) {
  if (old && Array.isArray(old.versions)) return old;
  if (typeof old === 'string') return { versions: [old], cursor: 0 };
  if (old && (typeof old.content === 'string' || Array.isArray(old.history))) {
    const history = Array.isArray(old.history) ? old.history : [];
    const versions = [...history, old.content ?? ''];
    return { versions, cursor: versions.length - 1 };
  }
  return emptyVersioned();
}
// ——— 惰性迁移辅助（读盘时把老结构就地升级为新结构）———
function migrateBookInPlace(book) {
  book.outline = migrateVersioned(book.outline);
  book.settings = book.settings || { core: {}, history: [] };
  const core = book.settings.core || {};
  for (const f of ['world', 'style', 'constraints', 'pacing']) core[f] = migrateVersioned(core[f]);
  book.settings.core = core;
  return book;
}
function migrateChapterInPlace(ch) {
  if (!ch.body || !Array.isArray(ch.body.versions)) {
    ch.body = migrateVersioned({ content: ch.content, history: ch.history });
  }
  ch.content = currentText(ch.body);  // 派生只读
  delete ch.history;                  // 老字段清理
  return ch;
}
// 版本路径解析（白名单，防注入）
export function parseVersionPath(path) {
  if (typeof path !== 'string') throw new Error('BAD_PATH');
  if (path === 'outline') return { type: 'outline' };
  const core = path.match(/^core:(world|style|constraints|pacing)$/);
  if (core) return { type: 'core', field: core[1] };
  const ch = path.match(/^section:([\w-]+):chapter:([\w-]+)$/);
  if (ch) return { type: 'chapter', sectionId: safeId(ch[1]), chapterId: safeId(ch[2]) };
  throw new Error('BAD_PATH');
}
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

// ——— 全局配置 ———
const configPath = () => join(DATA_ROOT, 'config.json');
const DEFAULT_CONFIG = { baseUrl: '', model: '', apiKey: '', chapterWordTarget: 2000 };

export async function readConfig() {
  try {
    return { ...DEFAULT_CONFIG, ...JSON.parse(await readFile(configPath(), 'utf8')) };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}
export async function writeConfig(patch) {
  const cur = await readConfig();
  const next = { ...cur, ...patch };
  if (!patch.apiKey || patch.apiKey === 'sk-****') next.apiKey = cur.apiKey;  // 保留原 Key
  await mkdir(DATA_ROOT, { recursive: true });
  await atomicWriteJson(configPath(), next);
  return next;
}

// ——— 书架管理 ———
export async function deleteBook(id) {
  // 递归删除整个书目录（幂等）；safeId 校验发生在 bookDir 里
  await rm(bookDir(id), { recursive: true, force: true });
}
export async function renameBook(id, title) {
  const book = await readBook(id);
  book.title = title || book.title;
  await writeBook(id, book);
  return book;
}

// ——— 统一版本读写 ———
// path 形如：'outline' | 'core:world|style|constraints|pacing' | 'section:<sid>:chapter:<cid>'
export async function versionMove(bookId, path, delta) {
  const p = parseVersionPath(path);
  if (p.type === 'chapter') {
    const ch = await readChapter(bookId, p.sectionId, p.chapterId);
    moveCursor(ch.body, delta);
    await writeChapter(bookId, p.sectionId, p.chapterId, ch);
    return ch.body;
  }
  const b = await readBook(bookId);
  const vf = p.type === 'outline' ? b.outline : b.settings.core[p.field];
  moveCursor(vf, delta);
  await writeBook(bookId, b);
  return vf;
}
export async function versionSet(bookId, path, text) {
  const p = parseVersionPath(path);
  if (p.type === 'chapter') {
    const ch = await readChapter(bookId, p.sectionId, p.chapterId);
    commitVersion(ch.body, text);
    await writeChapter(bookId, p.sectionId, p.chapterId, ch);
    return ch.body;
  }
  const b = await readBook(bookId);
  const vf = p.type === 'outline' ? b.outline : b.settings.core[p.field];
  commitVersion(vf, text);
  await writeBook(bookId, b);
  return vf;
}
