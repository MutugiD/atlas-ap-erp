import type {
  Artifact,
  ContextPrompt,
  Episode,
  Fact,
  IngestInput,
  IngestResult,
  MemoryType,
  RichTimeline,
  TimelineEntry,
} from "@atlas/support-contracts";

export interface CandidateFact {
  slotKey: string;
  subject: string;
  predicate: string;
  objectValue: string;
  canonicalText: string;
}

export interface Extractor {
  extract(text: string): CandidateFact[];
}

export interface Embedder {
  embed(text: string): Promise<number[]>;
}

export interface Redactor {
  redact(text: string): { text: string; redactions: Array<{ kind: string; value: string }> };
}

export interface RevisionResult {
  inserted: Fact[];
  superseded: Fact[];
  duplicate: number;
}

export interface MemoryStore {
  ingest(input: IngestInput): Promise<IngestResult>;
  retrieve(input: { orgId: string; userId: string; query?: string }): Promise<ContextPrompt>;
  getFact(input: { orgId: string; userId: string; factId: string }): Promise<Fact | null>;
  timeline(input: { orgId: string; userId: string }): Promise<TimelineEntry[]>;
  richTimeline(input: { orgId: string; userId: string }): Promise<RichTimeline>;
  listByType(input: { orgId: string; userId: string; type: MemoryType }): Promise<Array<Fact | Episode | Artifact>>;
  reset(input: { orgId: string; userId: string }): Promise<void>;
  ready(): Promise<boolean>;
}

