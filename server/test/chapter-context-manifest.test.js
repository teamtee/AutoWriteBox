import test from 'node:test';
import assert from 'node:assert/strict';

import { buildChapterContextManifest } from '../chapter-context-manifest.js';
import { measureChapterProse } from '../chapter-prose-metrics.js';
import { validWorldBibleFixture } from './section-plan-fixture.js';

function sampleChapter(chars) {
  return '他沿着渠沿走过去，冻土在靴底裂开细缝，掌心发烫。\n'
    .repeat(Math.ceil(chars / 25)).slice(0, chars);
}

function versioned(content) {
  return { versions: [content], cursor: 0 };
}

function fixture() {
  return {
    book: {
      title: '雾站名单', premise: '卧底在封城前寻找证人。',
      outline: versioned('全书大纲'), characters: [{ name: '林越', role: '卧底', desc: '被通缉' }],
      memory: { facts: [] },
      settings: {
        core: {
          world: versioned('封城制度'), style: versioned('克制冷硬'),
          constraints: versioned('不让证人瞬移'), pacing: versioned('每章两次压力变化'),
        },
        storyEngine: {
          readerExperience: '看主角用旧系统反制追捕', protagonistAction: '调查并冒险潜入',
          progression: '取得证据', cost: '暴露身份', escalation: '从个人追捕升级为城际阴谋',
        },
        promiseLedger: { entries: [] }, characterCraft: { characters: [], relationships: [] },
      },
    },
    section: {
      id: 'section-1', outline: { content: '车站封锁篇' }, summary: '主角已进入车站。',
      characters: [{ name: '旧友', role: '守卫', desc: '负责核验身份' }],
    },
    chapter: {
      index: 8, body: versioned(''),
      plan: {
        goal: '找到证人', obstacle: '旧友核验身份', choice: '公开假身份',
        payoff: '证人现身', hook: '车票写着真名',
        tensionArc: '受阻→希望→反制→选择',
        foreshadowing: '车票推进内鬼线', worldExpansion: '城外印章证明跨区',
        scenes: [{
          title: '封锁线', desire: '进站', obstacle: '核验', action: '公开身份',
          turn: '证人现身', cost: '遭到通缉',
        }],
      },
    },
    previousChapter: {
      id: 'chapter-7', body: versioned(`早期正文${'中'.repeat(3000)}上一章结尾事实`),
      progress: '连夜去车站', characters: [{ name: '林越', role: '卧底', desc: '受伤' }],
      handoff: {
        viewpoint: '林越', time: '当夜', location: '旧站台', ongoingAction: '正赶往闸机',
        immediatePressure: '封锁即将合拢', characterState: '左臂受伤', resourceState: '假证仍可用',
        knowledgeBoundary: '不知证人具体站台', unresolvedCausality: '封锁将迫使他使用假证',
      },
    },
    bookChapterIndex: 8,
    recentReviewSignals: [{ signals: {
      chapterFunction: '推进', conflictType: '追逐', emotionTone: '紧张',
      payoffType: '脱险', dominantMode: '行动',
    } }],
    writingAssetContext: { text: '【已绑定创作资产】句式克制', assetIds: ['asset-1'] },
  };
}

function byId(manifest, id) {
  return manifest.layers.flatMap((layer) => layer.items).find((entry) => entry.id === id);
}

function denseMemoryFacts(count, subjectFor = (index) => `遗物${index}`) {
  return Array.from({ length: count }, (_, index) => ({
    id: `memory_${index.toString(16).padStart(32, '0')}`,
    kind: 'item', subject: subjectFor(index), predicate: `状态${index}`,
    object: `由旧王庭第${index}位守门人保管${'旧'.repeat(70)}`,
    importance: index ? 5 : 1, status: 'active', source: { chapterIndex: index + 1 },
    updatedAt: new Date(Date.UTC(2026, 0, (index % 28) + 1)).toISOString(),
  }));
}

test('上下文清单按四层报告实际裁剪后的材料，不返回正文或秘密原文', () => {
  const manifest = buildChapterContextManifest(fixture());
  assert.deepEqual(manifest.layers.map((layer) => layer.id), [
    'facts', 'plans', 'debts', 'expression',
  ]);
  assert.equal(byId(manifest, 'previous-ending').status, 'included');
  assert.equal(byId(manifest, 'previous-handoff').status, 'included');
  assert.ok(byId(manifest, 'previous-ending').characters > 0);
  assert.equal(byId(manifest, 'chapter-plan').count, 8);
  assert.equal(byId(manifest, 'scene-chain').count, 1);
  assert.equal(byId(manifest, 'writing-assets').count, 1);
  assert.match(byId(manifest, 'style').note, /文风圣经栏目 0\/10/);
  assert.equal(byId(manifest, 'current-body').status, 'not-applicable');
  assert.equal(byId(manifest, 'quality-rules').characters, 0);
  assert.equal(JSON.stringify(manifest).includes('上一章结尾事实'), false);
  assert.equal(JSON.stringify(manifest).includes('车票推进内鬼线'), false);
});

