import { NextRequest, NextResponse } from "next/server";
import { Role } from "@prisma/client";
import { db } from "@/lib/db";
import { assertWorkspaceDomain, exchangeSignInCode, parseGoogleSignInState, verifyGoogleIdToken } from "@/lib/google";
import { createSession, setSessionCookie } from "@/lib/session";

// The redirect target is always this fixed internal path — no user-controlled redirect parameter is ever
// accepted anywhere in this flow, which is how open redirects are prevented (by construction).
function redirectToApp(result: "connected" | "error") {
  const base = process.env.NEXTAUTH_URL || "http://localhost:3000";
  return NextResponse.redirect(new URL(`/?google=${result}`, base).toString());
}

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code");
  const state = request.nextUrl.searchParams.get("state");
  const error = request.nextUrl.searchParams.get("error");
  if (error || !code || !state) return redirectToApp("error");

  try {
    // 1. State: signature + expiry + one-time nonce (see createGoogleSignInState in src/lib/google.ts).
    const parsedState = parseGoogleSignInState(state);

    // 2. Exchange code, verify the ID token's signature/issuer/audience/expiry via google-auth-library.
    const { idToken } = await exchangeSignInCode(code);
    const identity = await verifyGoogleIdToken(idToken);

    // 3. Nonce must match the one we generated for this specific sign-in attempt (replay protection),
    //    email must be verified by Google, and the account must belong to the configured Workspace domain.
    if (identity.nonce !== parsedState.nonce) throw new Error("Sign-in nonce mismatch.");
    if (!identity.emailVerified) throw new Error("Google account email is not verified.");
    assertWorkspaceDomain(identity);

    // 4. Identity resolution: googleSubject is the permanent identifier (Google's `sub`), not email — email
    //    can change. Fall back to matching an existing password-login user by email to link accounts rather
    //    than creating a duplicate. If neither matches, auto-provision a new EDITOR (per product decision).
    let user = await db.user.findUnique({ where: { googleSubject: identity.subject } });
    if (!user) {
      const existingByEmail = await db.user.findUnique({ where: { email: identity.email } });
      if (existingByEmail) {
        user = await db.user.update({
          where: { id: existingByEmail.id },
          data: { googleSubject: identity.subject, googleEmail: identity.email, googleWorkspaceDomain: identity.hd ?? null, googleIdentityLinkedAt: new Date() },
        });
      } else {
        user = await db.user.create({
          data: {
            email: identity.email,
            name: identity.name ?? identity.email,
            role: Role.EDITOR,
            googleSubject: identity.subject,
            googleEmail: identity.email,
            googleWorkspaceDomain: identity.hd ?? null,
            googleIdentityLinkedAt: new Date(),
          },
        });
      }
    }

    const { token, expiresAt } = await createSession(user.id);
    const response = redirectToApp("connected");
    setSessionCookie(response, token, expiresAt);
    return response;
  } catch (callbackError) {
    console.error("GOOGLE SIGN-IN ERROR:", callbackError instanceof Error ? callbackError.message : callbackError);
    return redirectToApp("error");
  }
}
