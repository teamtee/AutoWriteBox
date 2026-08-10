import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { open, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  indexBookBackupJson, openIndexedBookBackup, projectTopLevelJsonFromHandle,
} from '../backup-json.js';
import { MAX_SECTION_CHAPTERS } from '../limits.js';
import { cleanupTestTempDirs, makeTestTempDir } from './test-temp-dir.js';

afterEach(cleanupTestTempDirs);

const storeFingerprint = (text) =>
  createHash('sha256').update(text, 'utf8').digest('base64url');

function snapshot() {
  const versioned = { versions: [''], cursor: 0 };
  return {
    // 故意把 sections 放在 book/format 前，验证不依赖字段顺序。
    sections: [{
      chapters: [{
        id: 'chapter-01', index: 1, title: '引号“\\\"”、反斜杠\\、括号{}',
        titleSource: 'manual', body: { versions: ['中文\n第二行'], cursor: 0 },
        content: '中文\n第二行', characters: [], summary: '', progress: '', status: 'done',
      }],
      section: {
        id: 'section-01', index: 1, title: '一', titleSource: 'manual',
        outline: { content: '', history: [] }, characters: [], summary: '', progress: '',
        chapters: ['chapter-01'], chapterSummaries: {},
      },
    }],
    version: 1,
    exportedAt: '2026-08-05T00:00:00.000Z',
    book: {
      id: 'book-old', title: '测试', titleSource: 'manual', premise: 'p',
      createdAt: '2026-08-05T00:00:00.000Z', updatedAt: '2026-08-05T00:00:00.000Z',
      outline: versioned,
      settings: { core: {
        world: versioned, style: versioned, constraints: versioned, pacing: versioned,
      }, history: [] },
      characters: [], summary: '', progress: '', sections: ['section-01'],
    },
    format: 'auto-novel-box-book-backup',
  };
}

test('流式索引在极小分块下跨边界识别 BOM、Unicode、转义和重排字段', async () => {
  const root = makeTestTempDir('novelbox-backup-json-');
  const path = join(root, 'backup.json');
  const expected = snapshot();
  await writeFile(path, `\uFEFF${JSON.stringify(expected, null, 2)}`);

  const reader = await openIndexedBookBackup(path, { highWaterMark: 4 });
  try {
    assert.equal(await reader.read(reader.index.top.format), expected.format);
    assert.equal(await reader.read(reader.index.top.version), 1);
    assert.deepEqual(await reader.read(reader.index.top.book), expected.book);
    assert.equal(reader.index.bundles.length, 1);
    assert.deepEqual(await reader.read(reader.index.bundles[0].section), expected.sections[0].section);
    assert.deepEqual(await reader.read(reader.index.bundles[0].chapters[0]), expected.sections[0].chapters[0]);
  } finally {
    await reader.close();
  }
});

test('顶层投影严格扫描完整 JSON 但只保留受限字符串和引用数组', async () => {
  const root = makeTestTempDir('novelbox-json-projection-');
  const path = join(root, 'stored.json');
  const source = {
    ignored: { history: ['x'.repeat(4 * 1024)], nested: { value: true } },
    sections: ['section-01', 'section-02'],
    title: '跨块“标题”\\',
    updatedAt: '2026-08-07T00:00:00.000Z',
  };
  await writeFile(path, JSON.stringify(source));
  const handle = await open(path, 'r');
  try {
    const projected = await projectTopLevelJsonFromHandle(path, handle, {
      title: { type: 'string', maxBytes: 256 },
      updatedAt: { type: 'string', maxBytes: 256 },
      sections: { type: 'stringArray', maxItems: 2, itemMaxBytes: 64 },
    }, { highWaterMark: 4, maxBytes: 1024 * 1024, allowBom: false });
    assert.deepEqual(projected, {
      sections: source.sections,
      title: source.title,
      updatedAt: source.updatedAt,
    });
  } finally {
    await handle.close();
  }

  await writeFile(path, `${JSON.stringify(source)} trailing`);
  const damagedHandle = await open(path, 'r');
  try {
    await assert.rejects(
      () => projectTopLevelJsonFromHandle(path, damagedHandle, {
        title: { type: 'string', maxBytes: 256 },
      }, { highWaterMark: 4, maxBytes: 1024 * 1024, allowBom: false }),
      /BACKUP_INVALID_JSON/,
    );
  } finally {
    await damagedHandle.close();
  }
});

