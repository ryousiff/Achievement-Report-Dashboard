import { NextResponse } from "next/server";
import { getRuntimeConfiguration } from "@/lib/env";

export function GET() {
  const configuration = getRuntimeConfiguration();
  return NextResponse.json({ status: configuration.configured ? "ok" : "configuration_required", configuration });
}
