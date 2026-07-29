import { useState } from 'react';
import { createBook } from '../api';
import type { Book } from '../types';

export function FirstRun({ onCreated }: { onCreated: (book: Book) => void }) {
  const [premise, setPremise] = useState('');
  return (
    <div className="first-run">
      <h1>自动小说盒子</h1>
      <p>用一句话，开始你的小说。你只管挥鞭子。</p>
      <textarea value={premise} onChange={(e) => setPremise(e.target.value)}
        placeholder="例如：写一个赛博朋克风的侦探故事" />
      <button disabled={!premise.trim()}
        onClick={async () => onCreated(await createBook(premise))}>开始</button>
    </div>
  );
}
