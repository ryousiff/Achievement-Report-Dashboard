import { Role } from "@prisma/client";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireFeature } from "@/lib/access";
import { emailValue } from "@/lib/auth-input";
import { hashPassword } from "@/lib/passwords";
import { requiredText } from "@/lib/validators";

const validRoles: Role[] = [Role.ADMIN, Role.EDITOR, Role.VIEWER];

export async function GET(request: NextRequest) {
  const user = await requireFeature(request, "manage_users");
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const users = await db.user.findMany({ select: { id: true, email: true, name: true, role: true, createdAt: true }, orderBy: { createdAt: "desc" } });
  return NextResponse.json({ users });
}

export async function POST(request: NextRequest) {
  const user = await requireFeature(request, "manage_users");
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const body = await request.json() as Record<string, unknown>;
    const email = emailValue(body.email);
    const name = requiredText(body.name, "name");
    const role = validRoles.includes(body.role as Role) ? (body.role as Role) : Role.EDITOR;
    const password = typeof body.password === "string" && body.password.length >= 8 ? body.password : undefined;
    if (!password) return NextResponse.json({ error: "Password must be at least 8 characters." }, { status: 400 });
    const newUser = await db.user.create({
      data: { email, name, role, passwordHash: await hashPassword(password) },
      select: { id: true, email: true, name: true, role: true, createdAt: true },
    });
    return NextResponse.json({ user: newUser }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Invalid request." }, { status: 400 });
  }
}

export async function PATCH(request: NextRequest) {
  const user = await requireFeature(request, "manage_users");
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const body = await request.json() as Record<string, unknown>;
    const id = requiredText(body.id, "id", 64);
    const role = validRoles.includes(body.role as Role) ? (body.role as Role) : undefined;
    if (!role) return NextResponse.json({ error: "A valid role is required." }, { status: 400 });
    const updated = await db.user.update({ where: { id }, data: { role }, select: { id: true, email: true, name: true, role: true } });
    return NextResponse.json({ user: updated });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Invalid request." }, { status: 400 });
  }
}
