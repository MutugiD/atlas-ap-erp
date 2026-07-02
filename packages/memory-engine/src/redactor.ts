import type { Redactor } from "./types";

export class RegexRedactor implements Redactor {
  redact(text: string) {
    const redactions: Array<{ kind: string; value: string }> = [];
    let redacted = text.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, (value) => {
      redactions.push({ kind: "email", value });
      return "[REDACTED_EMAIL]";
    });
    redacted = redacted.replace(/\+?\d[\d\s().-]{7,}\d/g, (value) => {
      redactions.push({ kind: "phone", value });
      return "[REDACTED_PHONE]";
    });
    return { text: redacted, redactions };
  }
}

