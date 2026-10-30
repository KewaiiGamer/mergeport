import { NextResponse } from "next/server";
import { isDemo } from "@/lib/env";
import { localRequest } from "@/lib/http";
import { ValidationError } from "@/lib/errors";

/** Shared by the three /api/local/hub routes. They run before sign-in, so they check only the Origin, the loopback Host and demo mode, never a session. */
export function guardConnect(req: Request): NextResponse | null {
  if (!localRequest(req)) return new NextResponse("Bad origin", { status: 403 });
  if (isDemo()) return new NextResponse("Not available in demo mode", { status: 403 });
  return null;
}

export async function readBody(req: Request): Promise<Record<string, unknown>> {
  const b = await req.json().catch(() => null);
  return b && typeof b === "object" ? (b as Record<string, unknown>) : {};
}

/** Only our own validation messages reach the browser; they never carry codes or tokens. */
export const failure = (err: unknown) => NextResponse.json({ ok: false, error: err instanceof ValidationError ? err.message : "Something went wrong talking to that server." });
