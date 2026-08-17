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
  worldProgression: {
    layer: '当前生活圈' | '中期势力与地域' | '长线文明与历史';
    stagePromise: string;
    evidence: string;
    characterAction: string;
    choiceAndCost: string;
    knowledgeGain: string;
    protectedUnknown: string;
    gateOutcome: 'hold' | 'open-next' | 'complete-long';
    gateCondition: string;
    gateProgress: string;
  };
}
export interface CoreSettings { world: Versioned; style: Versioned; constraints: Versioned; pacing: Versioned; }
export interface WorldBibleDiagnostics {
  valid: boolean;
  characters: number;
  sectionCount: number;
  missingSections: string[];
  thinSections: string[];
  issues: string[];
}
export interface StyleBibleDiagnostics extends WorldBibleDiagnostics {}
export interface StoryEngineInput {
  readerExperience: string;
  protagonistAction: string;
  progression: string;
  cost: string;
  escalation: string;
}
export interface StoryEngine extends StoryEngineInput {
  revision: string;
  isEmpty: boolean;
}
export type PromiseKind = 'main' | 'character' | 'mystery' | 'relationship'
  | 'growth' | 'world' | 'other';
export type PromiseStatus = 'planned' | 'open' | 'paid' | 'abandoned';
export type PromiseNarrativeBeat = 'plant' | 'pressure' | 'misdirect'
  | 'reinterpret' | 'collide' | 'payoff';
export type PromiseWorldLink = 'none' | 'deepen-current' | 'support-gate';
export interface PromiseProgressEvent {
  id: string;
  chapter: number;
  note: string;
  beat?: PromiseNarrativeBeat;
  readerBefore?: string;
  readerAfter?: string;
  actionConsequence?: string;
  worldLink?: PromiseWorldLink;
  worldEffect?: string;
  evidence?: string;
  source?: { sectionId: string; chapterId: string; bodyFingerprint: string };
  status?: 'active' | 'stale';
  confirmedAt?: string;
}
export interface PromiseLedgerEntryInput {
  id: string;
  kind: PromiseKind;
  status: PromiseStatus;
  importance: number;
  promise: string;
  introducedChapter: number | null;
  expectedStartChapter: number;
  expectedEndChapter: number;
  progress: PromiseProgressEvent[];
  resolution: string;
  resolvedChapter: number | null;
  nextPromise: string;
  notes: string;
}
export interface PromiseLedgerEntry extends PromiseLedgerEntryInput {
  createdAt: string;
  updatedAt: string;
}
export interface PromiseLedger {
  entries: PromiseLedgerEntry[];
  revision: string;
}
export interface PromiseLedgerMutationResult {
  entry: PromiseLedgerEntry;
  revision: string;
}
export interface CharacterGuideInput {
  id: string;
  name: string;
  importance: number;
  asOfChapter: number | null;
  currentDesire: string;
  fear: string;
  secret: string;
  pressureResponse: string;
  speechPattern: string;
  speechAvoid: string;
  notes: string;
}
export interface CharacterGuide extends CharacterGuideInput {
  createdAt: string;
  updatedAt: string;
}
export interface RelationshipTemperatureChange {
  id: string;
  chapter: number;
  temperature: number;
  reason: string;
}
export interface RelationshipGuideInput {
  id: string;
  from: string;
  to: string;
  importance: number;
  asOfChapter: number | null;
  temperature: number;
  surfaceState: string;
  privateTension: string;
  desiredDirection: string;
  changes: RelationshipTemperatureChange[];
  notes: string;
}
export interface RelationshipGuide extends RelationshipGuideInput {
  createdAt: string;
  updatedAt: string;
}
export interface CharacterCraft {
  characters: CharacterGuide[];
  relationships: RelationshipGuide[];
  revision: string;
}
export interface CharacterCraftMutationResult<T = CharacterGuide | RelationshipGuide> {
  entry: T;
  revision: string;
}
export type TitleSource = 'default' | 'ai' | 'manual';
export interface ChapterPlanScene {
  title: string;
  trigger?: string;
  desire: string;
  obstacle: string;
  action: string;
  turn: string;
  cost: string;
}
export interface ChapterPlanInput {
  qualityProtocolVersion: 0 | 1 | 2 | 3;
  designProtocolVersion: 0 | 1;
  rhythmIntentVersion: 0 | 1;
  rhythmIntent: ChapterRhythmIntent;
  goal: string;
  obstacle: string;
  choice: string;
  payoff: string;
  hook: string;
  tensionArc: string;
  foreshadowing: string;
  worldExpansion: string;
  decisionChain: string;
  knowledgeDesign: string;
  notes: string;
  scenes: ChapterPlanScene[];
}
export interface ChapterRhythmIntent {
  pressurePattern: ChapterPressurePattern | '';
  resolutionMethod: ChapterResolutionMethod | '';
  payoffScale: ChapterPayoffScale | '';
  hookMechanism: ChapterHookMechanism | '';
  costType: ChapterCostType | '';
}
export interface ChapterPlan extends ChapterPlanInput {
  revision: string;
  isEmpty: boolean;
  readiness?: {
    ready: boolean;
    checks: Array<{
      id: string; label: string; pass: boolean; advisory?: boolean; detail: string;
    }>;
  };
}
export interface ChapterPlanDraftResult {
  plan: ChapterPlanInput;
  basePlanRevision: string;
}
export type ChapterPlanOutcome = 'fulfilled' | 'adapted' | 'missed' | 'unclear';
export type ChapterPlanComparisonOverall = 'aligned' | 'adapted' | 'partial'
  | 'diverged' | 'na';
