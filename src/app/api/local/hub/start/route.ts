import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { HubAuth, safeVerificationUri } from "@/lib/hub/connect";
import { failure, guardConnect, readBody } from "@/lib/hub/connect-route";
import { rememberDeviceFlow } from "@/lib/hub/device-flows";

export async function POST(req: Request) {
  const refused = guardConnect(req);
  if (refused) return refused;
  const { url } = await readBody(req);
  if (typeof url !== "string") return NextResponse.json({ ok: false, error: "Type the server address." });
  try {
    const s = await new HubAuth().start(url);
    const verificationUri = safeVerificationUri(s.verificationUri, env().MERGEPORT_HOST);
    if (!verificationUri) return NextResponse.json({ ok: false, error: "The server sent a sign-in page that is not on GitHub, so it was not opened." });
    // The device code and poll secret stay in this process; the browser polls with an opaque id.
    const pollId = rememberDeviceFlow({ origin: url, deviceCode: s.deviceCode, pollSecret: s.pollSecret, expiresAt: Date.now() + s.expiresIn * 1000 });
    return NextResponse.json({ ok: true, userCode: s.userCode, verificationUri, interval: s.interval, pollId });
  } catch (err) {
    return failure(err);
  }
}
