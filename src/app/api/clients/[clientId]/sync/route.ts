import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { enqueueClientSync } from "@/lib/sync-queue";
import { getSessionUser } from "@/lib/session";

export async function POST(request: NextRequest, { params }: { params: Promise<{ clientId: string }> }) {
  const user = await getSessionUser(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { clientId } = await params;
  const client = await db.client.findUnique({ where: { id: clientId }, select: { id: true } });
  if (!client) return NextResponse.json({ error: "Client not found." }, { status: 404 });
  const jobs = await enqueueClientSync(client.id);
  return NextResponse.json({ jobs: jobs.map((job) => ({ id: job.id, status: job.status })) }, { status: 202 });
}
