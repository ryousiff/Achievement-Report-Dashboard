import net from "node:net";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getRuntimeConfiguration } from "@/lib/env";

function storageCheck() {
  const host = process.env.MINIO_ENDPOINT;
  const port = Number(process.env.MINIO_PORT ?? 9000);
  if (!host || !Number.isInteger(port)) return Promise.resolve({ status: "not_configured" });
  return new Promise<{ status: "ok" | "unavailable" }>((resolve) => {
    const socket = net.createConnection({ host, port });
    const done = (status: "ok" | "unavailable") => { socket.destroy(); resolve({ status }); };
    socket.setTimeout(1500); socket.once("connect", () => done("ok")); socket.once("error", () => done("unavailable")); socket.once("timeout", () => done("unavailable"));
  });
}

export async function GET() {
  const configuration = getRuntimeConfiguration();
  const [database, storage] = await Promise.all([
    db.$queryRaw`SELECT 1`.then(() => ({ status: "ok" as const })).catch(() => ({ status: "unavailable" as const })),
    storageCheck(),
  ]);
  const healthy = configuration.configured && database.status === "ok" && storage.status !== "unavailable";
  return NextResponse.json({ status: healthy ? "ok" : "degraded", configuration: { ...configuration, providers: configuration.providers }, database, storage }, { status: healthy ? 200 : 503 });
}
