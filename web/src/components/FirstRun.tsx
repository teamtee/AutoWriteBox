import { useState } from 'react';
import { createBook } from '../api';
import type { Book } from '../types';

export function FirstRun({ onCreated }: { onCreated: (book: Book) => void }) {
  const [premise, setPremise] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <div className="first-run">
      <article className="paper sketch first-card">
        <h1 className="paper-title">📖 自动小说盒子</h1>
        <p className="first-lead">用一句话，开始你的小说。你只管挥鞭子。</p>
        <textarea className="first-input" value={premise} onChange={(e) => setPremise(e.target.value)}
          placeholder="例如：写一个赛博朋克风的侦探故事" />
        <button className="hbtn accent" disabled={!premise.trim() || busy}
          onClick={async () => { setBusy(true); onCreated(await createBook(premise)); }}>
          {busy ? '正在创建…' : '开始 ✍️'}
        </button>
      </article>
    </div>
  );
}
