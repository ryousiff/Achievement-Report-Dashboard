import { NextRequest, NextResponse } from "next/server";
import { requireFeature } from "@/lib/access";
import { getSettingsModules, getModuleValues, setModuleValue } from "@/lib/settings/registry";

export async function GET(request: NextRequest) {
  const user = await requireFeature(request, "manage_settings");
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const searchParams = request.nextUrl.searchParams;
  const moduleId = searchParams.get("module");
  if (!moduleId) {
    const modules = await getSettingsModules();
    return NextResponse.json({ modules });
  }
  const values = await getModuleValues(moduleId);
  return NextResponse.json({ moduleId, values });
}

export async function POST(request: NextRequest) {
  const user = await requireFeature(request, "manage_settings");
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = await request.json() as { moduleId?: unknown; key?: unknown; value?: unknown };
  if (typeof body.moduleId !== "string" || typeof body.key !== "string" || typeof body.value !== "string") {
    return NextResponse.json({ error: "moduleId, key, and value are required." }, { status: 400 });
  }
  await setModuleValue(body.moduleId, body.key, body.value);
  return NextResponse.json({ ok: true });
}
