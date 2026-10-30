import fs from "node:fs";
import path from "node:path";

/** A recorded GitHub webhook delivery from tests/fixtures/github-webhooks: `{ event, payload }` with the payload as GitHub sends it. */
export function webhook(name: string): { event: string; payload: any } {
  const { event, ...payload } = JSON.parse(fs.readFileSync(path.resolve(__dirname, "fixtures", "github-webhooks", `${name}.json`), "utf8"));
  return { event, payload };
}

/** GitHub id of the repository every fixture belongs to (octo-org/hello-world). */
export const FIXTURE_REPO_ID = 1296269n;

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

/**
 * A GitHub REST API (as a fetch) that answers what the full sync asks for, from the REST-shaped objects a webhook payload
 * carries. The real OctokitPort maps them, so the stored result is exactly what a full sync would store for the same data.
 */
export function restFetch(o: { repo: any; items: any[]; pulls?: any[]; issueComments?: Record<number, any[]>; reviewComments?: Record<number, any[]> }): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const p = url.pathname.replace(/^\/repos\/octo-org\/hello-world/, "");
    if (p === "") return json(o.repo);
    if (p === "/issues") return json(o.items);
    if (p === "/branches") return json([{ name: "main", commit: { sha: "0000000000000000000000000000000000000000" } }]);
    let m = /^\/pulls\/(\d+)$/.exec(p);
    if (m) return json((o.pulls ?? []).find((x) => x.number === Number(m![1])) ?? { message: "Not Found" });
    m = /^\/pulls\/(\d+)\/comments$/.exec(p);
    if (m) return json(o.reviewComments?.[Number(m[1])] ?? []);
    m = /^\/issues\/(\d+)\/comments$/.exec(p);
    if (m) return json(o.issueComments?.[Number(m[1])] ?? []);
    if (/^\/pulls\/\d+\/reviews$/.test(p)) return json([]);
    if (/^\/pulls\/\d+\/requested_reviewers$/.test(p)) return json({ users: [], teams: [] });
    if (/^\/commits\/[0-9a-f]+\/check-runs$/.test(p)) return json({ total_count: 0, check_runs: [] });
    return new Response(JSON.stringify({ message: `unexpected ${url.pathname}` }), { status: 404, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}
