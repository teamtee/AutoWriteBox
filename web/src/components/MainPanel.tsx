import type { BookTree } from '../types';
import type { Selection } from '../store';
import { findChapter } from '../store';
import { VersionedBox } from './VersionedBox';

// core 字段元信息
const CORE_FIELDS: { field: 'world' | 'style' | 'constraints' | 'pacing'; label: string }[] = [
  { field: 'world', label: '世界观' }, { field: 'style', label: '文风基调' },
  { field: 'constraints', label: '禁忌约束' }, { field: 'pacing', label: '篇幅节奏' },
];

// 主区域：三种视图（全书大纲 / 核心设定 / 章节）统一改用 VersionedBox
export function MainPanel({ tree, selection, streaming, streamingText, streamingPath, onMove, onRewrite, onClear, onSave, onStop }: {
  tree: BookTree; selection: Selection;
  streaming: boolean; streamingText: string; streamingPath: string | null;
  onMove: (path: string, delta: number) => void;
  onRewrite: (path: string) => void;
  onClear: (path: string) => void;
  onSave: (path: string, text: string) => void;
  onStop: () => void;
}) {
  // 把 path 相关的回调打包给 VersionedBox（大纲 / core 使用）
  const boxProps = (path: string) => ({
    streaming: streaming && streamingPath === path,
    streamingText: streaming && streamingPath === path ? streamingText : '',
    onMove: (d: number) => onMove(path, d),
    onRewrite: () => onRewrite(path),
    onClear: () => onClear(path),
    onSave: (t: string) => onSave(path, t),
    onStop,
  });

  if (selection.kind === 'outline') {
    return <main className="main"><VersionedBox title="全书大纲" versioned={tree.book.outline} {...boxProps('outline')} /></main>;
  }

  if (selection.kind === 'core') {
    return (
      <main className="main">
        {CORE_FIELDS.map(({ field, label }) => (
          <VersionedBox key={field} title={label} versioned={tree.book.settings.core[field]} {...boxProps(`core:${field}`)} />
        ))}
      </main>
    );
  }

  const chapter = findChapter(tree, selection);
  if (!chapter) {
    return <main className="main"><div className="empty-hint big">还没有章节。点左侧 <b>＋ 新建部</b> 或 <b>🧩 AI 规划分部</b> 开始，再 <b>＋ 加章</b>。</div></main>;
  }
  const path = `section:${selection.sectionId}:chapter:${selection.chapterId}`;
  // 章节任意生成用 'chapter' 哨兵，与 App 中章节生成保持一致
  const chStreaming = streaming && streamingPath === 'chapter';
  return (
    <main className="main">
      <VersionedBox title={chapter.title} versioned={chapter.body}
        streaming={chStreaming} streamingText={chStreaming ? streamingText : ''}
        onMove={(d) => onMove(path, d)} onRewrite={() => onRewrite(path)}
        onClear={() => onClear(path)} onSave={(t) => onSave(path, t)} onStop={onStop} />
    </main>
  );
}
