import { NextRequest, NextResponse } from "next/server";
import { Platform } from "@prisma/client";
import { db } from "@/lib/db";
import { requireFeature } from "@/lib/access";
import { enqueueHistoricalBackfill } from "@/lib/sync-queue";

// Admin-only ("تشغيل المزامنة التاريخية"): starts/resumes the deep historical backfill for a client's
// Instagram connection(s). Unlike POST /api/clients/:clientId/sync, this is never triggered automatically —
// existing connections that only ever completed the old 90-day sync need this explicit action to opt into
// the deeper (now 15-month-by-default) backfill.
export async function POST(request: NextRequest, { params }: { params: Promise<{ clientId: string }> }) {
  const user = await requireFeature(request, "run_historical_sync");
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { clientId } = await params;
  const connections = await db.socialConnection.findMany({ where: { clientId, platform: Platform.INSTAGRAM }, select: { id: true } });
  if (connections.length === 0) return NextResponse.json({ error: "No Instagram connection found for this client." }, { status: 404 });
  try {
    const jobs = await Promise.all(connections.map((connection) => enqueueHistoricalBackfill(connection.id)));
    return NextResponse.json({ jobs: jobs.map((job) => ({ id: job.id, connectionId: job.connectionId, status: job.status })) }, { status: 202 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to start historical sync." }, { status: 400 });
  }
}
