import { Readable } from "node:stream";
import { NextRequest, NextResponse } from "next/server";
import { requireFeature } from "@/lib/access";
import { readMediaThumbnail } from "@/lib/media-storage";

/** Serves permanently-stored post thumbnails (see src/lib/media-storage.ts) from MinIO, so the report
 * UI never depends on Instagram's short-lived signed media URLs. */
export async function GET(request: NextRequest, { params }: { params: Promise<{ key: string[] }> }) {
  if (!(await requireFeature(request, "view_reports"))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { key } = await params;
  const objectKey = key.join("/");

  const object = await readMediaThumbnail(objectKey);
  if (!object) return NextResponse.json({ error: "Not found." }, { status: 404 });

  const body = Readable.toWeb(object.stream as Readable) as ReadableStream<Uint8Array>;
  return new NextResponse(body, {
    headers: {
      "Content-Type": object.contentType,
      "Cache-Control": "private, max-age=86400, immutable",
    },
  });
}
