import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../index.js';
import * as store from '../store.js';
import {
  characterCraftRevision, generationCharacterCraftRows,
  normalizeCharacterCraft, normalizeCharacterGuideInput,
  normalizeRelationshipGuideInput,
} from '../character-craft-schema.js';
import { buildContext, buildChapterReviewInstruction } from '../prompts.js';
import { cleanupTestTempDirs, makeTestTempDir } from './test-temp-dir.js';
import { startTestServer, stopTestServer } from './http-test-server.js';

const CHARACTER_ID = `charcraft_${'a'.repeat(32)}`;
const RELATIONSHIP_ID = `relcraft_${'b'.repeat(32)}`;
const CHANGE_ID = `relchange_${'c'.repeat(32)}`;

let root;
beforeEach(() => {
  root = makeTestTempDir('novelbox-character-craft-');
  store.setDataRoot(root);
});
afterEach(cleanupTestTempDirs);

function character(overrides = {}) {
  return {
    id: CHARACTER_ID,
    name: '沈砚',
    importance: 5,
    asOfChapter: 8,
    currentDesire: '在妹妹发现真相前拿回密信',
    fear: '被妹妹看见自己曾参与旧案',
    secret: '当年是他亲手调换了证物',
    pressureResponse: '先冷嘲拖延，退路被堵死后会主动承担最危险的部分',
    speechPattern: '句子短，不直接解释关心，总用行动替代道歉',
    speechAvoid: '不讲大道理，不主动说“我是为你好”',
    notes: '',
    ...overrides,
  };
}

function relationship(overrides = {}) {
  return {
    id: RELATIONSHIP_ID,
    from: '沈砚',
    to: '沈青',
    importance: 5,
    asOfChapter: 8,
    temperature: 1,
    surfaceState: '互相讥讽但仍共同查案',
    privateTension: '沈砚因愧疚过度保护，沈青把保护误解为不信任',
    desiredDirection: '密信曝光后先决裂，再由沈砚承担后果重建信任',
    changes: [{ id: CHANGE_ID, chapter: 7, temperature: 1, reason: '沈砚替沈青挡下追杀' }],
    notes: '',
    ...overrides,
  };
}

function stored(entry) {
  return {
    ...entry,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-02T00:00:00.000Z',
  };
}

async function createTarget() {
  const book = await store.createBook({ premise: '人物导演卡测试', title: '旧案' });
  const section = await store.addSection(book.id, { title: '第一部' });
  const chapter = await store.addChapter(book.id, section.id, { title: '第一章' });
  return { book, section, chapter };
}

test('人物导演卡约束驱动力、声音和关系温度变化，不复制空壳档案', () => {
  assert.equal(normalizeCharacterGuideInput(character()).name, '沈砚');
  assert.equal(normalizeRelationshipGuideInput(relationship()).changes[0].chapter, 7);
  assert.throws(
    () => normalizeCharacterGuideInput(character({
      currentDesire: '', fear: '', secret: '', pressureResponse: '',
      speechPattern: '', speechAvoid: '', notes: '',
    })),
    /BAD_CHARACTER_GUIDE/,
  );
  assert.throws(
    () => normalizeRelationshipGuideInput(relationship({ to: '沈砚' })),
    /BAD_RELATIONSHIP_GUIDE/,
  );
  assert.throws(
    () => normalizeRelationshipGuideInput(relationship({ temperature: 6 })),
    /BAD_RELATIONSHIP_GUIDE/,
  );
  assert.throws(
    () => normalizeRelationshipGuideInput(relationship({ temperature: 2 })),
    /BAD_RELATIONSHIP_GUIDE/,
  );
  assert.throws(
    () => normalizeCharacterCraft({
      characters: [stored(character()), stored(character())], relationships: [],
    }),
    /BAD_CHARACTER_CRAFT/,
  );
  assert.match(characterCraftRevision({
    characters: [stored(character())], relationships: [stored(relationship())],
  }), /^[A-Za-z0-9_-]{43}$/);
});

test('相关人物导演卡进入上下文，并把作者秘密与角色知识明确隔离', () => {
  const craft = {
    characters: [
      stored(character()),
      stored(character({
        id: `charcraft_${'d'.repeat(32)}`, name: '远方路人', importance: 1,
        currentDesire: '离开城市', fear: '', secret: '', pressureResponse: '',
        speechPattern: '', speechAvoid: '',
      })),
    ],
    relationships: [stored(relationship())],
  };
  const rows = generationCharacterCraftRows(craft, { relevantText: '沈砚决定寻找沈青' });
  assert.match(rows[0], /沈砚/);
  assert.match(rows.join('\n'), /最近变化=第7章→1/);
  assert.doesNotMatch(rows.join('\n'), /远方路人/);
  assert.match(rows.at(-1), /不相关或较低优先级/);
  const context = buildContext({
    book: { settings: { characterCraft: craft } },
    section: { summary: '沈砚失去密信' },
    chapterPlan: { goal: '沈砚找到沈青' },
  });
  assert.match(context, /人物驱动力与声音/);
  assert.match(context, /作者掌握的秘密/);
  assert.match(context, /不等于读者或任何人物已经知道/);
  const review = buildChapterReviewInstruction({
    chapterIndex: 9, content: '正文', context,
  });
  assert.match(review, /当前欲望、恐惧与受压反应是否真正驱动选择/);
  assert.match(review, /导演卡中的秘密不是正文已揭示事实/);
});

