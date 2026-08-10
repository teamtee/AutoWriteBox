export interface Character { name: string; role: string; desc: string; }
export interface Versioned { versions: string[]; cursor: number; revision?: string; }
export interface Outline { content: string; history: string[]; }   // 仅 section.outline 仍用
export interface SectionPlan {
  title: string;
  summary: string;
  promise: string;
  goal: string;
  obstacle: string;
  progress: string;
  climax: string;
  payoff: string;
  stateChange: string;
}
export interface CoreSettings { world: Versioned; style: Versioned; constraints: Versioned; pacing: Versioned; }
export type TitleSource = 'default' | 'ai' | 'manual';
export interface Chapter {
  id: string; index: number; title: string; titleSource: TitleSource;
  body: Versioned; content: string;                                  // content 为派生只读
  bodyFingerprint: string;
  characters: Character[]; summary: string; progress: string; status: string;
  reviewContextRevision?: string;
  review?: ChapterReview;
  memoryCandidates?: MemoryCandidate[];
  memoryRevision?: string;
  published?: PublishedChapter | null;
}
export interface PublishedChapter {
  content: string;
  bodyFingerprint: string;
  publishedAt: string;
  publicationNumber: number;
  isCurrent: boolean;
}
export interface ChapterPublicationResult {
  published: PublishedChapter;
  memoryRevision: string;
}
export type PublicationPreflightCheckStatus = 'pass' | 'risk' | 'pending' | 'manual';
export interface PublicationPreflightCheck {
  id: string;
  label: string;
  status: PublicationPreflightCheckStatus;
  detail: string;
}
export interface PublicationDuplicateMatch {
  sectionId: string;
  chapterId: string;
  chapterIndex: number;
  title: string;
}
export interface ChapterPublicationPreflight {
  bodyFingerprint: string;
  checkedAt: string;
  status: 'ready' | 'attention' | 'risk';
  characterCount: number;
  paragraphCount: number;
  reviewCurrent: boolean;
  duplicateCount: number;
  duplicateMatches: PublicationDuplicateMatch[];
  checks: PublicationPreflightCheck[];
}
export interface ChapterSummary {
  id: string; index: number; title: string; titleSource: TitleSource;
  status: string; hasContent: boolean;
  characterCount?: number;
  publicationStatus?: 'unpublished' | 'published' | 'modified';
  publishedAt?: string;
  publicationNumber?: number;
  publishedCharacterCount?: number;
}
export interface SectionBase {
  id: string; index: number; title: string; titleSource: TitleSource; outline: Outline;
  characters: Character[]; summary: string; progress: string;
}
export interface Section extends SectionBase { chapters: string[]; }
export interface BookSection {
  id: string; index: number; title: string; titleSource: TitleSource;
  chapters: ChapterSummary[];
}
export interface Book {
  id: string; title: string; titleSource: TitleSource; createdAt: string; updatedAt: string;
  premise: string; outline: Versioned;
  settings: {
    core: CoreSettings;
    history: string[];
    serialization?: SerializationSettings;
  };
  characters: Character[]; summary: string; progress: string; sections: string[];
}
export interface SerializationSettings {
  dailyWordGoal: number;
  revision: string;
  platformConfirmations?: PlatformConfirmation[];
  syncPolicy?: PlatformSyncPolicy;
}
export type PlatformApiStatus = 'not-found' | 'not-authorized' | 'authorized';
export interface PlatformSyncGate {
  automaticSyncAvailable: false;
  eligibleForFutureIntegration: boolean;
  reason: string;
}
export interface PlatformConfirmation {
  id: string;
  platform: string;
  rulesUrl: string;
  aiPolicyUrl: string;
  contractReference: string;
  officialApiStatus: PlatformApiStatus;
  apiDocsUrl: string;
  confirmations: { rules: true; aiPolicy: true; contract: true; noBypass: true };
  checkedAt: string;
  reviewStatus: 'current' | 'stale';
  reviewAfter: string;
  syncGate: PlatformSyncGate;
}
export interface PlatformConfirmationInput {
  id?: string;
  platform: string;
  rulesUrl: string;
  aiPolicyUrl: string;
  contractReference: string;
  officialApiStatus: PlatformApiStatus;
  apiDocsUrl: string;
  confirmRules: boolean;
  confirmAiPolicy: boolean;
  confirmContract: boolean;
  confirmNoBypass: boolean;
}
export interface PlatformSyncPolicy {
  mode: 'manual-only';
  automaticSyncAvailable: false;
  allowedIntegration: 'official-authorized-api-only';
  prohibitedMethods: string[];
}
export interface BookTree {
  book: Pick<Book, 'id' | 'title' | 'titleSource' | 'outline' | 'settings'> & {
    sectionPlanContextRevision?: string;
  };
  sections: BookSection[];
}
export interface BookSummary { id: string; title: string; updatedAt: string; sectionCount: number; chapterCount: number; }
export interface StorageIssue {
  code: string; bookId: string; sectionId?: string; chapterId?: string; path?: string;
}
export interface StorageDiagnostics {
  ok: boolean; mode: 'quick' | 'deep'; scannedBooks: number; issues: StorageIssue[];
  totalBooks?: number; truncated?: boolean; issueLimit?: number;
}
export interface DeletedBook {
  trashId: string; bookId: string; title: string; deletedAt: string;
  invalid?: boolean; issueCode?: string; restoreBlockedByActiveBook?: boolean;
  validationDeferred?: boolean;
}
export interface Config {
  baseUrl: string; model: string; apiKey: string;
  chapterWordTarget: number; requestTimeoutMs: number; revision: string;
}
export interface ApiProfile {
  id: string;
  name: string;
  note: string;
  baseUrl: string;
  apiKey: string;
  models: string[];
  selectedModel: string;
  createdAt: string;
  updatedAt: string;
}
export interface ApiProfileLibrary {
  version: 1;
  activeProfileId: string | null;
  profiles: ApiProfile[];
  taskRoutes: ApiTaskRoutes;
  bookBindings: ApiBookBinding[];
  revision: string;
}
export type ApiModelTask = 'chapter' | 'outline' | 'digest' | 'review' | 'title';
export interface ApiTaskRoute { profileId: string; model: string; }
export interface ApiBookBinding extends ApiTaskRoute { bookId: string; }
export type ApiTaskRoutes = Record<ApiModelTask, ApiTaskRoute | null>;
export interface ApiProfileSaveInput {
  id?: string;
  name: string;
  note: string;
  baseUrl?: string;
  apiKey?: string;
  models: string[];
  selectedModel: string;
  useCurrentConfig?: boolean;
}
export interface ApiModelDiscoveryResult {
  ok: true;
  models: string[];
  truncated: boolean;
  currentModel: string;
  currentModelAvailable: boolean;
}
export type ApiModelDiscoveryInput = {
  target: 'current'; expectedConfigRevision: string;
} | {
  target: 'profile'; profileId: string; expectedProfilesRevision: string;
};
export interface ReviewIssue { title: string; detail: string; }
export interface ReviewSuggestion { label: string; instruction: string; }
export type ChapterReviewCheckId = 'goldenChapter' | 'premisePromise' | 'chapterGoal'
  | 'obstacleEscalation' | 'characterChoice' | 'effectiveIncrement' | 'payoff'
  | 'endingHook' | 'expressionBalance' | 'repetitionRisk' | 'longArcProgress'
  | 'styleConsistency' | 'packagingPromise' | 'contentRisk';
