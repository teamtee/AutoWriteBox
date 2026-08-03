import { useRef, useState } from 'react';
import { createBook } from '../api';
import { runExclusiveAction } from '../asyncAction';
import type { Book } from '../types';
import { useToast } from './Toast';

export function FirstRun({ onCreated }: { onCreated: (book: Book) => void | Promise<void> }) {
  const [premise, setPremise] = useState('');
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const toast = useToast();
  const submit = async () => {
    await runExclusiveAction({
      isRunning: () => busyRef.current,
      setRunning: (running) => { busyRef.current = running; setBusy(running); },
      task: async () => {
        try {
          const book = await createBook(premise);
          await onCreated(book);
        } catch (e) {
          toast.error('创建失败：' + (e as Error).message);
        }
      },
    });
  };
  return (
    <div className="first-run">
      <article className="paper sketch first-card">
        <h1 className="paper-title">📖 自动小说盒子</h1>
        <p className="first-lead">用一句话，开始你的小说。你只管挥鞭子。</p>
        <textarea className="first-input" value={premise} onChange={(e) => setPremise(e.target.value)}
          placeholder="例如：写一个赛博朋克风的侦探故事" />
        <button className="hbtn accent" disabled={!premise.trim() || busy}
          onClick={submit}>
          {busy ? '正在创建…' : '开始 ✍️'}
        </button>
      </article>
    </div>
  );
}