test('旧章节缺少场景交接快照时保留原文承接并提示重算', () => {
  const input = fixture();
  delete input.previousChapter.handoff;
  const manifest = buildChapterContextManifest(input);
  assert.equal(byId(manifest, 'previous-ending').status, 'included');
  assert.equal(byId(manifest, 'previous-handoff').status, 'missing');
  assert.ok(manifest.warnings.some((entry) =>
    entry.id === 'missing-previous-handoff' && entry.severity === 'advisory'));
});

test('上下文体检显示当前本部世界合同和作者已确认的层级进度', () => {
  const input = fixture();
  input.book.settings.core.world = versioned(validWorldBibleFixture());
  input.section.outline.content = [
    '【世界层级】当前生活圈',
    '【世界阶段承诺】第1层承诺通过人物选择兑现',
    '【可验证世界证据】第1层现场物证可被人物核验',
    '【人物行动】主角主动追查第1层现场物证',
    '【世界选择与代价】主角保住证据并失去第1层容身处',
    '【阶段认知增量】读者确认第1层规则的社会影响',
    '【本部保留未知】暂不揭示第1层幕后者真实身份',
    '【下一层门槛】必须用正文行动完成第1层进入门槛',
    '【门槛结果】本部完成门槛，下部进入下一层',
    '【门槛证据进度】主角正在核验第一份现场物证',
  ].join('\n');
  input.book.settings.worldProgressState = { gates: [{
    id: `world_gate_${'a'.repeat(32)}`,
    fromLayer: '当前生活圈', toLayer: '中期势力与地域',
    gateCondition: '必须用正文行动完成第1层进入门槛',
    summary: '主角已经用两地物证完成交叉核验',
    evidence: '两份盖章记录的编号完全一致',
    source: {
      sectionId: 'section-1', chapterId: 'chapter-7', bodyFingerprint: 'B'.repeat(43),
    },
    status: 'active', confirmedAt: '2026-08-12T00:00:00.000Z',
  }] };
  const manifest = buildChapterContextManifest(input);
  assert.equal(byId(manifest, 'confirmed-world-progress').count, 1);
  assert.match(byId(manifest, 'confirmed-world-progress').note, /中期势力与地域/);
  assert.equal(byId(manifest, 'section-world-contract').status, 'included');
  assert.match(byId(manifest, 'section-world-contract').note, /当前层：当前生活圈/);
  assert.equal(JSON.stringify(manifest).includes('暂不揭示第1层幕后者真实身份'), false);
});

test('简略文风草稿仍会进入 API，但上下文体检提示重构文风圣经', () => {
  const manifest = buildChapterContextManifest(fixture());
  assert.equal(byId(manifest, 'style').status, 'included');
  assert.ok(manifest.warnings.some((entry) => entry.id === 'thin-style-bible'
    && entry.severity === 'advisory'));
  assert.ok(manifest.warnings.some((entry) => entry.id === 'legacy-plan-quality-contract'
    && entry.severity === 'advisory'));
});

test('v2 章节合同的空泛字段成为生成风险并提示升级 v3', () => {
  const input = fixture();
  input.chapter.plan.qualityProtocolVersion = 2;
  const manifest = buildChapterContextManifest(input);
  for (const id of [
    'invalid-tension-contract', 'invalid-foreshadowing-contract',
    'invalid-world-expansion-contract',
  ]) assert.ok(manifest.warnings.some((entry) => entry.id === id
    && entry.severity === 'risk'));
  assert.ok(manifest.warnings.some((entry) =>
    entry.id === 'legacy-plan-quality-contract' && entry.severity === 'advisory'));
});

