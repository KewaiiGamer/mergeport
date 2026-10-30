import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { HubAuth } from "@/lib/hub/connect";
import { failure, guardConnect, readBody } from "@/lib/hub/connect-route";

export async function POST(req: Request) {
  const refused = guardConnect(req);
  if (refused) return refused;
  const { url } = await readBody(req);
  if (typeof url !== "string") return NextResponse.json({ ok: false, error: "Type the server address." });
  try {
    const h = await new HubAuth().health(url, env().MERGEPORT_HOST);
    return NextResponse.json({ ok: true, teamName: h.teamName, origin: h.origin });
  } catch (err) {
    return failure(err);
  }
}
