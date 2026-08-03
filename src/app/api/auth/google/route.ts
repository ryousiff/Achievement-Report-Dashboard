import { NextResponse } from "next/server";
import { createSignInAuthorizationUrl } from "@/lib/google";

// Sign-in entry point: unlike /api/connectors/google (which connects Drive/Slides for an already
// logged-in user), this route requires no existing session — it's how someone signs in in the first place.
export async function GET() {
  try {
    const url = createSignInAuthorizationUrl();
    return NextResponse.redirect(url);
  } catch {
    return NextResponse.json({ error: "Google sign-in is not configured." }, { status: 503 });
  }
}
