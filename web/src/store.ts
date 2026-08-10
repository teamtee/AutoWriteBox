import type { BookTree } from './types';

export type Selection =
  | { kind: 'outline' }
  | { kind: 'core' }
  | { kind: 'serialization' }
  | { kind: 'chapter'; sectionId: string; chapterId: string };

export function firstSelectable(tree: BookTree): Selection {
  for (const s of tree.sections) {
    if (s.chapters.length) return { kind: 'chapter', sectionId: s.id, chapterId: s.chapters[0].id };
  }
  return { kind: 'outline' };
}

export function selectionExists(tree: BookTree, selection: Selection): boolean {
  if (selection.kind !== 'chapter') return true;
  return tree.sections.some((section) =>
    section.id === selection.sectionId
    && section.chapters.some((chapter) => chapter.id === selection.chapterId));
}