test('进入兑现窗口的账本债务必须在策划中用稳定 ID 安排推进、兑现或延期', () => {
  const input = fixture();
  const debtId = `promise_${'a'.repeat(32)}`;
  input.book.settings.promiseLedger.entries = [{
    id: debtId, kind: 'mystery', status: 'open', importance: 5,
    promise: '车票真名属于谁', introducedChapter: 2,
    expectedStartChapter: 7, expectedEndChapter: 8, progress: [],
    resolution: '', resolvedChapter: null, nextPromise: '', notes: '',
    createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-02T00:00:00.000Z',
  }];
  let manifest = buildChapterContextManifest(input);
  assert.ok(manifest.warnings.some((entry) =>
    entry.id === 'unaddressed-urgent-reading-debt' && entry.severity === 'risk'));

  input.chapter.plan.foreshadowing = `[推进债务:${debtId}] 推进车票真名旧线`;
  manifest = buildChapterContextManifest(input);
  assert.equal(manifest.warnings.some((entry) =>
    entry.id === 'unaddressed-urgent-reading-debt'), false);

  input.chapter.plan.foreshadowing = `[建立承诺:${debtId}] 错把已建立债务当新线`;
  manifest = buildChapterContextManifest(input);
  assert.ok(manifest.warnings.some((entry) =>
    entry.id === 'invalid-reading-debt-reference' && entry.severity === 'risk'));
});

test('清单区分完整上一章、超长章末尾窗口和审稿重写的当前正文', () => {
  const input = fixture();
  input.previousChapter.body = versioned('完整短章');
  input.chapter.body = versioned('当前待审正文');
  const full = buildChapterContextManifest(input);
  assert.equal(byId(full, 'previous-ending').truncated, false);
  assert.match(byId(full, 'previous-ending').note, /正文完整携带/);
  assert.equal(byId(full, 'current-body').status, 'included');
  assert.equal(byId(full, 'current-body').characters, 6);

  input.previousChapter.body = versioned('超长'.repeat(10_000));
  const windowed = buildChapterContextManifest(input);
  assert.equal(byId(windowed, 'previous-ending').truncated, true);
  assert.ok(windowed.truncatedItems.includes('previous-ending'));
  assert.ok(windowed.warnings.some((entry) => entry.id === 'context-truncated'));
});

test('缺少上一章、张力、埋点、世界边界和风格锚点时给出可区分风险与建议', () => {
  const input = fixture();
  input.previousChapter = null;
  input.chapter.plan.tensionArc = '';
  input.chapter.plan.foreshadowing = '';
  input.chapter.plan.worldExpansion = '';
  input.book.settings.core.style = versioned('');
  input.writingAssetContext = { text: '', assetIds: [] };
  const manifest = buildChapterContextManifest(input);
  assert.equal(manifest.riskCount, 1);
  assert.ok(manifest.warnings.some((entry) => entry.id === 'missing-previous-ending'
    && entry.severity === 'risk'));
  for (const id of [
    'missing-tension-arc', 'missing-foreshadowing', 'missing-world-expansion',
    'missing-style-anchor',
  ]) assert.ok(manifest.warnings.some((entry) => entry.id === id));
});

test('上下文体检区分旧场景无承接与新场景部分断链', () => {
  const input = fixture();
  assert.ok(buildChapterContextManifest(input).warnings.some((entry) =>
    entry.id === 'missing-scene-linkage' && entry.severity === 'advisory'));
  input.chapter.plan.scenes = [
    { ...input.chapter.plan.scenes[0], trigger: '承接上一章求救' },
    { ...input.chapter.plan.scenes[0], title: '第二场', trigger: '' },
  ];
  const partial = buildChapterContextManifest(input);
  assert.ok(partial.warnings.some((entry) =>
    entry.id === 'incomplete-scene-linkage' && entry.severity === 'risk'));
  assert.match(byId(partial, 'scene-chain').note, /承接触发 1\/2 场/);
});

test('上下文体检报告本章直接命中的长期记忆及预算省略数量', () => {
  const input = fixture();
  input.book.memory.facts = denseMemoryFacts(150);
  input.book.memory.facts[0].subject = '沉星钥匙';
  input.book.memory.facts[0].object = '只能开启一次北境星门';
  input.book.memory.facts[0].updatedAt = '2001-01-01T00:00:00.000Z';
  input.chapter.plan.goal = '夺回沉星钥匙';

  const manifest = buildChapterContextManifest(input);
  const memory = byId(manifest, 'confirmed-memory');
  assert.equal(memory.truncated, true);
  assert.match(memory.note, /本次任务直接命中 1\/1 项/);
  assert.match(memory.note, /因预算未装入/);
  assert.ok(memory.count < 150);
});

test('本章点名事实过多而无法全部装入时标记生成风险', () => {
  const input = fixture();
  input.book.memory.facts = denseMemoryFacts(160, () => '沉星钥匙');
  input.chapter.plan.goal = '核对沉星钥匙的全部历史状态';

  const manifest = buildChapterContextManifest(input);
  assert.ok(manifest.warnings.some((entry) =>
    entry.id === 'task-memory-truncated' && entry.severity === 'risk'));
  assert.match(byId(manifest, 'confirmed-memory').note, /本次任务直接命中 \d+\/160 项/);
});

