import type { ChapterContextManifest, ChapterProseReferenceRow, ChapterProseTrend } from '../types';

const statusLabels = {
  included: '已装入', missing: '缺失', 'not-applicable': '不适用',
} as const;

function ProseRadar({ reference, trend }: {
  reference: ChapterProseReferenceRow[] | null; trend: ChapterProseTrend;
}) {
  if (!reference && !trend.measuredCount) return null;
  return <section className="chapter-prose-radar">
    <h4>正文体量与质感雷达</h4>
    {reference && <ul className="chapter-prose-quota">
      {reference.map((row) => <li key={row.id} className={row.belowReference ? 'below' : 'pass'}>
        <span>{row.label}</span>
        <small>{row.actual} / 参考 {row.reference} {row.unit}</small>
      </li>)}
    </ul>}
    {!!trend.rows.length && <table className="chapter-prose-trend">
      <thead><tr>
        <th>章</th><th>字数</th><th>均段长</th><th>对话段</th><th>感官/千字</th><th>最长叙述块</th>
      </tr></thead>
      <tbody>{trend.rows.map((row) => <tr key={row.bookChapterIndex}>
        <td>{row.bookChapterIndex}</td>
        <td>{row.chars}</td>
        <td>{row.avgParagraphChars}</td>
        <td>{row.dialogueRatio}%</td>
        <td>{row.sensoryDensity}</td>
        <td>{row.longestNarrationChars}</td>
      </tr>)}</tbody>
    </table>}
    <em>参考值不是合格线：某一章本来就该短、该快时低于它是正常的。
      统计只能发现体量缩水和密度变干，不能代替人工判断情节、人物和细节是否真的有效。</em>
  </section>;
}

export function ChapterContextManifestCard({ manifest }: {
  manifest: ChapterContextManifest;
}) {
  return <details className="chapter-context-manifest">
    <summary>
      <span>当前章节 API 上下文体检</span>
      <small>{manifest.riskCount
        ? `${manifest.riskCount} 项风险`
        : manifest.advisoryCount ? `${manifest.advisoryCount} 项建议` : '关键层已覆盖'}</small>
    </summary>
    <p className="chapter-context-intro">
      这里按当前已保存状态显示各类 API 任务可装配的材料和字符/条目数量，
      不展示正文、秘密或提示词原文。
      “已装入”不代表内容质量已通过，裁剪项会在模型提示中显式标记。
    </p>
    {!!manifest.warnings.length && <div className="chapter-context-warnings">
      {manifest.warnings.map((entry) => <p key={entry.id} className={entry.severity}>
        <b>{entry.severity === 'risk' ? '风险' : '建议'}</b><span>{entry.message}</span>
      </p>)}
    </div>}
    {manifest.budget && <section className="chapter-context-budget">
      <h4>单次调用预算分配</h4>
      <p>输入上限约 {manifest.budget.ceiling} 字符；固定指令预留 {manifest.budget.fixedOverheadCharacters}；
        动态材料可分配 {manifest.budget.assignableCharacters}，当前未使用 {manifest.budget.remainingCharacters}。</p>
      <ul>{manifest.budget.layers.filter((entry) => entry.want > 0).map((entry) => <li
          key={entry.id} className={entry.truncated ? 'truncated' : 'included'}>
        <span>{entry.label}</span>
        <small>需求 {entry.want} · 实发 {entry.characters}
          {entry.truncated ? ` · 已裁剪（保底 ${entry.floor}）` : ' · 完整'}</small>
      </li>)}</ul>
      <em>“需求”是当前材料在字段上限内想发送的体量；“实发”是全局预算分配结果。
        未发送内容仍保存在作品中，不代表该事实或设定不存在。</em>
    </section>}
    {manifest.prose && <ProseRadar reference={manifest.prose.reference} trend={manifest.prose.trend} />}
    <div className="chapter-context-layers">
      {manifest.layers.map((layer) => <section key={layer.id}>
        <h4>{layer.label}</h4>
        <ul>{layer.items.map((entry) => <li key={entry.id} className={entry.status}>
          <span>{entry.label}</span>
          <small>
            {statusLabels[entry.status]}
            {entry.count !== undefined ? ` · ${entry.count} 项` : ''}
            {entry.characters ? ` · ${entry.characters} 字符` : ''}
            {entry.truncated ? ' · 已裁剪' : ''}
          </small>
          {entry.note && <em>{entry.note}</em>}
        </li>)}</ul>
      </section>)}
    </div>
  </details>;
}
