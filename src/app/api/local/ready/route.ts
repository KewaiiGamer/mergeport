import { NextResponse } from "next/server";
import { loopbackHost } from "@/lib/http";
import { bootId } from "@/lib/local/boot-id";

export const dynamic = "force-dynamic";

/** Answers once this process is serving. No auth, no data: only which process this is and which workspace type it opened. */
export function GET(req: Request) {
  if (!loopbackHost(req)) return new NextResponse("Forbidden host", { status: 403 });
  return NextResponse.json({ bootId: bootId(), backend: process.env.MERGEPORT_BACKEND || "github" });
}
