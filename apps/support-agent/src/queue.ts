import type { IngestInput, IngestResult } from "@atlas/support-contracts";
import type { MemoryStore } from "@atlas/memory-engine";

export interface IngestQueue {
  enqueue(input: IngestInput): Promise<IngestResult>;
  depth(): Promise<number>;
  dlqDepth(): Promise<number>;
}

export class LocalIngestQueue implements IngestQueue {
  constructor(private readonly store: MemoryStore) {}

  async enqueue(input: IngestInput) {
    return this.store.ingest(input);
  }

  async depth() {
    return 0;
  }

  async dlqDepth() {
    return 0;
  }
}

