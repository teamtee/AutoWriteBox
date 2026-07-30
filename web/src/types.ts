export interface Character { name: string; role: string; desc: string; }
export interface Versioned { versions: string[]; cursor: number; }
export interface Outline { content: string; history: string[]; }   // 仅 section.outline 仍用
export interface CoreSettings { world: Versioned; style: Versioned; constraints: Versioned; pacing: Versioned; }
export interface Chapter {
  id: string; index: number; title: string;
  body: Versioned; content: string;                                  // content 为派生只读
  characters: Character[]; summary: string; progress: string; status: string;
}
export interface Section {
  id: string; index: number; title: string; outline: Outline;
  characters: Character[]; summary: string; progress: string;
  chapters: string[] | Chapter[];
}
export interface Book {
  id: string; title: string; createdAt: string; updatedAt: string;
  premise: string; outline: Versioned;
  settings: { core: CoreSettings; history: string[] };
  characters: Character[]; summary: string; progress: string; sections: string[];
}
export interface BookTree { book: Book; sections: (Section & { chapters: Chapter[] })[]; }
export interface BookSummary { id: string; title: string; updatedAt: string; sectionCount: number; chapterCount: number; }
export interface Config { baseUrl: string; model: string; apiKey: string; chapterWordTarget: number; }
