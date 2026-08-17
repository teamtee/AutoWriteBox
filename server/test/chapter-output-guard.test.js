import test from 'node:test';
import assert from 'node:assert/strict';

import {
  assertChapterOutputClean, chapterOutputLeakDiagnostics,
} from '../chapter-output-guard.js';
import { normalizeChapterRevisionCandidate } from '../chapter-revision-schema.js';

test('正文输出门禁拒绝债务 ID、动作锚点、策划模板和审稿 JSON 字段', () => {
  const leaked = [
    `林越看见了 promise_${'a'.repeat(32)}。`,
    '他写下[推进债务:伪造编号]，转身离开。',
    '压力来源：封站。变化链：闸机关闭。',
    'qualityProtocolVersion: 2',
    'designProtocolVersion: 1',
    'decisionChain: 当前误判',
    'knowledgeDesign: 当前问题',
    'webFictionChecks: pass',
  ];
  for (const body of leaked) {
    assert.equal(chapterOutputLeakDiagnostics(body).valid, false, body);
    assert.throws(() => assertChapterOutputClean(body), /CHAPTER_OUTPUT_LEAKED/);
    assert.equal(normalizeChapterRevisionCandidate(body, '原始短文'), null);
  }
});

test('自然出现单个同名词不误判为整份策划模板', () => {
  const body = '压力来源于站台尽头不断逼近的脚步声。林越把车票折进掌心。';
  assert.equal(chapterOutputLeakDiagnostics(body).valid, true);
  assert.equal(normalizeChapterRevisionCandidate(body, '原始短文'), body);
});