export type ChapterReviewCheckStatus = 'pass' | 'risk' | 'na';
export interface ChapterReviewCheck {
  id: ChapterReviewCheckId;
  status: ChapterReviewCheckStatus;
  detail: string;
}
export interface ChapterReviewSignals {
  chapterFunction: string;
  conflictType: string;
  emotionTone: string;
  payoffType: string;
  dominantMode: string;
}
export interface ChapterReview {
  score: number; verdict: string;
  issues: ReviewIssue[]; suggestions: ReviewSuggestion[];
  webFictionChecks?: ChapterReviewCheck[];
  webFictionSignals?: ChapterReviewSignals;
  sourceCursor: number; sourceFingerprint?: string; sourceContextRevision?: string; updatedAt: string;
}

export type MemoryKind = 'character' | 'relationship' | 'ability' | 'item' | 'location'
  | 'timeline' | 'faction' | 'foreshadowing' | 'knowledge' | 'other';
export interface MemoryDetails {
  target?: string;
  relationType?: string;
  strength?: 'weak' | 'medium' | 'strong' | 'unknown';
  visibility?: 'public' | 'limited' | 'secret' | 'unknown';
  changeReason?: string;
  eventType?: 'acquired' | 'upgraded' | 'used' | 'transferred' | 'damaged'
    | 'destroyed' | 'moved' | 'status' | 'occurred' | 'other';
  owner?: string;
  origin?: string;
  quantity?: string;
  status?: string;
  lastLocation?: string;
  cost?: string;
  limitation?: string;
  from?: string;
  to?: string;
  time?: string;
  order?: string;
  duration?: string;
  participants?: string[];
  location?: string;
  role?: string;
  alignment?: string;
  goal?: string;
  relations?: string;
  territory?: string;
  foreshadowStatus?: 'planted' | 'progressing' | 'resolved' | 'abandoned';
  readerKnowledge?: string;
  plannedPayoff?: string;
  actualPayoff?: string;
  dueChapter?: string;
  knowledgeOwner?: 'author' | 'reader' | 'character';
  knower?: string;
  information?: string;
  learnedAt?: string;
}
export type MemoryCandidateStatus = 'pending' | 'accepted' | 'rejected' | 'stale' | 'superseded';
export interface MemoryCandidate {
  id: string;
  kind: MemoryKind;
  subject: string;
  predicate: string;
  object: string;
  evidence: string;
  importance: number;
  details?: MemoryDetails;
  sourceFingerprint: string;
  extractedAt: string;
  status: MemoryCandidateStatus;
}
export type MemoryDecisionAction = 'accept' | 'reject' | 'replace';
export interface MemoryDecisionResult {
  candidate: MemoryCandidate;
  candidates: MemoryCandidate[];
  memoryRevision: string;
}
export type MemoryFactStatus = 'active' | 'stale' | 'superseded';
export interface MemoryFact {
  id: string;
  kind: MemoryKind;
  subject: string;
  predicate: string;
  object: string;
  evidence: string;
  importance: number;
  details?: MemoryDetails;
  status: MemoryFactStatus;
  source: {
    sectionId: string;
    chapterId: string;
    chapterIndex: number;
    bodyFingerprint: string;
  };
  confirmedAt: string;
  updatedAt: string;
}
export interface BookMemoryLibrary {
  facts: MemoryFact[];
  plotSummary: string;
  sectionSummaryCount: number;
  memoryRevision: string;
  stageSummaries: StageSummary[];
  stageSummaryRevision: string;
}
export interface MemoryFactMutationResult {
  fact: MemoryFact;
  memoryRevision: string;
}

