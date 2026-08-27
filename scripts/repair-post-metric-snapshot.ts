import { db } from "@/lib/db";
import {
  isSnapshotAvailabilityResolved,
  snapshotAvailabilityFromMetrics,
  snapshotFieldsFromMetrics,
} from "@/lib/post-metric-snapshots";

async function main() {
  const [action, connectionId, externalPostId, month] = process.argv.slice(2);
  if (!(["mark-invalid", "repair-from-current"].includes(action)) || !connectionId || !externalPostId || !/^\d{4}-\d{2}$/.test(month ?? "")) {
    throw new Error("Usage: tsx scripts/repair-post-metric-snapshot.ts <mark-invalid|repair-from-current> <connectionId> <externalPostId> <YYYY-MM>");
  }

  const periodStart = new Date(`${month}-01T00:00:00.000Z`);
  const periodEnd = new Date(Date.UTC(periodStart.getUTCFullYear(), periodStart.getUTCMonth() + 1, 1) - 1);
  const post = await db.socialPost.findUnique({
    where: { connectionId_externalPostId: { connectionId, externalPostId } },
    select: { id: true, metrics: true, metricAvailabilityState: true },
  });
  if (!post) throw new Error("Post not found.");

  const key = { postId_periodStart_periodEnd: { postId: post.id, periodStart, periodEnd } };
  const snapshot = await db.socialPostMetricSnapshot.findUnique({ where: key });
  if (!snapshot) throw new Error("Snapshot not found.");

  if (action === "mark-invalid") {
    await db.socialPostMetricSnapshot.update({
      where: key,
      data: { validityState: "REPAIR_NEEDED", repairReason: "Explicitly marked invalid after legacy snapshot audit." },
    });
    return;
  }

  const metrics = (post.metrics ?? {}) as Record<string, unknown>;
  const availability = snapshotAvailabilityFromMetrics(
    metrics,
    (post.metricAvailabilityState ?? null) as Record<string, unknown> | null,
  );
  if (!isSnapshotAvailabilityResolved(availability)) {
    throw new Error("Current post metrics are still unresolved; refusing to replace the finalized snapshot.");
  }
  await db.socialPostMetricSnapshot.update({
    where: key,
    data: {
      ...snapshotFieldsFromMetrics(metrics),
      metricAvailability: availability,
      validityState: "VALID",
      repairReason: null,
      finalizedAt: new Date(),
    },
  });
}

main().finally(() => db.$disconnect());