export type ChapterPlanCarryoverField = Exclude<
  keyof ChapterPlanInput,
  'scenes' | 'qualityProtocolVersion' | 'designProtocolVersion'
  | 'rhythmIntentVersion' | 'rhythmIntent'
>;
export interface ChapterPlanComparisonItem {
  target: string;
  outcome: ChapterPlanOutcome;
  evidence: string;
}
export interface ChapterPlanCarryoverItem {
  sourceTarget: string;
  text: string;
  reason: string;
  suggestedField: ChapterPlanCarryoverField;
}
export interface ChapterPlanComparison {
  overall: ChapterPlanComparisonOverall;
  summary: string;
  items: ChapterPlanComparisonItem[];
  carryovers: ChapterPlanCarryoverItem[];
}
export interface IncomingChapterPlanCarryover {
  sourceChapterId: string;
  sourceChapterTitle: string;
  sourceBodyFingerprint: string;
  sourcePlanRevision: string;
  summary: string;
  items: ChapterPlanCarryoverItem[];
}
export interface ChapterPromiseActionOption {
  id: string;
  status: 'planned' | 'open';
  promise: string;
  importance: number;
  expectedStartChapter: number;
  expectedEndChapter: number;
  urgent: boolean;
  overdue: boolean;
  lastBeat?: PromiseNarrativeBeat;
  lastReaderAfter?: string;
  recentBeatPattern?: PromiseNarrativeBeat[];
}
export type ChapterContextItemStatus = 'included' | 'missing' | 'not-applicable';
export interface ChapterContextManifestItem {
  id: string; label: string; status: ChapterContextItemStatus;
  characters: number; count?: number; note?: string; truncated: boolean;
}
export interface ChapterContextManifestLayer {
  id: string; label: string; items: ChapterContextManifestItem[];
}
export interface ChapterContextManifestWarning {
  id: string; severity: 'risk' | 'advisory'; message: string;
}
export interface ChapterProseMetrics {
  chars: number; paragraphs: number; avgParagraphChars: number;
  dialogueRatio: number; sensoryHits: number; sensoryDensity: number;
  longestNarrationChars: number;
}
export interface ChapterProseReferenceRow {
  id: string; label: string; unit: string;
  reference: number; actual: number; belowReference: boolean;
}
export interface ChapterProseTrendRow {
  bookChapterIndex: number; chars: number; avgParagraphChars: number;
  dialogueRatio: number; sensoryDensity: number; longestNarrationChars: number;
}
export interface ChapterProseTrend {
  measuredCount: number; rows: ChapterProseTrendRow[];
  risks: { id: string; severity: 'risk' | 'advisory'; bookChapterIndexes: number[]; message: string }[];
}
export interface ChapterContextBudgetLayer {
  id: string; label: string; want: number; characters: number;
  floor: number; priority: number; truncated: boolean;
}
export interface ChapterContextBudget {
  ceiling: number; fixedOverheadCharacters: number; assignableCharacters: number;
  remainingCharacters: number; layers: ChapterContextBudgetLayer[];
}
export interface ChapterContextManifest {
  schemaVersion: 1; bookChapterIndex: number;
  layers: ChapterContextManifestLayer[];
  budget?: ChapterContextBudget;
  prose?: {
    current: ChapterProseMetrics | null;
    reference: ChapterProseReferenceRow[] | null;
    trend: ChapterProseTrend;
  };
  warnings: ChapterContextManifestWarning[];
  riskCount: number; advisoryCount: number; truncatedItems: string[];
}
export interface Chapter {
  id: string; index: number; title: string; titleSource: TitleSource;
  body: Versioned; content: string;                                  // content 为派生只读
  bodyFingerprint: string;
  plan: ChapterPlan;
  characters: Character[]; summary: string; progress: string; status: string;
  handoff?: ChapterHandoff;
  reviewContextRevision?: string;
  reviewRevision?: string;
  contextManifest?: ChapterContextManifest;
  review?: ChapterReview;
  incomingPlanCarryover?: IncomingChapterPlanCarryover | null;
  promiseActions?: ChapterPromiseActionOption[];
  promiseLedgerRevision?: string;
  worldProgressRevision?: string;
  memoryCandidates?: MemoryCandidate[];
  memoryRevision?: string;
  published?: PublishedChapter | null;
  goldenThreeReviewState?: GoldenThreeReviewState;
}
export interface ChapterHandoff {
  viewpoint: string; time: string; location: string; ongoingAction: string;
  immediatePressure: string; characterState: string; resourceState: string;
  knowledgeBoundary: string; unresolvedCausality: string;
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
  reviewCurrent?: boolean;
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
    storyEngine: StoryEngine;
    worldBibleDiagnostics?: WorldBibleDiagnostics;
    styleBibleDiagnostics?: StyleBibleDiagnostics;
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
  chapterWordTarget: number; requestTimeoutMs: number;
  modelContextChars: number; revision: string;
}
export interface ApiProfile {
  id: string;
  name: string;
  note: string;
  baseUrl: string;
  apiKey: string;
  models: string[];
  modelContextChars?: Record<string, number>;
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
  modelContextChars?: Record<string, number>;
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
  | 'obstacleEscalation' | 'characterChoice' | 'sceneExecution'
  | 'effectiveIncrement' | 'payoff'
  | 'endingHook' | 'tensionDynamics' | 'foreshadowingExecution'
  | 'worldExpansion' | 'proseHumanity'
  | 'expressionBalance' | 'repetitionRisk' | 'longArcProgress'
  | 'styleConsistency' | 'packagingPromise' | 'contentRisk';
export type ChapterReviewCheckStatus = 'pass' | 'risk' | 'na';
export interface ChapterReviewCheck {
  id: ChapterReviewCheckId;
  status: ChapterReviewCheckStatus;
  detail: string;
  evidence?: string;
  goldenEvidence?: { setupQuote: string; fulfillmentQuote: string };
  premiseEvidence?: { promiseQuote: string; deliveryQuote: string };
  goalEvidence?: { goalQuote: string; attemptQuote: string };
  obstacleEvidence?: { baseQuote: string; escalatedQuote: string };
  sceneEvidence?: { actionQuote: string; reactionQuote: string; turnQuote: string };
  incrementEvidence?: { triggerQuote: string; stateQuote: string };
  choiceEvidence?: { pressureQuote: string; choiceQuote: string };
  costEvidence?: { choiceQuote: string; consequenceQuote: string };
  payoffEvidence?: { actionQuote: string; resultQuote: string };
  hookEvidence?: { setupQuote: string; hookQuote: string };
  tensionEvidence?: { pressureQuote: string; shiftQuote: string; aftermathQuote: string };
  longArcEvidence?: { threadQuote: string; progressQuote: string };
}
export interface ChapterReviewSignals {
  chapterFunction: string;
  conflictType: string;
  emotionTone: string;
  payoffType: string;
  dominantMode: string;
  rhythmFingerprint?: ChapterRhythmFingerprint;
}
export type ChapterPressurePattern = 'steady-rise' | 'wave-rise' | 'false-relief'
  | 'reversal-led' | 'choice-led' | 'aftermath';
export type ChapterResolutionMethod = 'none' | 'force' | 'skill' | 'wit' | 'negotiation'
  | 'sacrifice' | 'cooperation' | 'endurance' | 'discovery' | 'failure' | 'mixed';
export type ChapterPayoffScale = 'none' | 'micro' | 'chapter' | 'stage' | 'major';
export type ChapterHookMechanism = 'none' | 'new-threat' | 'new-information'
  | 'unfinished-action' | 'forced-choice' | 'relationship-shift' | 'world-opening'
  | 'deadline' | 'aftermath-question';
export type ChapterCostType = 'none' | 'physical' | 'resource' | 'identity'
  | 'relationship' | 'moral' | 'time' | 'position' | 'knowledge' | 'mixed';
export interface ChapterRhythmFingerprint {
  pressurePattern: ChapterPressurePattern;
  resolutionMethod: ChapterResolutionMethod;
  payoffScale: ChapterPayoffScale;
  hookMechanism: ChapterHookMechanism;
  costType: ChapterCostType;
}
export type ChapterReviewPromiseAction = 'establish' | 'advance' | 'pay';
export interface ChapterReviewPromiseCandidate {
  entryId: string;
  action: ChapterReviewPromiseAction;
  promise: string;
  summary: string;
  evidence: string;
  beat: PromiseNarrativeBeat;
  readerBefore: string;
  readerAfter: string;
  actionConsequence: string;
  worldLink: PromiseWorldLink;
  worldEffect: string;
}
export interface ChapterReviewWorldGateCandidate {
  fromLayer: string;
  toLayer: string;
  gateCondition: string;
  summary: string;
  evidence: string;
}
export interface ConfirmedWorldGate extends ChapterReviewWorldGateCandidate {
  id: string;
  source: { sectionId: string; chapterId: string; bodyFingerprint: string };
  status: 'active' | 'stale';
  confirmedAt: string;
}
export interface WorldProgressMutationResult {
  gate: ConfirmedWorldGate;
  revision: string;
  alreadyApplied?: boolean;
}
export interface ChapterReview {
  score: number; verdict: string;
  issues: ReviewIssue[]; suggestions: ReviewSuggestion[];
  webFictionChecks?: ChapterReviewCheck[];
  webFictionSignals?: ChapterReviewSignals;
  planComparison?: ChapterPlanComparison;
  promiseLedgerCandidates?: ChapterReviewPromiseCandidate[];
  worldGateCandidates?: ChapterReviewWorldGateCandidate[];
  sourcePlanRevision?: string;
  sourceCursor: number; sourceFingerprint?: string; sourceContextRevision?: string; updatedAt: string;
}

export type GoldenThreeCheckId = 'premisePromise' | 'protagonistAttachment'
  | 'protagonistDrive' | 'coreLoop' | 'centralConflict' | 'differentiation'
  | 'firstPayoff' | 'threeChapterEscalation' | 'continuationPull';
export interface GoldenThreeEvidence {
  chapter: 1 | 2 | 3;
  quote?: string;
  analysis?: string;
  detail?: string;
}
export interface GoldenThreeCheck {
  id: GoldenThreeCheckId; status: 'pass' | 'risk'; summary: string;
  evidence: GoldenThreeEvidence[];
}
export type GoldenThreeFixTarget = 'chapter-1' | 'chapter-2' | 'chapter-3' | 'all';
export interface GoldenThreeFix {
  target: GoldenThreeFixTarget; label: string; problem: string; instruction: string;
}
export interface GoldenThreeSource {
  sectionId: string; chapterId: string; bookChapterIndex: 1 | 2 | 3;
  title: string; bodyFingerprint: string;
}
export interface GoldenThreeReview {
  score: number; verdict: string; checks: GoldenThreeCheck[]; fixes: GoldenThreeFix[];
  sourceContextRevision: string; sources: GoldenThreeSource[]; updatedAt: string;
}
export interface GoldenThreeReviewState {
  ready: boolean; reason: 'chapters' | 'body' | null;
  availableChapterCount: number; completedChapterCount: number;
  missingChapterIndexes: number[]; sources: GoldenThreeSource[];
  contextRevision?: string; review?: GoldenThreeReview; isCurrent: boolean;
}

export type ChapterRevisionStage = 'scene-grounding' | 'abstract-summary'
  | 'rhetoric-repetition' | 'character-voice' | 'intensity-shape'
  | 'low-value-paragraphs';
export interface ChapterRevisionStyleMetrics {
  contrastFormulaCount: number;
  authorVerdictCount?: number;
  sceneSummaryShellCount?: number;
  simileMarkerCount: number;
  emDashCount: number;
  shortParagraphRatio: number;
  maxConsecutiveSimilarParagraphs?: number;
  repeatedPhraseClusterCount?: number;
  repeatedPhraseExcessCount?: number;
}
export interface ChapterRevisionImprovement {
  sourceMetrics: ChapterRevisionStyleMetrics;
  candidateMetrics: ChapterRevisionStyleMetrics;
  targetEvidenceRemoved: boolean | null;
  noStyleRegression: boolean;
  targetImproved: boolean;
  valid: boolean;
}
export interface ChapterRevisionCandidateResult {
  stage: ChapterRevisionStage; candidate: string; changed: boolean;
  improvement?: ChapterRevisionImprovement;
  sourceBodyFingerprint: string; sourceContextRevision: string;
}
export interface ChapterReviewRevisionCandidateResult {
  candidate: string; changed: boolean;
  improvement?: ChapterRevisionImprovement;
  sourceBodyFingerprint: string; sourceContextRevision: string;
  sourceReviewRevision: string; candidateFingerprint: string;
}
export interface ChapterReviewRevisionVerificationResult {
  review: ChapterReview; verified: boolean;
  remainingRiskCount: number; remainingPlanRiskCount: number;
  candidateFingerprint: string;
  sourceBodyFingerprint: string; sourceContextRevision: string;
  sourceReviewRevision: string;
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
  aliases?: string[];
  autoAccepted?: boolean;
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
  aliases?: string[];
  autoAccepted?: boolean;
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
