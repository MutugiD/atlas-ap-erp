import { InMemoryNativeStore, PostgresNativeStore } from "@atlas/memory-engine";
import { BullMqIngestQueue } from "./queue";

const store = process.env.DATABASE_URL ? new PostgresNativeStore({ connectionString: process.env.DATABASE_URL }) : new InMemoryNativeStore();
const queue = process.env.REDIS_URL ? new BullMqIngestQueue(store, { redisUrl: process.env.REDIS_URL, startWorker: true }) : undefined;
console.log("Support Agent V2 worker started", { ready: await store.ready(), queue: queue ? "bullmq" : "local-fallback" });
