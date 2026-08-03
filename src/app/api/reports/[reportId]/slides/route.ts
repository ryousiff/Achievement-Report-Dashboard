import { NextRequest, NextResponse } from "next/server";
import { requireFeature } from "@/lib/access";
import { GoogleReconnectRequiredError } from "@/lib/google";
import { exportReportToSlides } from "@/lib/slides";

export async function POST(request: NextRequest, { params }: { params: Promise<{ reportId: string }> }) {
  const user = await requireFeature(request, "export_report");
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { reportId } = await params;
  try {
    const result = await exportReportToSlides(reportId, user.id);
    return NextResponse.json(result);
  } catch (error) {
    const reconnect = error instanceof GoogleReconnectRequiredError;
    const message = error instanceof Error ? error.message : "Unable to export to Google Slides.";
    console.error("SLIDES EXPORT ERROR:", message);
    return NextResponse.json({ error: message, reconnect }, { status: reconnect ? 409 : 500 });
  }
}
