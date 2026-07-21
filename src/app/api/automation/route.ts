import { NextRequest, NextResponse } from "next/server";
import { createAutomationEnvelope } from "@/lib/automation";

export async function POST(request: NextRequest) {
  const secret = request.headers.get("x-automation-secret");
  if (!process.env.AUTOMATION_WEBHOOK_SECRET || secret !== process.env.AUTOMATION_WEBHOOK_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json() as { clientId?: string; event?: "analytics.sync.completed" | "analytics.sync.failed" | "report.draft.created" | "report.approved" | "report.export.completed"; payload?: Record<string, unknown> };
  if (!body.clientId || !body.event) return NextResponse.json({ error: "clientId and event are required." }, { status: 400 });

  return NextResponse.json(createAutomationEnvelope(body.event, body.clientId, body.payload ?? {}), { status: 202 });
}