test('上下文体检把连续节奏同构显示为可解释风险', () => {
  const input = fixture();
  const rhythmFingerprint = {
    pressurePattern: 'false-relief', resolutionMethod: 'sacrifice',
    payoffScale: 'chapter', hookMechanism: 'new-threat', costType: 'relationship',
  };
  input.recentReviewSignals = [5, 6, 7].map((bookChapterIndex) => ({
    bookChapterIndex,
    signals: {
      chapterFunction: '转折', conflictType: '追捕', emotionTone: '紧张',
      payoffType: '脱险', dominantMode: '行动', rhythmFingerprint,
    },
  }));
  const manifest = buildChapterContextManifest(input);
  assert.match(byId(manifest, 'recent-rhythm').note, /受控指纹 3 章/);
  assert.ok(manifest.warnings.some((entry) =>
    entry.id === 'rhythm-resolutionMethod-streak'
      && entry.severity === 'risk' && /主动牺牲/.test(entry.message)));
});

test('上下文体检返回每层需求、实发、保底和全局预算余额', () => {
  const manifest = buildChapterContextManifest(fixture());
  assert.equal(manifest.budget.ceiling, 500_000);
  assert.ok(manifest.budget.fixedOverheadCharacters > 0);
  assert.ok(manifest.budget.assignableCharacters < manifest.budget.ceiling);
  assert.ok(manifest.budget.remainingCharacters >= 0);
  const previous = manifest.budget.layers.find((entry) => entry.id === 'prevEnding');
  assert.ok(previous);
  assert.ok(previous.want > 0);
  assert.equal(previous.truncated, false);
  assert.equal(previous.characters, previous.want);
});

test('上下文体检按当前模型登记窗口显示实际预算，而不是固定显示 50 万', () => {
  const input = fixture();
  input.chapter.body = versioned('当前重写稿'.repeat(10000));
  const manifest = buildChapterContextManifest({ ...input, modelContextChars: 32000 });
  assert.equal(manifest.budget.ceiling, 32000);
  assert.equal(manifest.budget.assignableCharacters, 8000);
  assert.ok(manifest.budget.layers.some((entry) => entry.truncated));
});

test('空章尚无正文时只报告跨章趋势，不产生本章配额未达标项', () => {
  const input = fixture();
  input.recentReviewSignals = [
    { bookChapterIndex: 6, prose: measureChapterProse(sampleChapter(4_000)) },
    { bookChapterIndex: 7, prose: measureChapterProse(sampleChapter(2_000)) },
  ];
  const manifest = buildChapterContextManifest(input);
  assert.equal(manifest.prose.current, null);
  assert.equal(manifest.prose.reference, null);
  assert.equal(manifest.prose.trend.measuredCount, 2);
  assert.match(byId(manifest, 'prose-reference').note, /本章尚无正文/);
  assert.match(byId(manifest, 'prose-trend').note, /已统计 2 章/);
});

test('单章低于参考值只展示数字，跨章持续下滑才提示作者', () => {
  const input = fixture();
  input.chapter.body = versioned(sampleChapter(1_400));
  input.recentReviewSignals = [
    { bookChapterIndex: 5, prose: measureChapterProse(sampleChapter(2_400)) },
    { bookChapterIndex: 6, prose: measureChapterProse(sampleChapter(2_000)) },
    { bookChapterIndex: 7, prose: measureChapterProse(sampleChapter(1_800)) },
  ];
  const manifest = buildChapterContextManifest(input);
  const body = manifest.prose.reference.find((row) => row.id === 'body-length');
  assert.equal(body.belowReference, true);
  // 单章低于参考值不制造告警：一章写得短可以是正确选择。
  assert.equal(manifest.warnings.some((entry) =>
    entry.id.startsWith('prose-quota') || entry.id === 'prose-reference'), false);
  assert.ok(manifest.warnings.some((entry) =>
    entry.id === 'prose-trend-body-length-decline'));
  assert.ok(manifest.warnings.some((entry) =>
    entry.id === 'prose-trend-body-length-below-quota-streak'));
  assert.match(byId(manifest, 'prose-reference').note, /当前正文 \d+ 字符，\d\/3 项低于经验参考值/);
  // 统计只回传数量，不回传正文原文。
  assert.equal(JSON.stringify(manifest.prose).includes('冻土'), false);
});
