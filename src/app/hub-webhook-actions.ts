"use server";

import { revalidatePath } from "next/cache";
import type { ActionResult } from "@/lib/action-result";
import { requireViewer } from "@/lib/auth/current";
import { db } from "@/lib/db";
import { ValidationError } from "@/lib/errors";
import { addTrackedRepositories, clearCoverage, profileRest, saveCoverage } from "@/lib/hub/github-app-install";
import { WAITING_HELP, webhookStatus } from "@/lib/hub/webhook-panel";
import { hubRun, hubService } from "@/lib/team/hub-action-run";

const str = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();
const refresh = () => {
  revalidatePath("/team");
  revalidatePath("/repositories");
};

/** Step 2: asks GitHub (as this person) to add their tracked repositories to the team's App, one request each. */
export async function addTrackedRepositoriesAction(): Promise<ActionResult> {
  return hubRun(async () => {
    const { viewer } = await requireViewer();
    const { svc } = await hubService();
    const { webhooks } = await svc.overview();
    if (!webhooks.enabled) throw new ValidationError("Instant GitHub updates are not set up yet. The owner creates the GitHub App first.");
    if (!webhooks.appSlug) throw new ValidationError("The server does not know the App's name. Install the App on your repositories on GitHub.");
    const rows = await db.repository.findMany({ where: { workspaceId: viewer.workspaceId, trackingStatus: "ACTIVE", isDemo: false }, select: { githubId: true, fullName: true } });
    const tracked = rows.map((r) => ({ githubId: r.githubId.toString(), fullName: r.fullName }));
    const report = await addTrackedRepositories(profileRest(db), webhooks.appSlug, tracked);
    if (report.state === "checked") await saveCoverage(db, { appSlug: report.appSlug, checkedAt: new Date().toISOString(), covered: report.covered });
    refresh();
    if (report.state === "not-installed") return { ok: false, error: "You have not installed the App yet. Install it on GitHub first, then press this button again." };
    if (report.state === "cannot-list") return { ok: false, error: "GitHub would not let Mergeport check your installations. Install the App on your repositories on GitHub." };
    const parts: string[] = [];
    if (report.added.length) parts.push(`Added ${report.added.length} ${report.added.length === 1 ? "repository" : "repositories"} to the App.`);
    if (!report.added.length && !report.failed.length) parts.push("Every repository you track is already covered.");
    const names = (reason: string) => report.failed.filter((f) => f.reason === reason).map((f) => f.fullName).join(", ");
    if (names("install-on-github")) parts.push(`Install it on this repository on GitHub: ${names("install-on-github")}.`);
    if (names("try-again-later")) parts.push(`GitHub asked Mergeport to slow down. Try again later for: ${names("try-again-later")}.`);
    if (names("failed")) parts.push(`Something went wrong for: ${names("failed")}. Nothing was changed there. Try again.`);
    return report.failed.length ? { ok: false, error: parts.join(" ") } : { ok: true, message: parts.join(" ") };
  });
}

/** Step 3: re-reads the hub's `/me` and says in words what it shows. */
export async function checkInstantUpdatesAction(): Promise<ActionResult> {
  return hubRun(async () => {
    await requireViewer();
    const { svc } = await hubService();
    const { webhooks } = await svc.overview();
    refresh();
    const s = webhookStatus(webhooks);
    if (s.kind === "off") return { ok: true, message: "Not set up yet. The owner creates the GitHub App in step 1." };
    if (s.kind === "waiting") return { ok: true, message: WAITING_HELP };
    return { ok: true, message: `${s.text}. The last event was ${webhooks.lastEvent ?? "an event"}.` };
  });
}

/** The by-hand path: the owner pastes the secret they generated here into the GitHub App they made themselves. */
export async function saveWebhookSecretAction(fd: FormData): Promise<ActionResult> {
  return hubRun(async () => {
    await requireViewer();
    const { svc } = await hubService();
    await svc.setGithubWebhook(str(fd, "secret"), str(fd, "appSlug") || null);
    refresh();
    return { ok: true, message: "Saved. The secret is on your server." };
  });
}

export async function turnOffInstantUpdatesAction(): Promise<ActionResult> {
  return hubRun(async () => {
    await requireViewer();
    const { svc } = await hubService();
    await svc.clearGithubWebhook();
    await clearCoverage(db);
    refresh();
    return { ok: true, message: "Turned off. The server no longer accepts events from GitHub." };
  });
}
