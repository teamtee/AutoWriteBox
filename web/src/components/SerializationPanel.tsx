import { useEffect, useMemo, useState } from 'react';
import type { BookTree, ChapterSummary, PlatformConfirmationInput } from '../types';
import { formatIndexedTitle } from '../titles';
import { PlatformGovernancePanel } from './PlatformGovernancePanel';

type SerializationRow = {
  sectionId: string;
  sectionIndex: number;
  sectionTitle: string;
  chapter: ChapterSummary;
  globalIndex: number;
};

function pad(value: number) { return String(value).padStart(2, '0'); }

export function localDateKey(value: Date | string): string | null {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function serializationRows(tree: BookTree): SerializationRow[] {
  let globalIndex = 0;
  return tree.sections.flatMap((section) => section.chapters.map((chapter) => ({
    sectionId: section.id,
    sectionIndex: section.index,
    sectionTitle: section.title,
    chapter,
    globalIndex: ++globalIndex,
  })));
}

function chapterLabel(row: SerializationRow) {
  return `${formatIndexedTitle(row.globalIndex, '章', row.chapter.title)}`;
}

export function SerializationPanel({
  tree, disabled = false, onSaveDailyWordGoal, onSavePlatformConfirmation,
  onDeletePlatformConfirmation, onOpenChapter,
}: {
  tree: BookTree;
  disabled?: boolean;
  onSaveDailyWordGoal: (goal: number) => Promise<void>;
  onSavePlatformConfirmation: (input: PlatformConfirmationInput) => Promise<boolean>;
  onDeletePlatformConfirmation: (id: string) => Promise<boolean>;
  onOpenChapter: (sectionId: string, chapterId: string) => void;
}) {
  const settings = tree.book.settings.serialization;
  const savedGoal = settings?.dailyWordGoal ?? 2_000;
  const [goalDraft, setGoalDraft] = useState(String(savedGoal));
  const [saving, setSaving] = useState(false);
  const today = localDateKey(new Date())!;
  const [calendarMonth, setCalendarMonth] = useState(today.slice(0, 7));
  const rows = useMemo(() => serializationRows(tree), [tree]);

  useEffect(() => setGoalDraft(String(savedGoal)), [savedGoal]);

  const stash = rows.filter((row) => row.chapter.hasContent
    && row.chapter.publicationStatus !== 'published');
  const published = rows.filter((row) => row.chapter.publishedAt);
  const recordsByDate = new Map<string, SerializationRow[]>();
  for (const row of published) {
    const key = localDateKey(row.chapter.publishedAt!);
    if (!key) continue;
    const group = recordsByDate.get(key) ?? [];
    group.push(row);
    recordsByDate.set(key, group);
  }
  const todayRows = recordsByDate.get(today) ?? [];
  const todayCharacters = todayRows.reduce(
    (total, row) => total + (row.chapter.publishedCharacterCount ?? 0), 0,
  );
  const currentCharacters = rows.reduce(
    (total, row) => total + (row.chapter.characterCount ?? 0), 0,
  );
  const stashCharacters = stash.reduce(
    (total, row) => total + (row.chapter.characterCount ?? 0), 0,
  );
  const exactPublishedCount = rows.filter(
    (row) => row.chapter.publicationStatus === 'published',
  ).length;
  const progress = Math.min(100, Math.round((todayCharacters / savedGoal) * 100));

  const monthMatch = calendarMonth.match(/^(\d{4})-(\d{2})$/);
  const year = monthMatch ? Number(monthMatch[1]) : new Date().getFullYear();
  const monthIndex = monthMatch ? Number(monthMatch[2]) - 1 : new Date().getMonth();
  const dayCount = new Date(year, monthIndex + 1, 0).getDate();
  const leading = new Date(year, monthIndex, 1).getDay();
  const cells = [
    ...Array.from({ length: leading }, () => null),
    ...Array.from({ length: dayCount }, (_, index) => index + 1),
  ];

  const saveGoal = async () => {
    const value = Number(goalDraft);
    if (!Number.isInteger(value) || value < 1 || value > 100_000
      || saving || disabled || !settings?.revision) return;
    setSaving(true);
    try { await onSaveDailyWordGoal(value); }
    finally { setSaving(false); }
  };

  return <main className="main serialization-panel">
    <header className="serialization-heading">
      <div>
        <h2>连载管理</h2>
        <p>发布状态来自手动锁定的读者可见快照；这里不会登录或自动操作起点后台。</p>
      </div>
      <label>每日字数目标
        <span>
          <input type="number" min="1" max="100000" step="100"
            disabled={disabled || saving || !settings?.revision}
            value={goalDraft} onChange={(event) => setGoalDraft(event.target.value)} />
          <button className="hbtn" disabled={disabled || saving || !settings?.revision
            || Number(goalDraft) === savedGoal
            || !Number.isInteger(Number(goalDraft))
            || Number(goalDraft) < 1 || Number(goalDraft) > 100_000}
            onClick={() => { void saveGoal(); }}>{saving ? '保存中…' : '保存目标'}</button>
        </span>
      </label>
    </header>

    <section className="serialization-stats" aria-label="连载统计">
      <article><strong>{todayCharacters.toLocaleString()}</strong><span>今日已锁定字数 / {savedGoal.toLocaleString()}</span></article>
      <article><strong>{stash.length}</strong><span>存稿章节 · {stashCharacters.toLocaleString()} 字符</span></article>
      <article><strong>{exactPublishedCount}</strong><span>当前正文与发布版一致</span></article>
      <article><strong>{currentCharacters.toLocaleString()}</strong><span>全书当前正文字符</span></article>
    </section>
    <div className="serialization-progress" aria-label={`今日目标完成 ${progress}%`}>
      <span style={{ width: `${progress}%` }} />
    </div>

    <section className="serialization-section">
      <header><div><h3>存稿箱</h3><p>有正文但尚未发布，或发布后又修改过的章节。</p></div><span>{stash.length} 章</span></header>
      {stash.length ? <div className="serialization-list">{stash.map((row) =>
        <button type="button" key={`${row.sectionId}:${row.chapter.id}`}
          onClick={() => onOpenChapter(row.sectionId, row.chapter.id)}>
          <span><strong>{chapterLabel(row)}</strong><small>
            {formatIndexedTitle(row.sectionIndex, '部', row.sectionTitle)} · {(row.chapter.characterCount ?? 0).toLocaleString()} 字符
          </small></span>
          <em>{row.chapter.publicationStatus === 'modified' ? '发布后有修改' : '尚未发布'}</em>
        </button>)}</div>
        : <p className="empty-hint">存稿箱为空：有正文的章节都已锁定为当前发布版。</p>}
    </section>

    <section className="serialization-section">
      <header>
        <div><h3>更新日历</h3><p>按每章最近一次锁定发布快照统计；历史旧版发布日期不会伪造补全。</p></div>
        <input type="month" value={calendarMonth}
          onChange={(event) => setCalendarMonth(event.target.value || today.slice(0, 7))} />
      </header>
      <div className="serialization-weekdays" aria-hidden="true">
        {['日', '一', '二', '三', '四', '五', '六'].map((day) => <span key={day}>{day}</span>)}
      </div>
      <div className="serialization-calendar">{cells.map((day, index) => {
        if (day === null) return <div className="blank" key={`blank-${index}`} />;
        const key = `${year}-${pad(monthIndex + 1)}-${pad(day)}`;
        const dayRows = recordsByDate.get(key) ?? [];
        const characters = dayRows.reduce(
          (total, row) => total + (row.chapter.publishedCharacterCount ?? 0), 0,
        );
        return <div key={key} className={`${key === today ? 'today' : ''} ${dayRows.length ? 'updated' : ''}`}>
          <span>{day}</span>
          {dayRows.length > 0 && <><strong>{dayRows.length} 章</strong><small>{characters.toLocaleString()} 字符</small></>}
        </div>;
      })}</div>
      {!!published.length && <details className="serialization-history">
        <summary>查看最近发布记录</summary>
        <ol>{[...published].sort((a, b) =>
          Date.parse(b.chapter.publishedAt!) - Date.parse(a.chapter.publishedAt!)).map((row) =>
          <li key={`${row.sectionId}:${row.chapter.id}`}>
            <button type="button" onClick={() => onOpenChapter(row.sectionId, row.chapter.id)}>
              {chapterLabel(row)}
            </button>
            <span>{new Date(row.chapter.publishedAt!).toLocaleString()} · 第 {row.chapter.publicationNumber ?? 1} 次锁定</span>
          </li>)}</ol>
      </details>}
    </section>
    <PlatformGovernancePanel
      settings={settings}
      disabled={disabled}
      onSave={onSavePlatformConfirmation}
      onDelete={onDeletePlatformConfirmation} />
  </main>;
}
