import { mkdir, readFile, writeFile, rename, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

let DATA_ROOT = join(process.cwd(), 'data');
const storeLocks = new Map();
export function setDataRoot(p) {
  DATA_ROOT = p;
  storeLocks.clear();
}
const booksDir = () => join(DATA_ROOT, 'books');
// 白名单校验：防止 '../' 之类路径遍历。合法 id 只允许字母/数字/下划线/连字符
export function safeId(id) {
  if (typeof id !== 'string' || !/^[\w-]+$/.test(id)) throw new Error('BAD_ID');
  return id;
}
const bookDir = (id) => join(booksDir(), safeId(id));
const bookJsonLockKey = (bookId) => `book:${safeId(bookId)}:book-json`;
const sectionFileLockKey = (bookId, sectionId) =>
  `book:${safeId(bookId)}:section:${safeId(sectionId)}:section-file`;
const chapterFileLockKey = (bookId, sectionId, chapterId) =>
  `book:${safeId(bookId)}:section:${safeId(sectionId)}:chapter:${safeId(chapterId)}:file`;

async function withStoreLock(key, fn) {
  const previous = storeLocks.get(key) || Promise.resolve();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const current = previous.catch(() => {}).then(() => gate);
  storeLocks.set(key, current);
  await previous.catch(() => {});
  try {
    return await fn();
  } finally {
    release();
    if (storeLocks.get(key) === current) storeLocks.delete(key);
  }
}

export async function atomicWriteJson(absPath, obj) {
  const tmp = `${absPath}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(obj, null, 2), 'utf8');
    await rename(tmp, absPath);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

function emptyOutline() { return emptyVersioned(); }
function emptyCore() {
  return { core: {
    world: emptyVersioned(), style: emptyVersioned(),
    constraints: emptyVersioned(), pacing: emptyVersioned(),
  }, history: [] };
}

export async function createBook({ premise, title }) {
  if (typeof premise !== 'string' || !premise.trim()) throw new Error('BAD_PREMISE');
  // 时间戳（毫秒）+ 4 位随机后缀，避免同毫秒建书撞 id
  const ts = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 17);
  const id = 'book_' + ts + '_' + Math.random().toString(36).slice(2, 6);
  const now = new Date().toISOString();
  const hasExplicitTitle = typeof title === 'string' && title.trim() !== '';
  const book = {
    id,
    title: hasExplicitTitle ? title.trim() : (premise ?? '').slice(0, 20),
    titleSource: hasExplicitTitle ? 'manual' : 'default',
    createdAt: now, updatedAt: now,
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

async function writeBookUnlocked(id, book) {
  book.updatedAt = new Date().toISOString();
  await atomicWriteJson(join(bookDir(id), 'book.json'), book);
}

export async function writeBook(id, book) {
  const safeBookId = safeId(id);
  return withStoreLock(bookJsonLockKey(safeBookId), () => writeBookUnlocked(safeBookId, book));
}

async function touchBookUnlocked(id) {
  const book = await readBook(id);
  await writeBookUnlocked(id, book);
}

async function touchBook(id) {
  const safeBookId = safeId(id);
  return withStoreLock(bookJsonLockKey(safeBookId), () => touchBookUnlocked(safeBookId));
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
      if (err instanceof SyntaxError) continue;  // 损坏的书目录跳过，避免拖垮整个书架
      throw err;  // 其余错误上抛
    }
  }
  return out.sort((a, b) =>
    Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || b.id.localeCompare(a.id));
}

// ——— 序号格式化 ———
const pad2 = (n) => String(n).padStart(2, '0');
const TITLE_SOURCES = new Set(['default', 'ai', 'manual']);
const CN_NUM = '零一二三四五六七八九十百千两';

function stripGeneratedTitleDescription(title) {
  const raw = typeof title === 'string' ? title.trim() : '';
  const pure = raw.split(/[:：]/, 1)[0].trim();
  return pure || raw;
}

function normalizeEntityTitle(entity, unit) {
  if (TITLE_SOURCES.has(entity.titleSource)) {
    if (entity.titleSource === 'ai') entity.title = stripGeneratedTitleDescription(entity.title);
    return entity;
  }
  const raw = typeof entity.title === 'string' ? entity.title.trim() : '';
  const ordinal = `第\\s*(?:\\d+|[${CN_NUM}]+)\\s*${unit}`;
  const onlyOrdinal = new RegExp(`^${ordinal}$`);
  const withPrefix = new RegExp(`^${ordinal}\\s*[·:：\\-—]?\\s*(.*)$`);
  if (!raw || onlyOrdinal.test(raw)) {
    entity.title = '';
    entity.titleSource = 'default';
    return entity;
  }
  const m = raw.match(withPrefix);
  entity.title = (m ? m[1] : raw).trim();
  entity.titleSource = 'manual';
  return entity;
}

function migrateBookTitleInPlace(book) {
  if (!TITLE_SOURCES.has(book.titleSource)) {
    const fallback = (book.premise ?? '').slice(0, 20);
    book.titleSource = book.title === fallback ? 'default' : 'manual';
  }
  return book;
}

// ——— section ———
export async function addSection(bookId, { title, titleSource } = {}) {
  const safeBookId = safeId(bookId);
  return withStoreLock(`book:${safeBookId}:sections`, async () => {
    return withStoreLock(bookJsonLockKey(safeBookId), async () => {
      const book = await readBook(safeBookId);
      const index = book.sections.length + 1;
      const id = `section-${pad2(index)}`;
      const cleanTitle = typeof title === 'string' ? title.trim() : '';
      const source = cleanTitle ? (TITLE_SOURCES.has(titleSource) ? titleSource : 'manual') : 'default';
      const section = {
        id, index,
        title: source === 'ai' ? stripGeneratedTitleDescription(cleanTitle) : cleanTitle,
        titleSource: source,
        outline: { content: '', history: [] },
        characters: [], summary: '', progress: '', chapters: [],
      };
      await mkdir(join(bookDir(safeBookId), id), { recursive: true });
      await atomicWriteJson(join(bookDir(safeBookId), id, 'section.json'), section);
      book.sections.push(id);
      await writeBookUnlocked(safeBookId, book);
      return section;
    });
  });
}
export async function readSection(bookId, sectionId) {
  const section = JSON.parse(await readFile(
    join(bookDir(bookId), safeId(sectionId), 'section.json'), 'utf8'));
  return normalizeEntityTitle(section, '部');
}
export async function writeSection(bookId, sectionId, obj, { preserveExistingChapters = true } = {}) {
  const safeBookId = safeId(bookId);
  const safeSectionId = safeId(sectionId);
  return withStoreLock(sectionFileLockKey(safeBookId, safeSectionId), async () => {
    if (preserveExistingChapters) {
      try {
        const current = await readSection(safeBookId, safeSectionId);
        obj.chapters = current.chapters || [];
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
      }
    }
    await atomicWriteJson(join(bookDir(safeBookId), safeSectionId, 'section.json'), obj);
    await touchBook(safeBookId);
  });
}
// ——— chapter ———
export async function addChapter(bookId, sectionId, { title } = {}) {
  const safeBookId = safeId(bookId);
  const safeSectionId = safeId(sectionId);
  return withStoreLock(`book:${safeBookId}:section:${safeSectionId}:chapters`, async () => {
    return withStoreLock(sectionFileLockKey(safeBookId, safeSectionId), async () => {
      const section = await readSection(safeBookId, safeSectionId);
      const index = section.chapters.length + 1;
      const id = `chapter-${pad2(index)}`;
      const cleanTitle = typeof title === 'string' ? title.trim() : '';
      const chapter = {
        id, index,
        title: cleanTitle,
        titleSource: cleanTitle ? 'manual' : 'default',
        body: emptyVersioned(), content: '',
        characters: [], summary: '', progress: '', status: 'done',
      };
      await atomicWriteJson(join(bookDir(safeBookId), safeSectionId, `${id}.json`), chapter);
      section.chapters.push(id);
      await atomicWriteJson(join(bookDir(safeBookId), safeSectionId, 'section.json'), section);
      await touchBook(safeBookId);
      return chapter;
    });
  });
}
export async function readChapter(bookId, sectionId, chapterId) {
  const ch = JSON.parse(await readFile(join(bookDir(bookId), safeId(sectionId), `${safeId(chapterId)}.json`), 'utf8'));
  return migrateChapterInPlace(ch);
}
async function writeChapterFile(bookId, sectionId, chapterId, obj) {
  if (obj.body) obj.content = currentText(obj.body);  // 派生 content 与 body 保持同步
  await atomicWriteJson(join(bookDir(bookId), safeId(sectionId), `${safeId(chapterId)}.json`), obj);
}
async function withChapterWriteLocks(bookId, sectionId, chapterId, fn) {
  const safeBookId = safeId(bookId);
  const safeSectionId = safeId(sectionId);
  const safeChapterId = safeId(chapterId);
  return withStoreLock(sectionFileLockKey(safeBookId, safeSectionId), () =>
    withStoreLock(bookJsonLockKey(safeBookId), () =>
      withStoreLock(chapterFileLockKey(safeBookId, safeSectionId, safeChapterId), () =>
        fn(safeBookId, safeSectionId, safeChapterId))));
}
async function assertChapterReferenced(bookId, sectionId, chapterId) {
  const section = await readSection(bookId, sectionId);
  if (!(section.chapters || []).includes(chapterId)) throw new Error('CHAPTER_NOT_FOUND');
}
export async function writeChapter(bookId, sectionId, chapterId, obj) {
  return withChapterWriteLocks(bookId, sectionId, chapterId, async (safeBookId, safeSectionId, safeChapterId) => {
    await assertChapterReferenced(safeBookId, safeSectionId, safeChapterId);
    await writeChapterFile(safeBookId, safeSectionId, safeChapterId, obj);
    await touchBookUnlocked(safeBookId);
  });
}
export async function deleteChapter(bookId, sectionId, chapterId) {
  const safeBookId = safeId(bookId);
  const safeSectionId = safeId(sectionId);
  const safeChapterId = safeId(chapterId);
  return withChapterWriteLocks(safeBookId, safeSectionId, safeChapterId, async () => {
    await rm(join(bookDir(safeBookId), safeSectionId, `${safeChapterId}.json`), { force: true });
    const section = await readSection(safeBookId, safeSectionId);
    section.chapters = (section.chapters || []).filter((cid) => cid !== safeChapterId);
    await atomicWriteJson(join(bookDir(safeBookId), safeSectionId, 'section.json'), section);
    await touchBookUnlocked(safeBookId);
    return section;
  });
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
  migrateBookTitleInPlace(book);
  book.outline = migrateVersioned(book.outline);
  book.settings = book.settings || { core: {}, history: [] };
  const core = book.settings.core || {};
  for (const f of ['world', 'style', 'constraints', 'pacing']) core[f] = migrateVersioned(core[f]);
  book.settings.core = core;
  return book;
}
function migrateChapterInPlace(ch) {
  normalizeEntityTitle(ch, '章');
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
const configLockKey = () => 'config:config-json';
const DEFAULT_CONFIG = { baseUrl: '', model: '', apiKey: '', chapterWordTarget: 2000 };
const CONFIG_FIELDS = Object.keys(DEFAULT_CONFIG);
const CONFIG_FIELD_SET = new Set(CONFIG_FIELDS);

function normalizeConfig(config) {
  const out = { ...DEFAULT_CONFIG };
  for (const field of CONFIG_FIELDS) {
    if (config?.[field] !== undefined) out[field] = config[field];
  }
  return out;
}

export async function readConfig() {
  try {
    return normalizeConfig(JSON.parse(await readFile(configPath(), 'utf8')));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    return { ...DEFAULT_CONFIG };
  }
}
export async function writeConfig(patch) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new Error('BAD_CONFIG_PATCH');
  }
  for (const field of Object.keys(patch)) {
    if (!CONFIG_FIELD_SET.has(field)) throw new Error('BAD_CONFIG_FIELD');
  }
  return withStoreLock(configLockKey(), async () => {
    const cur = await readConfig();
    for (const field of ['baseUrl', 'model', 'apiKey']) {
      if (patch[field] !== undefined && typeof patch[field] !== 'string') {
        throw new Error('BAD_CONFIG_TEXT_FIELD');
      }
    }
    if (patch.chapterWordTarget !== undefined) {
      const target = patch.chapterWordTarget;
      if (!Number.isFinite(target) || target <= 0) throw new Error('BAD_CHAPTER_WORD_TARGET');
    }
    const next = { ...cur, ...patch };
    if (patch.apiKey === undefined || patch.apiKey === 'sk-****') next.apiKey = cur.apiKey;  // 保留原 Key
    await mkdir(DATA_ROOT, { recursive: true });
    await atomicWriteJson(configPath(), next);
    return next;
  });
}

// ——— 书架管理 ———
export async function deleteBook(id) {
  // 递归删除整个书目录（幂等）；safeId 校验发生在 bookDir 里
  const safeBookId = safeId(id);
  return withStoreLock(bookJsonLockKey(safeBookId), () =>
    rm(bookDir(safeBookId), { recursive: true, force: true }));
}
export async function renameBook(id, title) {
  const safeBookId = safeId(id);
  return withStoreLock(bookJsonLockKey(safeBookId), async () => {
    const book = await readBook(safeBookId);
    const nextTitle = typeof title === 'string' ? title.trim() : '';
    if (!nextTitle) return book;
    book.title = nextTitle;
    book.titleSource = 'manual';
    await writeBookUnlocked(safeBookId, book);
    return book;
  });
}

// ——— 统一版本读写 ———
// path 形如：'outline' | 'core:world|style|constraints|pacing' | 'section:<sid>:chapter:<cid>'
function versionLockKey(bookId, parsedPath) {
  const safeBookId = safeId(bookId);
  if (parsedPath.type === 'chapter') {
    return chapterFileLockKey(safeBookId, parsedPath.sectionId, parsedPath.chapterId);
  }
  return bookJsonLockKey(safeBookId);
}

export async function versionMove(bookId, path, delta) {
  const p = parseVersionPath(path);
  const safeBookId = safeId(bookId);
  if (p.type === 'chapter') {
    return withChapterWriteLocks(safeBookId, p.sectionId, p.chapterId, async () => {
      await assertChapterReferenced(safeBookId, p.sectionId, p.chapterId);
      const ch = await readChapter(safeBookId, p.sectionId, p.chapterId);
      if (!moveCursor(ch.body, delta)) return ch.body;
      await writeChapterFile(safeBookId, p.sectionId, p.chapterId, ch);
      await touchBookUnlocked(safeBookId);
      return ch.body;
    });
  }
  return withStoreLock(versionLockKey(safeBookId, p), async () => {
    const b = await readBook(safeBookId);
    const vf = p.type === 'outline' ? b.outline : b.settings.core[p.field];
    if (!moveCursor(vf, delta)) return vf;
    await writeBookUnlocked(safeBookId, b);
    return vf;
  });
}
export async function versionSet(bookId, path, text) {
  const p = parseVersionPath(path);
  const safeBookId = safeId(bookId);
  if (p.type === 'chapter') {
    return withChapterWriteLocks(safeBookId, p.sectionId, p.chapterId, async () => {
      await assertChapterReferenced(safeBookId, p.sectionId, p.chapterId);
      const ch = await readChapter(safeBookId, p.sectionId, p.chapterId);
      commitVersion(ch.body, text);
      await writeChapterFile(safeBookId, p.sectionId, p.chapterId, ch);
      await touchBookUnlocked(safeBookId);
      return ch.body;
    });
  }
  return withStoreLock(versionLockKey(safeBookId, p), async () => {
    const b = await readBook(safeBookId);
    const vf = p.type === 'outline' ? b.outline : b.settings.core[p.field];
    commitVersion(vf, text);
    await writeBookUnlocked(safeBookId, b);
    return vf;
  });
}
