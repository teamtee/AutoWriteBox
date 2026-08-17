import type { ChapterPlanComparisonItem, ChapterReview } from '../types';

const checkLabels = {
  goldenChapter: '本章黄金职责',
  premisePromise: '前三章共同承诺',
  chapterGoal: '本章目标',
  obstacleEscalation: '阻碍与升级',
  characterChoice: '人物选择',
  sceneExecution: '场景化与转折',
  effectiveIncrement: '有效增量',
  payoff: '铺垫与兑现',
  endingHook: '章末钩子',
  tensionDynamics: '张力起伏',
  foreshadowingExecution: '埋点落地',
  worldExpansion: '世界边界展开',
  proseHumanity: '自然人感',
  expressionBalance: '表达比例',
  repetitionRisk: '重复风险',
  longArcProgress: '长线推进',
  styleConsistency: '文风一致性',
  packagingPromise: '包装承诺一致性',
  contentRisk: '内容风险线索',
} as const;

const statusLabels = { pass: '通过', risk: '风险', na: '不适用' } as const;
const rhythmLabels: Record<string, string> = {
  'steady-rise': '单向升压', 'wave-rise': '多轮起伏',
  'false-relief': '假缓解后反噬', 'reversal-led': '关键反转主导',
  'choice-led': '关键选择抬压', aftermath: '余波重组',
  none: '无', force: '力量压制', skill: '能力/技艺', wit: '计谋判断',
  negotiation: '谈判交换', sacrifice: '主动牺牲', cooperation: '协作',
  endurance: '承受熬过', discovery: '发现信息', failure: '失败转场', mixed: '混合',
  micro: '微兑现', chapter: '本章兑现', stage: '阶段兑现', major: '重大兑现',
  'new-threat': '新威胁', 'new-information': '新信息', 'unfinished-action': '行动未完',
  'forced-choice': '被迫选择', 'relationship-shift': '关系突变',
  'world-opening': '世界边界打开', deadline: '期限逼近',
  'aftermath-question': '余波疑问', physical: '身体', resource: '资源',
  identity: '身份', relationship: '关系', moral: '道德', time: '时间',
  position: '地位', knowledge: '认知/秘密',
};
const planOverallLabels = {
  aligned: '基本落地', adapted: '合理改写', partial: '部分落地',
  diverged: '明显偏离', na: '无策划可对照',
} as const;
const planOutcomeLabels = {
  fulfilled: '已落地', adapted: '合理改写', missed: '未落地', unclear: '证据不足',
} as const;
const planFieldLabels: Record<string, string> = {
  goal: '本章目标', obstacle: '主要阻碍', choice: '关键选择',
  payoff: '兑现 / 爽点', hook: '章末钩子',
  tensionArc: '张力曲线', foreshadowing: '分层埋点',
  worldExpansion: '世界边界扩张', decisionChain: '决策因果链',
  knowledgeDesign: '认知与证据边界', notes: '补充约束',
};

function planTargetLabel(target: string): string {
  const scene = /^scene-(\d+)$/u.exec(target);
  return scene ? `场景 ${scene[1]}` : planFieldLabels[target] ?? target;
}

export function planComparisonRepairInstruction(item: ChapterPlanComparisonItem): string {
  const target = planTargetLabel(item.target);
  return `只定向修复策划—成稿差异中的「${target}」：${item.evidence}。`
    + '请对照已保存策划卡，把该项改写为具体的人物欲望、现场阻碍、主动行动、局势转折和代价；'
    + '保留本章其它已落地的情节、人物状态与章末因果，不得顺手改掉无关场景。';
}

