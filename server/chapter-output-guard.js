const BACKSTAGE_TOKEN_PATTERNS = Object.freeze([
  ['promise-id', /promise_[0-9a-f]{32}/u],
  ['promise-action', /\[(?:推进债务|兑现债务|建立承诺|延期债务):/u],
  ['plan-json-field', /(?:qualityProtocolVersion|designProtocolVersion|tensionArc|foreshadowing|worldExpansion|decisionChain|knowledgeDesign)\s*["']?\s*:/u],
  ['review-json-field', /(?:webFictionChecks|planComparison|rewriteInstructions|proseHumanity|foreshadowingExecution)\s*["']?\s*:/u],
  ['section-world-marker', /【(?:世界层级|世界阶段承诺|可验证世界证据|世界选择与代价|阶段认知增量|本部保留未知|下一层门槛|门槛结果|门槛证据进度)】/u],
]);

const PLAN_CONTRACT_LABELS = Object.freeze([
  '压力来源', '变化链', '选择高点', '兑现与余波',
  '旧线/阅读债务', '具体载体', '当下作用', '行动影响', '保留未知',
  '无埋点理由', '本章聚焦', '既有未知处理',
  '展开前认知', '既有依据', '可验证证据', '边界增量/机制深化', '选择与代价',
]);

export function chapterOutputLeakDiagnostics(value) {
  const source = typeof value === 'string' ? value : '';
  const signals = BACKSTAGE_TOKEN_PATTERNS
    .filter(([, pattern]) => pattern.test(source)).map(([id]) => id);
  const contractLabelCount = PLAN_CONTRACT_LABELS.filter((label) =>
    source.includes(`${label}：`) || source.includes(`${label}:`)).length;
  // 单个词可能是自然叙事；两个以上合同标签同时出现才按策划模板泄漏处理。
  if (contractLabelCount >= 2) signals.push('plan-contract-labels');
  return { valid: signals.length === 0, signals, contractLabelCount };
}

export function assertChapterOutputClean(value) {
  const diagnostics = chapterOutputLeakDiagnostics(value);
  if (!diagnostics.valid) throw new Error('CHAPTER_OUTPUT_LEAKED');
  return diagnostics;
}
