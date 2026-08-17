import test from 'node:test';
import assert from 'node:assert/strict';

import {
  assertGeneratedWorldBible, MIN_GENERATED_WORLD_BIBLE_CHARS,
  WORLD_APPEAL_SCENE_FIELDS, WORLD_APPEAL_SCENE_LABELS,
  WORLD_BIBLE_SECTION_LABELS, WORLD_KNOWLEDGE_BOUNDARY_LABELS,
  WORLD_REVEAL_STAGE_FIELDS, WORLD_REVEAL_STAGE_LABELS,
  worldBibleDiagnostics, worldRevealRoute,
} from '../world-bible.js';

function completeWorldBible() {
  return WORLD_BIBLE_SECTION_LABELS.map((label, index) => {
    const content = label === '持续看点与标志性场面'
      ? WORLD_APPEAL_SCENE_LABELS.map((scene, sceneIndex) =>
        `〔${scene}〕${WORLD_APPEAL_SCENE_FIELDS.map((field) =>
          `${field}：${sceneIndex + 1}号人物必须现场作出不同选择`).join('；')}`).join('\n')
      : label === '秘密分层与认知边界'
        ? WORLD_KNOWLEDGE_BOUNDARY_LABELS.map((boundary, boundaryIndex) =>
          `〔${boundary}〕${boundaryIndex + 1}号认知只在对应阶段通过证据验证`).join('\n')
        : label === '分阶段揭示路线'
          ? WORLD_REVEAL_STAGE_LABELS.map((stage, stageIndex) =>
            `〔${stage}〕${WORLD_REVEAL_STAGE_FIELDS.map((field) =>
              `${field}：${stageIndex + 1}号证据迫使人物行动并承担不同代价`).join('；')}`).join('\n')
          : `${index + 1}号规则改变人物日常、利益和选择代价。`.repeat(8);
    return `【${label}】\n${content}`;
  })
    .join('\n');
}

test('完整世界圣经必须达到最低长度并填满十二个结构栏目', () => {
  const source = completeWorldBible();
  assert.ok(source.length >= MIN_GENERATED_WORLD_BIBLE_CHARS);
  assert.deepEqual(worldBibleDiagnostics(source), {
    valid: true,
    characters: source.length,
    sectionCount: 12,
    missingSections: [],
    thinSections: [],
    issues: [],
    malformed: false,
  });
  assert.doesNotThrow(() => assertGeneratedWorldBible(source));
});

test('简短、漏栏、空栏的世界观仍会落盘，只有格式损坏才拒绝', () => {
  const short = WORLD_BIBLE_SECTION_LABELS.map((label) => `【${label}】\n有`).join('\n');
  const diagnostics = worldBibleDiagnostics(short);
  assert.equal(diagnostics.valid, false);
  assert.ok(diagnostics.issues.includes('too-short'));
  assert.ok(diagnostics.issues.includes('thin-sections'));
  // 版本链可回退，偏短或漏栏不构成不可逆损失；拒绝只会让作者白付一次 API。
  assert.equal(diagnostics.malformed, false);
  assert.doesNotThrow(() => assertGeneratedWorldBible(short));

  const missing = completeWorldBible().replace(/【独特机制】[\s\S]*?(?=【底层规则与代价】)/u, '');
  assert.ok(worldBibleDiagnostics(missing).missingSections.includes('独特机制'));
  const fenced = `${completeWorldBible()}\n\`\`\``;
  assert.equal(worldBibleDiagnostics(fenced).valid, false);
  // 代码围栏属于输出格式损坏，仍然拒绝落盘。
  assert.equal(worldBibleDiagnostics(fenced).malformed, true);
  assert.throws(() => assertGeneratedWorldBible(fenced), /WORLD_BIBLE_FAILED/);
});

test('世界圣经必须单列持续看点与作者/读者/人物认知边界', () => {
  const source = completeWorldBible();
  const diagnostics = worldBibleDiagnostics(source);
  assert.equal(diagnostics.valid, true);
  for (const label of ['持续看点与标志性场面', '秘密分层与认知边界']) {
    assert.ok(WORLD_BIBLE_SECTION_LABELS.includes(label));
    assert.equal(diagnostics.missingSections.includes(label), false);
  }
  const oldTenSections = source
    .replace(/【持续看点与标志性场面】[\s\S]*?(?=【分阶段揭示路线】)/u, '')
    .replace(/【秘密分层与认知边界】[\s\S]*?(?=【禁止便利设定与保留未知】)/u, '');
  assert.deepEqual(worldBibleDiagnostics(oldTenSections).missingSections, [
    '持续看点与标志性场面', '秘密分层与认知边界',
  ]);
});

test('持续看点和认知边界不能用一段漂亮空话冒充子结构', () => {
  const vague = completeWorldBible()
    .replace(/【持续看点与标志性场面】[\s\S]*?(?=【分阶段揭示路线】)/u,
      `【持续看点与标志性场面】\n${'这里有很多精彩场面和持续看点。'.repeat(20)}\n`)
    .replace(/【秘密分层与认知边界】[\s\S]*?(?=【禁止便利设定与保留未知】)/u,
      `【秘密分层与认知边界】\n${'不同人物知道不同秘密并分阶段揭晓。'.repeat(20)}\n`);
  const diagnostics = worldBibleDiagnostics(vague);
  assert.equal(diagnostics.valid, false);
  assert.deepEqual(diagnostics.thinSections, [
    '持续看点与标志性场面', '秘密分层与认知边界',
  ]);
  assert.ok(diagnostics.issues.includes('thin-sections'));

  const placeholders = completeWorldBible()
    .replace(/看点：[^；\n]+/gu, '看点：具体内容')
    .replace(/〔作者底层真相〕[^〔\n]+/u, '〔作者底层真相〕待补充');
  assert.equal(worldBibleDiagnostics(placeholders).valid, false);
  assert.deepEqual(worldBibleDiagnostics(placeholders).thinSections, [
    '持续看点与标志性场面', '秘密分层与认知边界',
  ]);
});

test('宏大世界必须有三层因果揭示路线，不能按章号或势力名自动升级', () => {
  const source = completeWorldBible();
  assert.equal(worldBibleDiagnostics(source).valid, true);
  assert.deepEqual(worldRevealRoute(source).map((stage) => stage.layer),
    WORLD_REVEAL_STAGE_LABELS);
  assert.match(worldRevealRoute(source)[0].nextLayerGate, /1号证据/);
  const vague = source.replace(
    /【分阶段揭示路线】[\s\S]*?(?=【秘密分层与认知边界】)/u,
    `【分阶段揭示路线】\n${'前十章探索小城，中期出现帝国，后期出现更大文明。'.repeat(20)}\n`,
  );
  const diagnostics = worldBibleDiagnostics(vague);
  assert.equal(diagnostics.valid, false);
  assert.ok(diagnostics.thinSections.includes('分阶段揭示路线'));

  const missingGate = source.replace(/进入下一层门槛：[^；\n]+/u, '进入下一层门槛：待定');
  assert.equal(worldBibleDiagnostics(missingGate).valid, false);
  assert.ok(worldBibleDiagnostics(missingGate).thinSections.includes('分阶段揭示路线'));
  assert.deepEqual(worldRevealRoute(missingGate), []);
});
