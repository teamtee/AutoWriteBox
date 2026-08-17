import test from 'node:test';
import assert from 'node:assert/strict';

import {
  analyzePlannedChapterRhythm, analyzeRecentChapterRhythm,
  formatChapterRhythmFingerprint,
} from '../chapter-rhythm.js';
import { normalizeChapterReviewSignals } from '../chapter-review-schema.js';

const fingerprint = Object.freeze({
  pressurePattern: 'false-relief', resolutionMethod: 'sacrifice',
  payoffScale: 'chapter', hookMechanism: 'new-threat', costType: 'relationship',
});

function row(bookChapterIndex, override = {}) {
  return {
    bookChapterIndex,
    signals: {
      chapterFunction: '转折', conflictType: '追捕', emotionTone: '紧张',
      payoffType: '脱险', dominantMode: '行动',
      rhythmFingerprint: { ...fingerprint, ...override },
    },
  };
}

test('旧五标签审稿继续兼容，新 API 协议可强制要求受控指纹', () => {
  const legacy = {
    chapterFunction: '推进', conflictType: '争执', emotionTone: '紧张',
    payoffType: '信息', dominantMode: '对话',
  };
  assert.deepEqual(normalizeChapterReviewSignals(legacy), legacy);
  assert.equal(normalizeChapterReviewSignals(legacy, { requireRhythmFingerprint: true }), null);
  assert.equal(normalizeChapterReviewSignals({
    ...legacy, rhythmFingerprint: { ...fingerprint, hookMechanism: '悬念' },
  }), null);
});

test('连续三章同类与连续两章完整同构被确定性识别', () => {
  const analysis = analyzeRecentChapterRhythm([row(7), row(8), row(9)]);
  assert.equal(analysis.recordedCount, 3);
  assert.ok(analysis.risks.some((risk) => risk.id === 'exact-pattern-repeat'));
  assert.ok(analysis.risks.some((risk) =>
    risk.id === 'resolutionMethod-streak' && risk.severity === 'risk'));
  assert.match(analysis.risks.find((risk) => risk.id === 'hookMechanism-streak').message,
    /新威胁/);
  assert.match(formatChapterRhythmFingerprint(fingerprint), /破局方式=主动牺牲\(sacrifice\)/);
});

test('缺失旧审稿会切断连续章判断，五章中四次同类仍给支配风险', () => {
  const rows = [
    row(4), row(5), row(6, { resolutionMethod: 'wit' }), row(7), row(8),
    { bookChapterIndex: 9, signals: null },
  ];
  const analysis = analyzeRecentChapterRhythm(rows);
  assert.equal(analysis.trailingCount, 0);
  assert.ok(analysis.risks.some((risk) =>
    risk.id === 'resolutionMethod-dominance' && risk.severity === 'advisory'));
  assert.equal(analysis.risks.some((risk) => risk.id === 'resolutionMethod-streak'), false);
});

test('写前意图只返回由当前计划新触发的重复风险', () => {
  const rows = [row(7), row(8)];
  const repeated = analyzePlannedChapterRhythm(fingerprint, rows, 9);
  assert.ok(repeated.risks.some((risk) => risk.id === 'resolutionMethod-streak'));
  const varied = analyzePlannedChapterRhythm({
    ...fingerprint, pressurePattern: 'wave-rise', resolutionMethod: 'cooperation',
    hookMechanism: 'forced-choice', costType: 'resource',
  }, rows, 9);
  assert.deepEqual(varied.risks.map((risk) => risk.id), ['payoffScale-streak']);
});