test('顶层投影验证版本正文并只保留当前版是否非空', async () => {
  const root = makeTestTempDir('novelbox-versioned-projection-');
  const path = join(root, 'stored.json');
  const specification = {
    body: {
      type: 'versionedTextPresence',
      maxItems: 3,
      itemMaxBytes: 128,
      itemMaxChars: 10,
    },
  };
  const project = async (source) => {
    await writeFile(path, JSON.stringify(source));
    const handle = await open(path, 'r');
    try {
      return await projectTopLevelJsonFromHandle(
        path, handle, specification,
        { highWaterMark: 4, maxBytes: 1024 * 1024, allowBom: false },
      );
    } finally {
      await handle.close();
    }
  };

  // cursor 故意放在 versions 前，验证字段顺序不影响结果。
  assert.deepEqual(await project({
    ignored: { history: ['不应保留'] },
    body: { cursor: 1, extension: true, versions: ['正文', ' \n\t'] },
  }), { body: false });
  assert.deepEqual(await project({
    body: { versions: ['正文', ' \n\t'], cursor: 0 },
  }), { body: true });

  const invalidBodies = [
    { versions: [], cursor: 0 },
    { versions: ['a'], cursor: 1 },
    { versions: ['a'], cursor: 0.5 },
    { versions: ['a', 'b', 'c', 'd'], cursor: 0 },
    { versions: ['12345678901'], cursor: 0 },
    { versions: [1], cursor: 0 },
  ];
  for (const body of invalidBodies) {
    await assert.rejects(() => project({ body }), /BACKUP_INVALID/);
  }
  await assert.rejects(() => project({ body: '旧版正文' }), /BACKUP_INVALID/);
});

test('顶层投影计算当前正文字数并验证发布快照指纹', async () => {
  const root = makeTestTempDir('novelbox-publication-projection-');
  const path = join(root, 'stored.json');
  const content = '正 文\n😀';
  const bodyFingerprint = storeFingerprint(content);
  const specification = {
    body: {
      type: 'versionedTextStats', maxItems: 3, itemMaxBytes: 256, itemMaxChars: 20,
    },
    published: {
      type: 'publishedChapterSummary',
      contentMaxBytes: 256, contentMaxChars: 20,
      fingerprintMaxBytes: 64, publishedAtMaxBytes: 128,
    },
  };
  const project = async (source) => {
    await writeFile(path, JSON.stringify(source));
    const handle = await open(path, 'r');
    try {
      return await projectTopLevelJsonFromHandle(path, handle, specification, {
        highWaterMark: 4, maxBytes: 1024 * 1024, allowBom: false,
      });
    } finally { await handle.close(); }
  };

  const published = {
    content,
    bodyFingerprint,
    publishedAt: '2026-08-10T01:02:03.000Z',
    publicationNumber: 2,
  };
  assert.deepEqual(await project({
    body: { versions: ['旧稿', content], cursor: 1 }, published,
  }), {
    body: { hasContent: true, characterCount: 3, fingerprint: bodyFingerprint },
    published: {
      bodyFingerprint, publishedAt: published.publishedAt,
      publicationNumber: 2, characterCount: 3,
    },
  });
  await assert.rejects(() => project({
    body: { versions: [content], cursor: 0 },
    published: { ...published, bodyFingerprint: 'x'.repeat(43) },
  }), /BACKUP_INVALID/);
  await assert.rejects(() => project({
    body: { versions: [content], cursor: 0 },
    published: { ...published, publicationNumber: 0 },
  }), /BACKUP_INVALID/);
});

test('备份索引和随机读取都不跟随最终路径的符号链接', {
  skip: process.platform === 'win32',
}, async () => {
  const root = makeTestTempDir('novelbox-backup-json-link-');
  const target = join(root, 'real.json');
  const linked = join(root, 'linked.json');
  await writeFile(target, JSON.stringify(snapshot()));
  await symlink(target, linked, 'file');

  await assert.rejects(() => indexBookBackupJson(linked), /BACKUP_INVALID/);
  await assert.rejects(() => openIndexedBookBackup(linked), /BACKUP_INVALID/);
});

test('流式索引拒绝 JSON 语法损坏、重复键和尾随内容', async () => {
  const root = makeTestTempDir('novelbox-backup-json-bad-');
  const cases = [
    '{"format":"x",}',
    '{"format":"x" "version":1}',
    '{"format":"x","version":01}',
    '{"format":"x","format":"y"}',
    '{"format":"unterminated}',
    '{} trailing',
  ];
  for (let index = 0; index < cases.length; index += 1) {
    const path = join(root, `${index}.json`);
    await writeFile(path, cases[index]);
    await assert.rejects(() => indexBookBackupJson(path, { highWaterMark: 4 }), /BACKUP_INVALID_JSON/);
  }
});

test('流式索引拒绝字符串中会被静默替换的非法 UTF-8', async () => {
  const root = makeTestTempDir('novelbox-backup-json-utf8-');
  const path = join(root, 'invalid-utf8.json');
  const raw = Buffer.from(JSON.stringify(snapshot()));
  const titleOffset = raw.indexOf(Buffer.from('测试'));
  assert.ok(titleOffset >= 0);
  raw[titleOffset] = 0xff;
  await writeFile(path, raw);

  await assert.rejects(
    () => indexBookBackupJson(path, { highWaterMark: 4 }),
    /BACKUP_INVALID_JSON/,
  );
});

