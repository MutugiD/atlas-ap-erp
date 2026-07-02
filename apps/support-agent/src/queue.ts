import type { IngestInput, IngestResult } from "@atlas/support-contracts";
import type { MemoryStore } from "@atlas/memory-engine";
import { Queue, Worker, type JobsOptions } from "bullmq";

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

export class BullMqIngestQueue implements IngestQueue {
  private readonly queue: Queue;
  private readonly dlq: Queue;
  private readonly worker?: Worker;

  constructor(
    private readonly store: MemoryStore,
    options: { redisUrl: string; startWorker?: boolean; jobOptions?: JobsOptions },
  ) {
    const connection = { url: options.redisUrl, maxRetriesPerRequest: null } as never;
    this.queue = new Queue("support-agent-ingest", {
      connection,
      defaultJobOptions: options.jobOptions ?? {
        attempts: 5,
        backoff: { type: "exponential", delay: 500 },
        removeOnComplete: 1000,
        removeOnFail: false,
      },
    });
    this.dlq = new Queue("support-agent-ingest-dlq", { connection });
    if (options.startWorker) {
      this.worker = new Worker(
        "support-agent-ingest",
        async (job) => this.store.ingest(job.data as IngestInput),
        { connection, concurrency: Number(process.env.INGEST_WORKER_CONCURRENCY ?? 4) },
      );
      this.worker.on("failed", async (job, error) => {
        if (job && job.attemptsMade >= (job.opts.attempts ?? 1)) {
          await this.dlq.add("dead-letter", { ...(job.data as IngestInput), failedReason: error.message });
        }
      });
    }
  }

  async enqueue(input: IngestInput): Promise<IngestResult> {
    const id = `${input.orgId}:${input.userId}:${input.convId}:${await hashMessage(input.message)}`;
    await this.queue.add("ingest-turn", input, { jobId: id });
    return { queued: true, inserted: 0, superseded: 0, duplicate: 0, factIds: [] };
  }

  async depth() {
    return this.queue.count();
  }

  async dlqDepth() {
    return this.dlq.count();
  }

  async close() {
    await this.worker?.close();
    await this.queue.close();
    await this.dlq.close();
  }
}

async function hashMessage(message: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(message));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
