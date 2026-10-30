import { NextResponse } from "next/server";
import { getAuth } from "@/lib/auth/current";
import { env } from "@/lib/env";
import { buildManifest, GITHUB_LOGIN, manifestActionUrl } from "@/lib/hub/github-app-manifest";
import { rememberAppState } from "@/lib/hub/github-app-state";
import { guardConnect, readBody } from "@/lib/hub/connect-route";
import { HubForbidden, HubRequestError, HubUnauthorized } from "@/lib/hub/ports";
import { isHubBackend } from "@/lib/local/backends";
import { getHubTeamService } from "@/lib/local/runtime";
import { currentBackend } from "@/lib/local/workspaces";

const refuse = (error: string, status: number) => NextResponse.json({ ok: false, error }, { status });

/**
 * Step 1 of "Instant GitHub updates": builds the manifest the page posts to GitHub. Same guards as the other hub routes
 * (Origin, loopback Host and port, demo mode), plus the app's session cookie and the hub role OWNER read from the hub's `/me`.
 * Nothing is sent to GitHub from here; the browser does that with the returned form.
 */
export async function POST(req: Request) {
  const refused = guardConnect(req);
  if (refused) return refused;
  if (!(await getAuth())?.viewer) return refuse("Sign in again.", 401);
  const body = await readBody(req);

  let account: { kind: "personal" } | { kind: "org"; org: string };
  if (body.account === "personal") account = { kind: "personal" };
  else if (body.account === "org" && typeof body.org === "string" && GITHUB_LOGIN.test(body.org.trim())) account = { kind: "org", org: body.org.trim() };
  else return refuse(body.account === "org" ? "Type the organisation's GitHub name." : "Choose where the GitHub App should live.", 400);
  const contents = body.contents === true;
  const teammates = body.teammates === true;

  const backend = await currentBackend();
  if (!isHubBackend(backend)) return refuse("This workspace is not a team server.", 400);
  try {
    const { svc, origin } = await getHubTeamService(backend);
    if (!origin) return refuse("Sign in to the server again.", 401);
    const overview = await svc.overview();
    if (overview.me.role !== "OWNER") return refuse("Only the owner of the server can create the GitHub App.", 403);
    const state = rememberAppState(origin);
    const manifest = buildManifest({ teamName: overview.teamName, hubOrigin: origin, port: env().MERGEPORT_PORT, teammates, contents });
    return NextResponse.json({ actionUrl: manifestActionUrl(account, state), manifest, state });
  } catch (e) {
    if (e instanceof HubUnauthorized) return refuse("Sign in to the server again.", 401);
    if (e instanceof HubForbidden) return refuse("The server refused that.", 403);
    if (e instanceof HubRequestError) return refuse(e.message, 502);
    return refuse("Something went wrong talking to that server.", 500);
  }
}