export function ChapterReviewCard({
  review, stale, reviewing, empty = false, disabled = false, onReview, onStopReview, onUseSuggestion,
}: {
  review?: ChapterReview;
  stale: boolean;
  reviewing: boolean;
  empty?: boolean;
  disabled?: boolean;
  onReview: () => void;
  onStopReview?: () => void;
  onUseSuggestion: (instruction: string) => void;
}) {
  if (reviewing) {
    return (
      <div className="review-card sketch" aria-busy="true">
        <div className="review-header" role="status" aria-live="polite" aria-atomic="true">审稿中…</div>
        {onStopReview && <button type="button" className="hbtn stop review-btn" onClick={onStopReview}>⏹ 停止审稿</button>}
      </div>
    );
  }

  if (empty) {
    return (
      <div className="review-card sketch">
        <div className="review-header">章节正文为空</div>
        <div className="review-verdict">写入正文后才能审稿。</div>
      </div>
    );
  }

  if (!review) {
    return (
      <div className="review-card sketch">
        <div className="review-header">还没有审稿</div>
        <button className="hbtn review-btn" disabled={disabled} onClick={onReview}>审稿本章</button>
      </div>
    );
  }

  if (stale) {
    return (
      <div className="review-card sketch stale">
        <div className="review-header">这张审稿卡对应旧正文或旧故事设定</div>
        <div className="review-score">评分：{review.score}</div>
        <div className="review-verdict">{review.verdict}</div>
        <button className="hbtn review-btn" disabled={disabled} onClick={onReview}>重新审稿</button>
      </div>
    );
  }

  return (
    <div className="review-card sketch">
      <div className="review-header">章节审稿</div>
      <div className="review-score">综合评分：{review.score}</div>
      <div className="review-verdict">{review.verdict}</div>

      {review.webFictionSignals && (
        <div className="review-signals" aria-label="本章节奏记录">
          <span>功能：{review.webFictionSignals.chapterFunction}</span>
          <span>冲突：{review.webFictionSignals.conflictType}</span>
          <span>情绪：{review.webFictionSignals.emotionTone}</span>
          <span>兑现：{review.webFictionSignals.payoffType}</span>
          <span>表达：{review.webFictionSignals.dominantMode}</span>
          {review.webFictionSignals.rhythmFingerprint && <>
            <span>压力轨迹：{rhythmLabels[review.webFictionSignals.rhythmFingerprint.pressurePattern]}</span>
            <span>破局方式：{rhythmLabels[review.webFictionSignals.rhythmFingerprint.resolutionMethod]}</span>
            <span>兑现规模：{rhythmLabels[review.webFictionSignals.rhythmFingerprint.payoffScale]}</span>
            <span>钩子机制：{rhythmLabels[review.webFictionSignals.rhythmFingerprint.hookMechanism]}</span>
            <span>关键代价：{rhythmLabels[review.webFictionSignals.rhythmFingerprint.costType]}</span>
          </>}
        </div>
      )}

      {review.planComparison && (
        <div className="review-section plan-comparison" aria-label="策划—成稿差异回顾">
          <div className="review-section-title">策划—成稿差异</div>
          <div className={`plan-comparison-summary ${review.planComparison.overall}`}>
            <strong>{planOverallLabels[review.planComparison.overall]}</strong>
            <span>{review.planComparison.summary}</span>
          </div>
          {!!review.planComparison.items.length && (
            <div className="plan-comparison-items">
              {review.planComparison.items.map((item) => (
                <div className={`plan-comparison-item ${item.outcome}`} key={item.target}>
                  <div><strong>{planTargetLabel(item.target)}</strong>
                    <span>{planOutcomeLabels[item.outcome]}</span></div>
                  <p>{item.evidence}</p>
                  {(item.outcome === 'missed' || item.outcome === 'unclear') && (
                    <button className="hbtn plan-repair-btn" disabled={disabled}
                      onClick={() => onUseSuggestion(planComparisonRepairInstruction(item))}>
                      定向修复本项
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
          {!!review.planComparison.carryovers.length && (
            <div className="plan-carryover-review">
              <strong>建议下章处理（待作者选择）</strong>
              <ul>{review.planComparison.carryovers.map((item) => (
                <li key={item.sourceTarget}>{item.text}<small>{item.reason}</small></li>
              ))}</ul>
            </div>
          )}
        </div>
      )}

      {!!review.webFictionChecks?.length && (
        <div className="review-section">
          <div className="review-section-title">网文章法检查</div>
          <div className="review-checks">
            {review.webFictionChecks.map((check) => (
              <div key={check.id} className={`review-check ${check.status}`}>
                <div className="review-check-heading">
                  <span>{checkLabels[check.id]}</span>
                  <span className="review-check-status">{statusLabels[check.status]}</span>
                </div>
                <div className="review-check-detail">{check.detail}</div>
                {(check.evidence || check.goldenEvidence || check.premiseEvidence
                  || check.goalEvidence || check.obstacleEvidence || check.sceneEvidence
                  || check.incrementEvidence || check.choiceEvidence || check.costEvidence
                  || check.payoffEvidence || check.hookEvidence || check.tensionEvidence
                  || check.longArcEvidence) && <details
                    className="review-evidence-details" open={check.status !== 'pass'}>
                  <summary>{check.status === 'pass' ? '查看通过证据' : '正文证据'}</summary>
                {check.evidence && (
                  <blockquote className="review-check-evidence">正文证据：{check.evidence}</blockquote>
                )}
                {check.goldenEvidence && <div className="review-check-evidence">
                  <div>黄金章起点：<q>{check.goldenEvidence.setupQuote}</q></div>
                  <div>职责兑现：<q>{check.goldenEvidence.fulfillmentQuote}</q></div>
                </div>}
                {check.premiseEvidence && <div className="review-check-evidence">
                  <div>卖点运转：<q>{check.premiseEvidence.promiseQuote}</q></div>
                  <div>相关回报：<q>{check.premiseEvidence.deliveryQuote}</q></div>
                </div>}
                {check.goalEvidence && <div className="review-check-evidence">
                  <div>当下目标：<q>{check.goalEvidence.goalQuote}</q></div>
                  <div>目标尝试：<q>{check.goalEvidence.attemptQuote}</q></div>
                </div>}
                {check.obstacleEvidence && <div className="review-check-evidence">
                  <div>前置阻碍：<q>{check.obstacleEvidence.baseQuote}</q></div>
                  <div>升级局面：<q>{check.obstacleEvidence.escalatedQuote}</q></div>
                </div>}
                {check.sceneEvidence && <div className="review-check-evidence">
                  <div>场景行动：<q>{check.sceneEvidence.actionQuote}</q></div>
                  <div>即时反应：<q>{check.sceneEvidence.reactionQuote}</q></div>
                  <div>局势转折：<q>{check.sceneEvidence.turnQuote}</q></div>
                </div>}
                {check.incrementEvidence && <div className="review-check-evidence">
                  <div>推进触发：<q>{check.incrementEvidence.triggerQuote}</q></div>
                  <div>新增状态：<q>{check.incrementEvidence.stateQuote}</q></div>
                </div>}
                {check.choiceEvidence && <div className="review-check-evidence">
                  <div>取舍压力：<q>{check.choiceEvidence.pressureQuote}</q></div>
                  <div>主动选择：<q>{check.choiceEvidence.choiceQuote}</q></div>
                </div>}
                {check.costEvidence && <div className="review-check-evidence">
                  <div>关键选择：<q>{check.costEvidence.choiceQuote}</q></div>
                  <div>实际代价：<q>{check.costEvidence.consequenceQuote}</q></div>
                </div>}
                {check.payoffEvidence && <div className="review-check-evidence">
                  <div>挣得动作：<q>{check.payoffEvidence.actionQuote}</q></div>
                  <div>兑现结果：<q>{check.payoffEvidence.resultQuote}</q></div>
                </div>}
                {check.hookEvidence && <div className="review-check-evidence">
                  <div>钩子铺垫：<q>{check.hookEvidence.setupQuote}</q></div>
                  <div>章尾牵引：<q>{check.hookEvidence.hookQuote}</q></div>
                </div>}
                {check.tensionEvidence && <div className="review-check-evidence">
                  <div>压力局面：<q>{check.tensionEvidence.pressureQuote}</q></div>
                  <div>局势变化：<q>{check.tensionEvidence.shiftQuote}</q></div>
                  <div>反制余波：<q>{check.tensionEvidence.aftermathQuote}</q></div>
                </div>}
                {check.longArcEvidence && <div className="review-check-evidence">
                  <div>触及长线：<q>{check.longArcEvidence.threadQuote}</q></div>
                  <div>长线进展：<q>{check.longArcEvidence.progressQuote}</q></div>
                </div>}
                </details>}
              </div>
            ))}
          </div>
        </div>
      )}

      {review.issues.length > 0 && (
        <div className="review-section">
          <div className="review-section-title">主要问题</div>
          {review.issues.map((issue, i) => (
            <div key={i} className="review-issue">
              <div>{i + 1}. {issue.title}</div>
              <div className="review-issue-detail">{issue.detail}</div>
            </div>
          ))}
        </div>
      )}

      {review.suggestions.length > 0 && (
        <div className="review-section">
          <div className="review-section-title">建议抽打</div>
          <div className="review-suggestions">
            {review.suggestions.map((s, i) => (
              <button key={i} className="hbtn review-suggestion" disabled={disabled} onClick={() => onUseSuggestion(s.instruction)}>
                {s.label}
              </button>
            ))}
          </div>
        </div>
      )}

      <button className="hbtn review-btn" disabled={disabled} onClick={onReview}>重新审稿</button>
    </div>
  );
}
