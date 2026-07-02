import { InMemoryNativeStore } from "@atlas/memory-engine";

const store = new InMemoryNativeStore();
console.log("Support Agent V2 worker started with local fallback queue", await store.ready());

