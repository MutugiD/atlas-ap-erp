import type { CandidateFact, Extractor } from "./types";

function canonical(slotKey: string, value: string) {
  const labels: Record<string, string> = {
    plan: "Customer plan is",
    crm_tool: "Customer uses",
    contact_channel: "Preferred contact channel is",
    email: "Customer email is",
    phone: "Customer phone is",
    timezone: "Customer timezone is",
    account_tier: "Account tier is",
    support_preference: "Support preference is",
  };
  return `${labels[slotKey] ?? slotKey} ${value}`;
}

export class SlotExtractor implements Extractor {
  extract(text: string): CandidateFact[] {
    const found: CandidateFact[] = [];
    const lower = text.toLowerCase();
    const add = (slotKey: string, value: string, predicate = "is") => {
      found.push({
        slotKey,
        subject: "customer",
        predicate,
        objectValue: value,
        canonicalText: canonical(slotKey, value),
      });
    };

    for (const plan of ["enterprise", "pro", "starter", "free"]) {
      if (new RegExp(`\\b${plan}\\b`, "i").test(text) && /(plan|upgraded|downgraded|tier|subscription)/i.test(text)) {
        add("plan", plan[0].toUpperCase() + plan.slice(1));
        break;
      }
    }

    for (const tool of ["netsuite", "quickbooks", "salesforce", "hubspot", "zendesk"]) {
      if (lower.includes(tool)) {
        add("crm_tool", tool === "netsuite" ? "NetSuite" : tool[0].toUpperCase() + tool.slice(1), "uses");
        break;
      }
    }

    for (const channel of ["slack", "email", "phone", "sms"]) {
      if (new RegExp(`\\b(contact|reach|prefer|message|send).{0,30}\\b${channel}\\b|\\b${channel}\\b.{0,30}\\b(contact|reach|prefer|message)`, "i").test(text)) {
        add("contact_channel", channel === "sms" ? "SMS" : channel[0].toUpperCase() + channel.slice(1));
        break;
      }
    }

    const email = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] ?? (text.includes("[REDACTED_EMAIL]") ? "[REDACTED_EMAIL]" : undefined);
    if (email) add("email", email);

    const phone = text.match(/\+?\d[\d\s().-]{7,}\d/)?.[0] ?? (text.includes("[REDACTED_PHONE]") ? "[REDACTED_PHONE]" : undefined);
    if (phone) add("phone", phone);

    const timezone = text.match(/\b(UTC[+-]\d{1,2}|EAT|EST|PST|CET)\b/i)?.[0];
    if (timezone) add("timezone", timezone.toUpperCase());

    if (/vip|strategic|named account/i.test(text)) add("account_tier", "VIP");
    if (/urgent|same day|asap|priority/i.test(text)) add("support_preference", "Priority response");

    return dedupeCandidates(found);
  }
}

export function dedupeCandidates(candidates: CandidateFact[]) {
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = `${candidate.slotKey}:${candidate.objectValue}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