test('流式索引在已打开句柄上持续执行总字节上限', async () => {
  const root = makeTestTempDir('novelbox-backup-json-size-');
  const path = join(root, 'backup.json');
  const raw = JSON.stringify(snapshot());
  await writeFile(path, raw);

  await assert.rejects(
    () => indexBookBackupJson(path, {
      highWaterMark: 7,
      maxBytes: Buffer.byteLength(raw) - 1,
    }),
    /STORAGE_FILE_TOO_LARGE/,
  );
  await assert.doesNotReject(
    () => indexBookBackupJson(path, {
      highWaterMark: 7,
      maxBytes: Buffer.byteLength(raw),
    }),
  );
});

test('流式索引对语法正确但缺少备份必需字段的输入返回结构错误', async () => {
  const root = makeTestTempDir('novelbox-backup-json-shape-');
  const path = join(root, 'backup.json');
  await writeFile(path, JSON.stringify({ format: 'auto-novel-box-book-backup', version: 1, book: {} }));

  await assert.rejects(() => indexBookBackupJson(path), /BACKUP_INVALID/);
});

test('流式索引限制单个对象的键基数但允许合法的万章摘要映射', async () => {
  const root = makeTestTempDir('novelbox-backup-json-keys-');
  const acceptedPath = join(root, 'accepted.json');
  const accepted = snapshot();
  accepted.sections[0].section.chapterSummaries = Object.fromEntries(
    Array.from({ length: MAX_SECTION_CHAPTERS }, (_, index) => [
      `chapter-${index}`, { index: index + 1, summary: '摘要' },
    ]),
  );
  await writeFile(acceptedPath, JSON.stringify(accepted));
  await assert.doesNotReject(() => indexBookBackupJson(acceptedPath));

  const rejectedPath = join(root, 'rejected.json');
  const rejected = snapshot();
  rejected.book.extension = Object.fromEntries(
    Array.from({ length: MAX_SECTION_CHAPTERS + 1 }, (_, index) => [`key-${index}`, index]),
  );
  await writeFile(rejectedPath, JSON.stringify(rejected));
  await assert.rejects(() => indexBookBackupJson(rejectedPath), /BACKUP_INVALID/);

  const nestedPath = join(root, 'nested-active-overflow.json');
  const nested = snapshot();
  nested.book.extension = Object.fromEntries(
    Array.from({ length: MAX_SECTION_CHAPTERS }, (_, index) => [`outer-${index}`, index]),
  );
  nested.book.extension[`outer-${MAX_SECTION_CHAPTERS - 1}`] = Object.fromEntries(
    Array.from({ length: MAX_SECTION_CHAPTERS }, (_, index) => [`inner-${index}`, index]),
  );
  await writeFile(nestedPath, JSON.stringify(nested));
  await assert.rejects(() => indexBookBackupJson(nestedPath), /BACKUP_INVALID/);
});

test('流式索引和随机读取响应客户端取消并关闭文件', async () => {
  const root = makeTestTempDir('novelbox-backup-json-abort-');
  const path = join(root, 'backup.json');
  await writeFile(path, JSON.stringify(snapshot()));

  const indexingAbort = new AbortController();
  indexingAbort.abort(new Error('CLIENT_ABORTED'));
  await assert.rejects(
    () => indexBookBackupJson(path, { signal: indexingAbort.signal }),
    /CLIENT_ABORTED/,
  );

  let abortChecks = 0;
  const midIndexAbort = {
    get aborted() {
      abortChecks += 1;
      return abortChecks >= 3;
    },
    reason: new Error('CLIENT_ABORTED'),
  };
  await assert.rejects(
    () => indexBookBackupJson(path, { highWaterMark: 4, signal: midIndexAbort }),
    /CLIENT_ABORTED/,
  );
  assert.ok(abortChecks >= 3);

  const readingAbort = new AbortController();
  const reader = await openIndexedBookBackup(path, { signal: readingAbort.signal });
  readingAbort.abort(new Error('CLIENT_ABORTED'));
  await assert.rejects(() => reader.read(reader.index.top.book), /CLIENT_ABORTED/);
  await reader.close();
});

test('流式索引不接受原生 JSON.parse 拒绝的单字节变异', async () => {
  const root = makeTestTempDir('novelbox-backup-json-fuzz-');
  const path = join(root, 'mutated.json');
  const original = JSON.stringify(snapshot());
  const replacements = ['{', '}', '[', ']', ',', ':', '"', '\\', 'x', '0', ' ', '\n'];
  let seed = 0x5eed1234;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / (2 ** 32);
  };
  let invalidCases = 0;
  for (let index = 0; index < 120; index += 1) {
    const position = Math.floor(random() * original.length);
    const replacement = replacements[Math.floor(random() * replacements.length)];
    const operation = index % 3;
    const candidate = operation === 0
      ? original.slice(0, position) + original.slice(position + 1)
      : operation === 1
        ? original.slice(0, position) + replacement + original.slice(position)
        : original.slice(0, position) + replacement + original.slice(position + 1);
    try {
      JSON.parse(candidate);
    } catch {
      invalidCases += 1;
      await writeFile(path, candidate);
      await assert.rejects(() => indexBookBackupJson(path, { highWaterMark: 5 }));
    }
  }
  assert.ok(invalidCases >= 40, `expected enough invalid mutations, got ${invalidCases}`);
});
