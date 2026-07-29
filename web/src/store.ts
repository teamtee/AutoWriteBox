import type { BookTree, Chapter } from './types';

export type Selection =
  | { kind: 'outline' }
  | { kind: 'core' }
  | { kind: 'chapter'; sectionId: string; chapterId: string };

export function findChapter(tree: BookTree, sel: Selection): Chapter | null {
  if (sel.kind !== 'chapter') return null;
  const sec = tree.sections.find((s) => s.id === sel.sectionId);
  return sec?.chapters.find((c) => c.id === sel.chapterId) ?? null;
}

export function firstSelectable(tree: BookTree): Selection {
  for (const s of tree.sections) {
    if (s.chapters.length) return { kind: 'chapter', sectionId: s.id, chapterId: s.chapters[0].id };
  }
  return { kind: 'outline' };
}
