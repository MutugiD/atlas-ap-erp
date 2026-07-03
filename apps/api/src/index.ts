import { app } from "./app";

// Bun.serve defaults to a 10s idle timeout, which cuts off reprocess requests
// while a real LLM agent provider (Ollama/Bedrock) is extracting. Raise it so
// slow model calls can complete. Configurable via API_IDLE_TIMEOUT (max 255s).
export default {
  port: Number(process.env.PORT ?? 3001),
  idleTimeout: Math.min(255, Number(process.env.API_IDLE_TIMEOUT ?? 240)),
  fetch: app.fetch,
};

