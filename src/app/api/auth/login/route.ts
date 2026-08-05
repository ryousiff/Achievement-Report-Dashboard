import { NextRequest, NextResponse } from "next/server";
import { emailValue, passwordValue } from "@/lib/auth-input";
import { db } from "@/lib/db";
import { verifyPassword } from "@/lib/passwords";
import { createSession, setSessionCookie } from "@/lib/session";
import { roleFeatures } from "@/lib/access";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as Record<string, unknown>;
    const user = await db.user.findUnique({ where: { email: emailValue(body.email) } });
    if (!user?.passwordHash || !(await verifyPassword(passwordValue(body.password), user.passwordHash))) return NextResponse.json({ error: "Invalid email or password." }, { status: 401 });
    const { token, expiresAt } = await createSession(user.id);
    const response = NextResponse.json({ user: { id: user.id, email: user.email, name: user.name, role: user.role, features: roleFeatures[user.role] ?? [] } });
    setSessionCookie(response, token, expiresAt);
    return response;
  } catch {
    return NextResponse.json({ error: "Invalid email or password." }, { status: 401 });
  }
}
