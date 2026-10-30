import { NextResponse } from "next/server";
import { isDemo } from "@/lib/env";
import { ValidationError } from "@/lib/errors";
import { loopbackHost } from "@/lib/http";
import { convertManifest, ConversionError } from "@/lib/hub/github-app-conversion";
import { consumeAppState } from "@/lib/hub/github-app-state";
import { HubForbidden, HubUnauthorized } from "@/lib/hub/ports";
import { isHubBackend } from "@/lib/local/backends";
import { getHubTeamService } from "@/lib/local/runtime";
import { currentBackend } from "@/lib/local/workspaces";

/**
 * Where GitHub sends the browser after the owner presses "Create GitHub App" on its prefilled page.
 *
 * Why this route has no Origin check and no session-cookie check, unlike `start`: it is a top-level GET navigation that
 * begins on github.com, so it carries no Origin of ours, and the session cookie is SameSite=Strict, which browsers withhold
 * from any navigation that starts cross-site (and from the rest of a redirect chain that began there). Requiring either would
 * break the feature. The protection is instead (1) the loopback Host with this server's exact port, which stops DNS rebinding,
 * (2) the 256-bit `state`, which only an authenticated, OWNER-checked `start` call can create, which is single use and expires
 * after 15 minutes, so a forged or replayed callback is refused before any request leaves this computer, and (3) the hub
 * session, which lives on this computer and is used for the one PUT, never taken from the request.
 *
 * Because that cookie is withheld, this route also does not answer with a redirect: the next hop would still be treated as
 * cross-site and arrive without the cookie, ending on the sign-in page. It answers a tiny page whose meta refresh is a
 * same-site navigation from this origin, which carries the cookie to `/team`.
 *
 * Secrets: of GitHub's answer only `webhook_secret` and `slug` are read (see github-app-conversion.ts); the private key and
 * client secret are never stored, logged, put in a URL or passed on. No secret appears in any URL here.
 */
const page = (status: number, title: string, text: string, to: string) =>
  new NextResponse(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>${title}</title>${status === 200 ? `<meta http-equiv="refresh" content="0;url=${to}">` : ""}</head><body style="font:15px system-ui,sans-serif;margin:3rem auto;max-width:34rem;padding:0 1rem"><p>${text}</p><p><a href="${to}">Go to Team</a></p></body></html>`,
    { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer" } },
  );

const done = (result: "created" | "failed", reason?: string) => page(200, "Mergeport", result === "created" ? "The GitHub App was created. Going back to Team." : "The GitHub App could not be set up. Going back to Team.", result === "created" ? "/team?github-app=created" : `/team?github-app=failed&reason=${reason}`);

export async function GET(req: Request) {
  if (!loopbackHost(req)) return new NextResponse("Bad origin", { status: 403 });
  if (isDemo()) return new NextResponse("Not available in demo mode", { status: 403 });
  const q = new URL(req.url).searchParams;
  const code = q.get("code");
  const state = q.get("state");
  // The state is spent here even if a later step fails; the person starts again from the Team page.
  const entry = state ? consumeAppState(state) : null;
  if (!entry || !code) return page(400, "Mergeport", "This GitHub App link is not valid any more. Go back to Team and start again.", "/team");

  const backend = await currentBackend();
  if (!isHubBackend(backend)) return done("failed", "hub");
  let conversion: { secret: string; slug: string };
  try {
    const { svc, origin } = await getHubTeamService(backend);
    if (origin !== entry.hubOrigin) return done("failed", "hub");
    try {
      conversion = await convertManifest(code);
    } catch (e) {
      return done("failed", e instanceof ConversionError ? e.reason : "refused");
    }
    await svc.setGithubWebhook(conversion.secret, conversion.slug);
    return done("created");
  } catch (e) {
    return done("failed", e instanceof HubUnauthorized ? "signin" : e instanceof HubForbidden || e instanceof ValidationError ? "owner" : "hub");
  }
}