test('人物和关系卡共享作品级乐观修订号，相同输入幂等且旧页面不能覆盖', async () => {
  const { book } = await createTarget();
  const initial = await store.readCharacterCraft(book.id);
  const savedCharacter = await store.saveCharacterGuide(book.id, character(), {
    expectedRevision: initial.revision,
  });
  const same = await store.saveCharacterGuide(book.id, character(), {
    expectedRevision: savedCharacter.revision,
  });
  assert.equal(same.revision, savedCharacter.revision);
  assert.equal(same.entry.updatedAt, savedCharacter.entry.updatedAt);
  await assert.rejects(
    () => store.saveRelationshipGuide(book.id, relationship(), {
      expectedRevision: initial.revision,
    }),
    /CHARACTER_CRAFT_CONFLICT/,
  );
  const savedRelationship = await store.saveRelationshipGuide(book.id, relationship(), {
    expectedRevision: savedCharacter.revision,
  });
  assert.equal(savedRelationship.entry.temperature, 1);
  const removed = await store.deleteCharacterCraftEntry(book.id, CHARACTER_ID, {
    expectedRevision: savedRelationship.revision,
  });
  assert.equal(removed.deletedId, CHARACTER_ID);
  assert.equal((await store.readCharacterCraft(book.id)).relationships.length, 1);
});

test('实际发送的人物导演卡变化更新生成与审稿上下文并拒绝迟到正文', async () => {
  const { book, section, chapter } = await createTarget();
  const generationBefore = await store.readChapterGenerationContext(
    book.id, section.id, chapter.id,
  );
  const reviewBefore = await store.readChapterReviewContext(
    book.id, section.id, chapter.id,
  );
  const craft = await store.readCharacterCraft(book.id);
  await store.saveCharacterGuide(book.id, character(), { expectedRevision: craft.revision });
  const generationAfter = await store.readChapterGenerationContext(
    book.id, section.id, chapter.id,
  );
  const reviewAfter = await store.readChapterReviewContext(
    book.id, section.id, chapter.id,
  );
  assert.notEqual(generationAfter.contextRevision, generationBefore.contextRevision);
  assert.notEqual(reviewAfter.contextRevision, reviewBefore.contextRevision);
  await assert.rejects(
    () => store.commitGeneratedChapter(book.id, section.id, chapter.id, '迟到正文', {
      expectedRevision: generationBefore.targetRevision,
      expectedContextRevision: generationBefore.contextRevision,
      expectedPreviousChapterId: generationBefore.previousChapterId,
      expectedPreviousChapterSectionId: generationBefore.previousChapterSectionId,
    }),
    /GENERATION_CONTEXT_CONFLICT/,
  );
});

test('人物导演卡随书备份，旧备份缺少字段时迁移为空库', async () => {
  const { book } = await createTarget();
  const initial = await store.readCharacterCraft(book.id);
  const first = await store.saveCharacterGuide(book.id, character(), {
    expectedRevision: initial.revision,
  });
  await store.saveRelationshipGuide(book.id, relationship(), {
    expectedRevision: first.revision,
  });
  const backup = await store.createBookBackup(book.id);
  assert.equal(backup.book.settings.characterCraft.characters[0].secret, character().secret);
  const imported = await store.importBookBackup(backup);
  assert.equal((await store.readCharacterCraft(imported.id)).relationships[0].changes.length, 1);

  const legacy = structuredClone(backup);
  delete legacy.book.settings.characterCraft;
  const migrated = await store.importBookBackup(legacy);
  assert.deepEqual(await store.readCharacterCraft(migrated.id), {
    characters: [], relationships: [],
    revision: characterCraftRevision({ characters: [], relationships: [] }),
  });
});

test('人物导演卡 HTTP 独立加载且不膨胀作品树，冲突稳定返回 409', async () => {
  const started = await startTestServer(createApp());
  try {
    const { book } = await createTarget();
    const base = `${started.base}/api/books/${book.id}`;
    const tree = await (await fetch(`${base}/tree`)).json();
    assert.equal(tree.book.settings.characterCraft, undefined);
    const initial = await (await fetch(`${base}/character-craft`)).json();
    const save = (input, revision) => fetch(`${base}/character-craft/characters`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entry: input, expectedRevision: revision }),
    });
    const savedResponse = await save(character(), initial.revision);
    assert.equal(savedResponse.status, 200);
    const stale = await save(character({ currentDesire: '旧页面覆盖' }), initial.revision);
    assert.equal(stale.status, 409);
    assert.deepEqual(await stale.json(), { error: 'CHARACTER_CRAFT_CONFLICT' });
  } finally { await stopTestServer(started.server); }
});
