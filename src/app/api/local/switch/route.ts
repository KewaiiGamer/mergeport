import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { db } from "@/lib/db";
import { SESSION_COOKIE, findSession } from "@/lib/auth/session";
import { localRequest } from "@/lib/http";
import { isHubBackend, type Backend } from "@/lib/local/backends";
import { requestSwitch } from "@/lib/local/switch-client";

/**
 * Asks the launcher to restart the app on another workspace. The launcher answers before it kills this very process and
 * owns active.json (it records the choice only once the new workspace is up), so this route writes no state. The browser
 * then watches /api/local/ready: a new bootId with `expectedBackend` means the switch worked, a new bootId with another
 * backend means it failed and the previous workspace was restored.
 */
export async function POST(req: Request) {
  if (!localRequest(req)) return new NextResponse("Bad origin", { status: 403 });
  const s = await findSession(db, (await cookies()).get(SESSION_COOKIE)?.value);
  if (!s) return new NextResponse("Unauthorized", { status: 401 });
  const body = (await req.json().catch(() => ({}))) as { backend?: unknown };
  const b = body.backend;
  if (typeof b !== "string" || !(b === "github" || isHubBackend(b))) return NextResponse.json({ error: "Unknown workspace" }, { status: 400 });
  const backend = b as Backend;
  try {
    const { launchUrl, previousBootId } = await requestSwitch(backend);
    return NextResponse.json({ launchUrl, previousBootId, expectedBackend: backend });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Switch failed" }, { status: 409 });
  }
}
