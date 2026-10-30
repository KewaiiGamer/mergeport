import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { HubAuth, completeConnect } from "@/lib/hub/connect";
import { failure, guardConnect, readBody } from "@/lib/hub/connect-route";
import { deviceFlow, forgetDeviceFlow } from "@/lib/hub/device-flows";
import { hubSessionPort } from "@/lib/hub/ports-impl";
import { currentGhStatus } from "@/lib/local/identity";
import { mergeportHome } from "@/lib/local/profile";
import { requestSwitch } from "@/lib/local/switch-client";

/**
 * One poll of the hub's device sign-in. On success this creates the hub profile and asks the launcher to switch to it; the
 * session token stays on this computer and is never part of the response.
 */
export async function POST(req: Request) {
  const refused = guardConnect(req);
  if (refused) return refused;
  const { pollId } = await readBody(req);
  if (typeof pollId !== "string" || !pollId) return NextResponse.json({ status: "error", error: "bad-request" }, { status: 400 });
  const flow = deviceFlow(pollId);
  if (!flow) return NextResponse.json({ status: "error", error: "bad-request" }, { status: 400 });
  const url = flow.origin;
  try {
    const r = await new HubAuth().poll(url, flow.deviceCode, flow.pollSecret);
    if (r.status === "pending") return NextResponse.json(r);
    forgetDeviceFlow(pollId);
    if (r.status !== "ok") return NextResponse.json(r);
    const e = env();
    const done = await completeConnect({
      home: mergeportHome(e.MERGEPORT_HOME),
      host: e.MERGEPORT_HOST,
      origin: url,
      teamName: r.team.name,
      session: r.session,
      member: r.member,
      gh: await currentGhStatus(true),
      ports: { session: hubSessionPort },
    });
    if (!done.ok) return NextResponse.json({ status: "error", error: done.error });
    try {
      const { launchUrl, previousBootId } = await requestSwitch(done.backend);
      return NextResponse.json({ status: "ok", switch: { launchUrl, previousBootId, expectedBackend: done.backend } });
    } catch (err) {
      return NextResponse.json({ status: "error", error: "switch", message: err instanceof Error ? err.message : "Switch failed" });
    }
  } catch (err) {
    const f = (await failure(err).json()) as { error: string };
    return NextResponse.json({ status: "error", error: "hub", message: f.error });
  }
}
