import { useRef, useState } from 'react';
import { createBook, createClientBookId } from '../api';
import { runExclusiveAction } from '../asyncAction';
import type { Book } from '../types';
import { useToast } from './Toast';

export function hasCreationPremiseDraft(premise: string) {
  return premise.trim().length > 0;
}

export function shouldConfirmCreationDiscard(dirty: boolean, confirmed: boolean) {
  return dirty && !confirmed;
}

export function FirstRun({ premise, onPremiseChange, onCreated, onCreateFailure, onImportBackup, onOpenSettings, onCancel }: {
  premise: string;
  onPremiseChange: (premise: string) => void;
  onCreated: (book: Book) => void | Promise<void>;
  onCreateFailure?: (error: unknown, requestedBookId: string) => void | Promise<void>;
  onImportBackup: (file: File) => void | Promise<void>;
  onOpenSettings: () => void;
  onCancel?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const busyRef = useRef(false);
  const importRef = useRef<HTMLInputElement>(null);
  const toast = useToast();
  const submit = async () => {
    await runExclusiveAction({
      isRunning: () => busyRef.current,
      setRunning: (running) => { busyRef.current = running; setBusy(running); },
      task: async () => {
        const requestedBookId = createClientBookId();
        let book: Book;
        try {
          book = await createBook(premise, undefined, requestedBookId);
        } catch (e) {
          if (onCreateFailure) await onCreateFailure(e, requestedBookId);
          else toast.error('创建失败：' + (e as Error).message);
          return;
        }
        try { await onCreated(book); }
        catch (e) { toast.error('作品已创建，但打开失败：' + (e as Error).message); }
      },
    });
  };
  const importBackup = async (file?: File) => {
    if (!file) return;
    await runExclusiveAction({
      isRunning: () => busyRef.current,
      setRunning: (running) => { busyRef.current = running; setBusy(running); },
      task: async () => { await onImportBackup(file); },
    });
    if (importRef.current) importRef.current.value = '';
  };
  const cancel = () => {
    if (!onCancel) return;
    if (shouldConfirmCreationDiscard(hasCreationPremiseDraft(premise), confirmCancel)) {
      setConfirmCancel(true);
      return;
    }
    onCancel();
  };
  return (
    <div className="first-run">
      <article className="paper sketch first-card">
        <h1 className="paper-title">📖 自动小说盒子</h1>
        <p className="first-lead">用一句话，开始你的小说。你只管挥鞭子。</p>
        <textarea className="first-input" aria-label="故事设想"
          maxLength={20000} value={premise} onChange={(e) => {
          setConfirmCancel(false);
          onPremiseChange(e.target.value);
        }}
          placeholder="例如：写一个赛博朋克风的侦探故事" />
        <button className="hbtn accent" disabled={!premise.trim() || busy}
          onClick={submit}>
          {busy ? '正在创建…' : '开始 ✍️'}
        </button>
        <input ref={importRef} hidden type="file" accept=".json,application/json"
          onChange={(event) => { void importBackup(event.currentTarget.files?.[0]); }} />
        <button className="hbtn" disabled={busy} onClick={() => importRef.current?.click()}>⇧ 导入小说备份</button>
        <button className="hbtn" disabled={busy} onClick={onOpenSettings}>⚙️ 先配置 API</button>
        {onCancel && <button className={confirmCancel ? 'hbtn accent' : 'hbtn'} disabled={busy}
          onClick={cancel}>{confirmCancel ? '确认丢弃并返回？' : '返回书架'}</button>}
      </article>
    </div>
  );
}
