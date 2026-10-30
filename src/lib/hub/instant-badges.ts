import type { Db } from "@/lib/db";
import { readCoverage } from "@/lib/hub/github-app-install";
import { COVERAGE_KEY } from "@/lib/hub/webhook-panel";
import { isHubBackend } from "@/lib/local/backends";
import { getHubTeamService } from "@/lib/local/runtime";
import { currentBackend } from "@/lib/local/workspaces";

const ASK_MS = 1500;

/**
 * GitHub ids of repositories that get the "Instant" badge on the Repositories page: covered by the App at the last check AND the
 * hub's current webhooks are enabled with that same App. Without a stored result no request is made; a hub that does not
 * answer quickly means no badge, never a slow page.
 */
export async function instantRepoIds(db: Db): Promise<Set<string>> {
  try {
    if (!(await db.discoveryCache.findUnique({ where: { key: COVERAGE_KEY }, select: { key: true } }))) return new Set();
    const backend = await currentBackend();
    if (!isHubBackend(backend)) return new Set();
    const { svc } = await getHubTeamService(backend);
    const { webhooks } = await Promise.race([svc.overview(), new Promise<never>((_, no) => setTimeout(() => no(new Error("slow")), ASK_MS).unref?.())]);
    return webhooks.enabled ? await readCoverage(db, webhooks.appSlug) : new Set();
  } catch {
    return new Set();
  }
}
