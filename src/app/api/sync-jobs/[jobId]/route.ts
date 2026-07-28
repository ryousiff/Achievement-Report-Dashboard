import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getSessionUser } from "@/lib/session";

export async function GET(request: NextRequest, { params }: { params: Promise<{ jobId: string }> }) {
  if (!(await getSessionUser(request))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { jobId } = await params;
  const job = await db.syncJob.findUnique({ where: { id: jobId }, include: { connection: { select: { clientId: true, displayName: true, lastSuccessfulSyncAt: true, lastFailedSyncAt: true, lastFailureReason: true } }, runs: { orderBy: { createdAt: "desc" }, take: 1 } } });
  if (!job) return NextResponse.json({ error: "Sync job not found." }, { status: 404 });
  return NextResponse.json({ job });
}
