import { timingSafeEqual } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { Role } from "@prisma/client";
import { emailValue, passwordValue } from "@/lib/auth-input";
import { db } from "@/lib/db";
import { hashPassword } from "@/lib/passwords";
import { requiredText } from "@/lib/validators";

export async function POST(request: NextRequest) {
  const expected = process.env.INITIAL_ADMIN_SETUP_TOKEN;
  const provided = request.headers.get("x-setup-token");
  if (!expected || !provided || Buffer.byteLength(expected) !== Buffer.byteLength(provided) || !timingSafeEqual(Buffer.from(expected), Buffer.from(provided))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (await db.user.count()) return NextResponse.json({ error: "Initial employee account already exists." }, { status: 409 });

  try {
    const body = await request.json() as Record<string, unknown>;
    const user = await db.user.create({ data: { email: emailValue(body.email), name: requiredText(body.name, "name"), role: Role.ADMIN, passwordHash: await hashPassword(passwordValue(body.password)) }, select: { id: true, email: true, name: true, role: true } });
    return NextResponse.json({ user }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Invalid request." }, { status: 400 });
  }
}
