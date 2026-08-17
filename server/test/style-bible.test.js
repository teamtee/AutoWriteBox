import test from 'node:test';
import assert from 'node:assert/strict';

import {
  assertGeneratedStyleBible, MIN_GENERATED_STYLE_BIBLE_CHARS,
  STYLE_BIBLE_SECTION_LABELS, styleBibleDiagnostics,
} from '../style-bible.js';

function completeStyleBible() {
  return STYLE_BIBLE_SECTION_LABELS.map((label, index) =>
    `【${label}】\n${`${index + 1}号规则写清正向执行、场景变化和应避免的机械表达。`.repeat(6)}`)
    .join('\n');
}

test('完整文风圣经必须达到最低长度并填满十个结构栏目', () => {
  const source = completeStyleBible();
  assert.ok(source.length >= MIN_GENERATED_STYLE_BIBLE_CHARS);
  assert.deepEqual(styleBibleDiagnostics(source), {
    valid: true,
    characters: source.length,
    sectionCount: 10,
    missingSections: [],
    thinSections: [],
    issues: [],
    malformed: false,
  });
  assert.doesNotThrow(() => assertGeneratedStyleBible(source));
});

test('简短、漏栏、薄栏的文风仍会落盘，只有格式损坏才拒绝', () => {
  const short = STYLE_BIBLE_SECTION_LABELS.map((label) => `【${label}】\n有`).join('\n');
  const diagnostics = styleBibleDiagnostics(short);
  assert.equal(diagnostics.valid, false);
  assert.ok(diagnostics.issues.includes('too-short'));
  assert.ok(diagnostics.issues.includes('thin-sections'));
  assert.equal(diagnostics.malformed, false);
  assert.doesNotThrow(() => assertGeneratedStyleBible(short));

  const missing = completeStyleBible()
    .replace(/【场景镜头与细节选择】[\s\S]*?(?=【句式、段落与节奏】)/u, '');
  assert.ok(styleBibleDiagnostics(missing).missingSections.includes('场景镜头与细节选择'));
  const fenced = `${completeStyleBible()}\n\`\`\``;
  assert.equal(styleBibleDiagnostics(fenced).valid, false);
  assert.equal(styleBibleDiagnostics(fenced).malformed, true);
  assert.throws(() => assertGeneratedStyleBible(fenced), /STYLE_BIBLE_FAILED/);
});
