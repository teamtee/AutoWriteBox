import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseVersionPath } from '../store.js';
import {
  commitVersion, currentText, emptyVersioned, migrateVersioned, moveCursor,
} from '../store/versioned.js';

test('emptyVersioned/currentText', () => {
  const v = emptyVersioned();
  assert.deepEqual(v, { versions: [''], cursor: 0 });
  assert.equal(currentText(v), '');
  assert.equal(currentText({ versions: ['a', 'b'], cursor: 1 }), 'b');
});

test('commitVersion 追加并指向末尾', () => {
  const v = { versions: ['a'], cursor: 0 };
  commitVersion(v, 'b');
  assert.deepEqual(v, { versions: ['a', 'b'], cursor: 1 });
});

test('commitVersion 超 20 上限从头裁剪并收敛 cursor', () => {
  const v = { versions: Array.from({ length: 20 }, (_, i) => String(i)), cursor: 0 };
  commitVersion(v, 'new');
  assert.equal(v.versions.length, 20);
  assert.equal(v.versions[19], 'new');
  assert.equal(v.versions[0], '1');       // 原 '0' 被 shift
  assert.equal(v.cursor, 19);
});

test('moveCursor 边界', () => {
  const v = { versions: ['a', 'b', 'c'], cursor: 1 };
  assert.equal(moveCursor(v, -1), true); assert.equal(v.cursor, 0);
  assert.equal(moveCursor(v, -1), false); assert.equal(v.cursor, 0);
  v.cursor = 2;
  assert.equal(moveCursor(v, 1), false); assert.equal(v.cursor, 2);
});

test('migrateVersioned 各形态', () => {
  assert.deepEqual(migrateVersioned({ versions: ['x'], cursor: 0 }), { versions: ['x'], cursor: 0 });
  assert.deepEqual(migrateVersioned('str'), { versions: ['str'], cursor: 0 });
  assert.deepEqual(migrateVersioned({ content: 'cur', history: ['h1', 'h2'] }),
    { versions: ['h1', 'h2', 'cur'], cursor: 2 });
  assert.deepEqual(migrateVersioned({ content: '', history: [] }), { versions: [''], cursor: 0 });
  assert.deepEqual(migrateVersioned(null), { versions: [''], cursor: 0 });
  assert.deepEqual(migrateVersioned(undefined), { versions: [''], cursor: 0 });
});

test('migrateVersioned 将旧 history 与已落盘的已知 21 版溢出收敛到最新 20 版', () => {
  const history = Array.from({ length: 20 }, (_, index) => `历史-${index}`);
  const expected = { versions: [...history.slice(1), '当前'], cursor: 19 };

  assert.deepEqual(migrateVersioned({ content: '当前', history }), expected);
  assert.deepEqual(migrateVersioned({
    versions: [...history, '当前'], cursor: 20,
  }), expected);

  // 不是旧迁移器能够产生的形态，不静默修补，后续严格存储校验仍会报警。
  const unknownOverflow = { versions: [...history, '当前'], cursor: 0 };
  assert.equal(migrateVersioned(unknownOverflow), unknownOverflow);
});

test('parseVersionPath 白名单', () => {
  assert.deepEqual(parseVersionPath('outline'), { type: 'outline' });
  assert.deepEqual(parseVersionPath('core:world'), { type: 'core', field: 'world' });
  assert.deepEqual(parseVersionPath('section:section-01:chapter:chapter-02'),
    { type: 'chapter', sectionId: 'section-01', chapterId: 'chapter-02' });
  assert.throws(() => parseVersionPath('core:evil'), /BAD_PATH/);
  assert.throws(() => parseVersionPath('nope'), /BAD_PATH/);
  assert.throws(() => parseVersionPath('section:../x:chapter:y'), /BAD_ID|BAD_PATH/);
  assert.throws(() => parseVersionPath(123), /BAD_PATH/);
});
