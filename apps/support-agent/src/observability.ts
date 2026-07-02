// SPDX-License-Identifier: Apache-2.0

export type SpanName =
  | "support.chat"
  | "memory.retrieve"
  | "memory.enqueue"
  | "memory.extract"
  | "memory.revise"
  | "admin.action";

export interface SpanRecord {
  name: SpanName;
  attributes: Record<string, string | number | boolean | undefined>;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  status: "ok" | "error";
}

export interface SentryEvent {
  release: string;
  environment: string;
  tags: Record<string, string>;
  extra: Record<string, unknown>;
}

const emailPattern = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const phonePattern = /\+?\d[\d .()-]{7,}\d/g;

export class Observability {
  private spans: SpanRecord[] = [];

  async withSpan<T>(
    name: SpanName,
    attributes: Record<string, string | number | boolean | undefined>,
    action: () => Promise<T> | T,
  ): Promise<T> {
    const started = performance.now();
    const startedAt = new Date().toISOString();
    try {
      const result = await action();
      this.record(name, attributes, startedAt, started, "ok");
      return result;
    } catch (error) {
      this.record(name, attributes, startedAt, started, "error");
      throw error;
    }
  }

  recentSpans(limit = 50) {
    return this.spans.slice(-limit);
  }

  buildSentryEvent(error: unknown, context: Record<string, unknown>): SentryEvent {
    return {
      release: process.env.RELEASE_VERSION ?? "local",
      environment: process.env.NODE_ENV ?? "development",
      tags: {
        service: "support-agent-v2",
        component: "memory-runtime",
      },
      extra: {
        error: scrub(error instanceof Error ? error.message : String(error)),
        ...Object.fromEntries(Object.entries(context).map(([key, value]) => [key, scrubValue(value)])),
      },
    };
  }

  private record(
    name: SpanName,
    attributes: Record<string, string | number | boolean | undefined>,
    startedAt: string,
    started: number,
    status: SpanRecord["status"],
  ) {
    this.spans.push({
      name,
      attributes,
      startedAt,
      endedAt: new Date().toISOString(),
      durationMs: Math.round((performance.now() - started) * 100) / 100,
      status,
    });
  }
}

export function scrub(value: string) {
  return value.replace(emailPattern, "[REDACTED_EMAIL]").replace(phonePattern, "[REDACTED_PHONE]");
}

function scrubValue(value: unknown): unknown {
  if (typeof value === "string") return scrub(value);
  if (Array.isArray(value)) return value.map(scrubValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, inner]) => [
        key,
        ["authorization", "x-api-key", "apiKey", "secret", "message"].includes(key) ? "[REDACTED]" : scrubValue(inner),
      ]),
    );
  }
  return value;
}

export const observability = new Observability();
