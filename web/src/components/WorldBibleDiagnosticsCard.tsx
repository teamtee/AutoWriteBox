import type { WorldBibleDiagnostics } from '../types';

const SECTION_LABELS = [
  '一句话世界钩子', '独特机制', '底层规则与代价', '空间层级与可达边界',
  '社会生态与日常后果', '势力与利益冲突', '历史伤口与当前火药桶',
  '主角切口与升级路径', '持续看点与标志性场面', '分阶段揭示路线',
  '秘密分层与认知边界', '禁止便利设定与保留未知',
];

export function WorldBibleDiagnosticsCard({ diagnostics }: {
  diagnostics: WorldBibleDiagnostics;
}) {
  const missing = new Set(diagnostics.missingSections);
  const thin = new Set(diagnostics.thinSections);
  return <section className={`world-bible-diagnostics sketch-alt ${diagnostics.valid ? 'ready' : 'attention'}`}>
    <header>
      <div>
        <strong>世界观完整度</strong>
        <p>宏大不是名词多，而是规则会改变日常、权力和人物选择，并能分阶段推开边界。</p>
      </div>
      <span>{diagnostics.valid ? '世界圣经结构完整' : `${diagnostics.sectionCount}/${SECTION_LABELS.length} 栏 · ${diagnostics.characters} 字符`}</span>
    </header>
    <div className="world-bible-sections">
      {SECTION_LABELS.map((label) => {
        const status = missing.has(label) ? 'missing' : thin.has(label) ? 'thin' : 'covered';
        return <span key={label} className={status}>
          {status === 'covered' ? '✓' : status === 'thin' ? '△' : '○'} {label}
        </span>;
      })}
    </div>
    {!diagnostics.valid && <p className="world-bible-advice">
      点击下方“API 重构世界圣经”会结合故事设想、全书大纲、核心循环和现有草稿生成候选；
      少于 1800 字符、漏栏或薄栏的结果不会保存。持续看点还要覆盖六类可变奏场面，
      揭示路线要写当前生活圈、中期势力地域、长线文明历史三层的证据、行动、代价与进入门槛；
      认知边界要区分作者真相、读者、主角、势力与阶段未知。
    </p>}
  </section>;
}
