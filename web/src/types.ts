export interface Character { name: string; role: string; desc: string; }
export interface Outline { content: string; history: string[]; }
export interface CoreSettings { world: string; style: string; constraints: string; pacing: string; }
export interface Chapter {
  id: string; index: number; title: string; content: string;
  characters: Character[]; summary: string; progress: string;
  status: string; history: string[];
}
export interface Section {
  id: string; index: number; title: string; outline: Outline;
  characters: Character[]; summary: string; progress: string;
  chapters: string[] | Chapter[];
}
export interface Book {
  id: string; title: string; createdAt: string; updatedAt: string;
  premise: string; outline: Outline;
  settings: { core: CoreSettings; history: string[] };
  characters: Character[]; summary: string; progress: string; sections: string[];
}
export interface BookTree { book: Book; sections: (Section & { chapters: Chapter[] })[]; }
export interface Config { baseUrl: string; model: string; apiKey: string; chapterWordTarget: number; }
