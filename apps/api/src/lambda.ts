import type { SQSEvent } from "aws-lambda";
import { Supervisor } from "@atlas/agents";
import { repository } from "./repository";

export async function handler(event: SQSEvent) {
  const supervisor = new Supervisor();
  const processed: string[] = [];
  for (const record of event.Records) {
    const body = JSON.parse(record.body);
    const tenantId = body.tenantId ?? "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const userId = body.userId ?? "33333333-3333-4333-8333-333333333333";
    const invoiceId = body.invoiceId;
    const ctx = { tenantId, userId, role: "admin" as const };
    const invoice = invoiceId ? await repository.getInvoice(ctx, invoiceId) : undefined;
    if (invoice) {
      await supervisor.process(ctx, invoice, repository);
      processed.push(invoice.id);
    }
  }
  return { processed };
}

