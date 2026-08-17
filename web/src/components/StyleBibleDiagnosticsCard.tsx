import type { StyleBibleDiagnostics } from '../types';

const SECTION_LABELS = [
  '叙事视角与距离', '场景镜头与细节选择', '句式、段落与节奏', '对话、潜台词与人物声音',
  '情绪呈现与内心活动', '设定信息与世界展示', '冲突、爽点与余波', '开篇、转场与章尾',
  '词汇、意象与修辞边界', '稳定锚点、可变范围与禁止表达',
];

export function StyleBibleDiagnosticsCard({ diagnostics }: {
  diagnostics: StyleBibleDiagnostics;
}) {
  const missing = new Set(diagnostics.missingSections);
  const thin = new Set(diagnostics.thinSections);
  return <section className={`world-bible-diagnostics sketch-alt ${diagnostics.valid ? 'ready' : 'attention'}`}>
    <header>
      <div>
        <strong>文风圣经完整度</strong>
        <p>稳定文风是可执行的观察、句式、对话与情绪规则，不是“细腻、紧凑、像人写”的形容词。</p>
      </div>
      <span>{diagnostics.valid ? '文风圣经结构完整' : `${diagnostics.sectionCount}/10 栏 · ${diagnostics.characters} 字符`}</span>
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
      点击下方“API 重构文风圣经”会结合故事方向、世界规则、核心循环和当前草稿生成候选；
      少于 1000 字符、漏栏或空栏的结果不会保存。
    </p>}
  </section>;
}
