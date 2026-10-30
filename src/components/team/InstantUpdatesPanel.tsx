import { addTrackedRepositoriesAction, checkInstantUpdatesAction } from "@/app/hub-webhook-actions";
import { ActionForm } from "@/components/forms/ActionForm";
import { GithubAppCreate } from "@/components/team/GithubAppCreate";
import { WebhookByHand } from "@/components/team/WebhookByHand";
import { Banner, Mono, Panel, SimplePill } from "@/components/ui/primitives";
import { Zap } from "@/components/ui/icons";
import type { HubWebhooks } from "@/lib/hub/ports";
import { appFailureText, installUrl, UNREACHABLE_HELP, WAITING_HELP, webhookStatus } from "@/lib/hub/webhook-panel";

export type TrackedRow = { id: string; githubId: string; fullName: string };
export type GithubAppResult = { result: "created" | "failed"; reason?: string };

const TONE = { on: "ok", waiting: "waiting", quiet: "waiting", off: "unknown" } as const;

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2 border-b border-line p-4 last:border-b-0" aria-label={`Step ${n}: ${title}`}>
      <h3 className="text-[13px] font-medium">{n}. {title}</h3>
      {children}
    </section>
  );
}

/**
 * "Instant GitHub updates" on the hub-mode Team page. Everyone sees the status line and steps 2 and 3 for their own repositories;
 * only the OWNER sees step 1 and the by-hand section. Presentational: the page decided everything it shows, and each button is a
 * server action that the hub or GitHub re-checks.
 */
export function InstantUpdatesPanel({ teamName, origin, isOwner, webhooks, tracked, covered, appResult, now }: { teamName: string; origin: string | null; isOwner: boolean; webhooks: HubWebhooks; tracked: TrackedRow[]; covered: ReadonlySet<string>; appResult?: GithubAppResult | null; now?: number }) {
  const status = webhookStatus(webhooks, now);
  const slug = webhooks.appSlug;
  const coveredCount = tracked.filter((r) => covered.has(r.githubId)).length;
  return (
    <Panel title="Instant GitHub updates" icon={Zap} id="instant" actions={<SimplePill tone={TONE[status.kind]}>{status.text}</SimplePill>}>
      <div>
        {appResult?.result === "created" && <div className="p-4 pb-0"><Banner tone="info" title="Created. The secret is saved on your server.">Next, install the App on your repositories (steps 2 and 3).</Banner></div>}
        {appResult?.result === "failed" && <div className="p-4 pb-0"><Banner tone="error" title="The GitHub App was not set up">{appFailureText(appResult.reason)}</Banner></div>}
        <p className="border-b border-line p-4 text-[13px] text-ink-3">GitHub tells your server when an issue, pull request or comment changes, and the server passes it to the apps that may see it. Without it, Mergeport checks GitHub every 15 minutes.</p>

        {isOwner && (
          <Step n={1} title="Create the GitHub App">
            {webhooks.enabled ? (
              <p className="text-[13px] text-ink-2">Done.{slug && <> The App is <Mono>{slug}</Mono>.</>} The secret is saved on your server.</p>
            ) : (
              <GithubAppCreate />
            )}
          </Step>
        )}

        <Step n={2} title="Cover your repositories">
          {!webhooks.enabled ? (
            <p className="text-[13px] text-ink-3">Available once the owner has created the GitHub App.</p>
          ) : (
            <>
              {tracked.length === 0 ? (
                <p className="text-[13px] text-ink-3">You do not track any repositories on this computer yet.</p>
              ) : (
                <ul className="max-h-64 overflow-y-auto rounded-[8px] border border-line text-[13px]" aria-label="Your tracked repositories">
                  {tracked.map((r) => (
                    <li key={r.id} className="flex min-h-10 items-center justify-between gap-3 border-b border-line px-3 last:border-b-0">
                      <Mono>{r.fullName}</Mono>
                      {covered.has(r.githubId) ? <SimplePill tone="ok">Covered</SimplePill> : <SimplePill tone="unknown">Not installed yet</SimplePill>}
                    </li>
                  ))}
                </ul>
              )}
              {slug ? (
                <p className="text-[13px] text-ink-2">
                  {coveredCount === 0 ? "If you have not installed the App yet, " : "For repositories it cannot add for you, "}
                  <a className="underline" href={installUrl(slug)} target="_blank" rel="noreferrer">install it on GitHub</a>.
                </p>
              ) : (
                <p className="text-[13px] text-ink-3">Install the GitHub App on your repositories on GitHub.</p>
              )}
              {slug && tracked.length > 0 && (
                <ActionForm action={addTrackedRepositoriesAction} submitLabel="Add my tracked repositories" pendingLabel="Adding…" resetOnSuccess={false} submitClassName="btn !h-10">
                  <p className="text-[12.5px] text-ink-3">Asks GitHub, as you, to add each tracked repository the App does not cover yet. It never changes anything else.</p>
                </ActionForm>
              )}
            </>
          )}
        </Step>

        <Step n={3} title="Check">
          {status.kind === "waiting" && <p className="text-[13px] text-ink-2">{WAITING_HELP}</p>}
          {status.kind === "quiet" && <p className="text-[13px] text-ink-2">{UNREACHABLE_HELP}</p>}
          {status.kind === "waiting" && <p className="text-[12.5px] text-ink-3">{UNREACHABLE_HELP}</p>}
          <ActionForm action={checkInstantUpdatesAction} submitLabel="Check now" pendingLabel="Checking…" resetOnSuccess={false} submitClassName="btn !h-10">
            <p className="text-[12.5px] text-ink-3">Asks the server what it last received from GitHub.</p>
          </ActionForm>
        </Step>

        {isOwner && (
          <div className="p-4">
            <WebhookByHand teamName={teamName} hubOrigin={origin ?? ""} enabled={webhooks.enabled} />
          </div>
        )}
      </div>
    </Panel>
  );
}
