import { GITHUB_BACKEND, hubBackendId, isHubBackend, type Backend } from "@/lib/local/backends";
import { env } from "@/lib/env";
import { mergeportHome } from "@/lib/local/profile";
import { readActive, readHubs } from "@/lib/local/registry";

/** The backend the launcher started THIS process for (MERGEPORT_BACKEND), or null when there is no launcher or the value is unusable. */
function runningBackend(): Backend | null {
  const b = process.env.MERGEPORT_BACKEND;
  return b === GITHUB_BACKEND || (b && isHubBackend(b)) ? (b as Backend) : null;
}

export type WorkspaceEntry = { backend: Backend; label: string; detail?: string; available: boolean };

/** What the workspace switcher offers: GitHub, then every known hub server in the order it was added. */
export function listWorkspaces(home: string, host: string, accountId: string): { active: Backend; entries: WorkspaceEntry[] } {
  const entries: WorkspaceEntry[] = [{ backend: GITHUB_BACKEND, label: "GitHub (repositories)", available: true }];
  for (const h of readHubs(home).sort((a, b) => a.addedAt.localeCompare(b.addedAt))) {
    let backend: Backend;
    try {
      backend = hubBackendId(h.origin);
    } catch {
      continue; // an origin that no longer normalizes cannot be switched to
    }
    const other = h.lastSignedInAs.id !== accountId;
    entries.push({ backend, label: h.teamName || h.origin, detail: other ? `Signed in as @${h.lastSignedInAs.login}` : h.origin, available: !other });
  }
  // active.json can already name the next workspace while this process is still the old one, so the running process wins.
  const a = readActive(home);
  const wanted = runningBackend() ?? (a && a.host === host && a.accountId === accountId ? a.backend : GITHUB_BACKEND);
  return { active: entries.some((e) => e.backend === wanted) ? wanted : GITHUB_BACKEND, entries };
}

/**
 * Which backend this process serves. Stand-in for `TeamConfig.backend` (plan 2), replaced by the column on integration.
 * The launcher sets MERGEPORT_BACKEND for every child, and that wins; without a launcher it falls back to active.json
 * (a missing, unreadable or foreign-host file means GitHub).
 */
export async function currentBackend(): Promise<Backend> {
  const running = runningBackend();
  if (running) return running;
  const e = env();
  const a = readActive(mergeportHome(e.MERGEPORT_HOME));
  return a && a.host === e.MERGEPORT_HOST ? a.backend : GITHUB_BACKEND;
}