export type StageSummaryStatus = 'draft' | 'frozen';
export interface StageSummary {
  id: string;
  title: string;
  startSectionId: string;
  endSectionId: string;
  startSectionIndex: number;
  endSectionIndex: number;
  summary: string;
  status: StageSummaryStatus;
  sourceFingerprint: string;
  stale: boolean;
  createdAt: string;
  updatedAt: string;
}
export interface StageSummaryMutationResult {
  item: StageSummary;
  stageSummaryRevision: string;
}
export interface StageSummaryInput {
  id: string;
  title: string;
  startSectionId: string;
  endSectionId: string;
  summary?: string;
  status?: StageSummaryStatus;
}

export type WritingAssetSourceKind = 'self' | 'own-previous' | 'authorized'
  | 'public-domain' | 'excerpt' | 'link-only' | 'book-native';
export interface WritingAssetSource {
  kind: WritingAssetSourceKind;
  name: string;
  workNote: string;
  rightsNote: string;
  genres: string[];
  sceneTags: string[];
  referenceUrl: string;
  bookId: string;
  sectionId: string;
  chapterId: string;
  length: number;
  fingerprint: string;
  preview: string;
}
export interface WritingAssetStyle {
  summary: string;
  narrative: string;
  sentenceRhythm: string;
  vocabulary: string;
  dialogue: string;
  dialogueRatio: string;
  description: string;
  humor: string;
  emotion: string;
  emotionTemperature: string;
  conflictFrequency: string;
  payoffType: string;
  conflictAndPayoff: string;
  chapterHooks: string;
  prompt: string;
  avoid: string[];
}
export interface WritingAssetStory {
  summary: string;
  evidenceLevel: 'low' | 'medium' | 'high';
  premisePattern: string;
  protagonistDrive: string;
  conflictEngine: string;
  escalation: string;
  arcStructure: string;
  chapterPattern: string;
  payoffPattern: string;
  hookPattern: string;
  reusableTechniques: string[];
  uncertainties: string[];
}
export interface WritingAsset {
  id: string;
  name: string;
  createdAt: string;
  source: WritingAssetSource;
  style: WritingAssetStyle | null;
  story: WritingAssetStory | null;
}
export type WritingAssetScene = 'battle' | 'dialogue' | 'mystery'
  | 'romance' | 'daily' | 'climax';
export interface WritingAssetBookBinding {
  nativeAssetId: string | null;
  primaryAssetId: string | null;
  auxiliaryAssetIds: string[];
  sceneAssetIds: Partial<Record<WritingAssetScene, string>>;
  chapterScenes: Record<string, WritingAssetScene>;
}
export interface WritingAssetLibrary {
  revision: string;
  assets: WritingAsset[];
  bookBindings: Record<string, WritingAssetBookBinding>;
}
export interface WritingAssetExtractionInput {
  name: string;
  sourceName: string;
  sourceKind: WritingAssetSourceKind;
  sourceText: string;
  workNote?: string;
  rightsNote?: string;
  genres?: string[];
  sceneTags?: string[];
  referenceUrl?: string;
}
export interface WritingAssetReferenceInput {
  name: string;
  sourceName: string;
  sourceKind: 'link-only';
  workNote?: string;
  rightsNote?: string;
  genres?: string[];
  sceneTags?: string[];
  referenceUrl: string;
}
export interface WritingAssetExtractionResult {
  revision: string;
  asset: WritingAsset;
}
export interface WritingAssetBindingResult {
  revision: string;
  binding: WritingAssetBookBinding;
}
