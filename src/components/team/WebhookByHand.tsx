"use client";

import { useState } from "react";
import { saveWebhookSecretAction, turnOffInstantUpdatesAction } from "@/app/hub-webhook-actions";
import { ActionForm } from "@/components/forms/ActionForm";
import { CopyField } from "@/components/forms/CopyField";
import { Sheet } from "@/components/ui/dialog";
import { Check, Copy, Trash2 } from "@/components/ui/icons";
import { byHandValues, generateSecret, randomLetters, type ByHandValues } from "@/lib/hub/webhook-panel";

function CopyAll({ label, text }: { label: string; text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="btn !h-10"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1800);
        } catch {
          /* the list is on screen and selectable */
        }
      }}
    >
      {copied ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}
      {copied ? "Copied" : label}
    </button>
  );
}

/** The generated values, laid out for pasting into GitHub's "Register new GitHub App" page. Presentational, so it renders in tests. */
export function ByHandValuesView({ v }: { v: ByHandValues }) {
  return (
    <div className="flex flex-col gap-3">
      <CopyField label="App name" value={v.appName} />
      <CopyField label="Homepage URL" value={v.homepageUrl} />
      <CopyField label="Webhook URL" value={v.webhookUrl} />
      <CopyField label="Webhook secret" value={v.secret} hint="Paste it into the App's Webhook secret field on GitHub, then save it on the server below. It is shown only here." />
      <div>
        <p className="label">Repository permissions</p>
        <table className="w-full text-left text-[12.5px]">
          <tbody>
            {v.permissions.map((p) => (
              <tr key={p.name} className="border-b border-line last:border-b-0"><td className="py-1.5 mono">{p.name}</td><td className="py-1.5 text-ink-3">{p.access}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
      <div>
        <p className="label">Subscribe to events</p>
        <ul className="mono text-[12.5px]">{v.events.map((e) => <li key={e}>{e}</li>)}</ul>
      </div>
      <div className="flex flex-wrap gap-2">
        <CopyAll label="Copy permissions" text={v.permissions.map((p) => `${p.name}: read`).join("\n")} />
        <CopyAll label="Copy events" text={v.events.join("\n")} />
      </div>
    </div>
  );
}

/**
 * The by-hand path for an owner who cannot use the manifest flow. "Generate" fills every value in the browser; nothing leaves
 * it except through "Save secret on the server".
 */
export function WebhookByHand({ teamName, hubOrigin, enabled }: { teamName: string; hubOrigin: string; enabled: boolean }) {
  const [v, setV] = useState<ByHandValues | null>(null);
  return (
    <details className="rounded-[10px] border border-line p-3 text-[13px]">
      <summary className="min-h-10 cursor-pointer font-medium leading-10">Set it up by hand</summary>
      <div className="mt-2 flex flex-col gap-3">
        <p className="text-ink-3">For an owner who cannot use the button above. Register a GitHub App yourself with the values below; the secret is made in this browser and goes nowhere until you save it.</p>
        <div>
          <button type="button" className="btn !h-10" onClick={() => setV(byHandValues({ teamName, hubOrigin, letters: randomLetters(), secret: generateSecret() }))}>
            {v ? "Generate again" : "Generate"}
          </button>
        </div>
        {v && (
          <>
            <ByHandValuesView v={v} />
            <ActionForm action={saveWebhookSecretAction} submitLabel="Save secret on the server" pendingLabel="Saving…" resetOnSuccess={false} className="rounded-[10px] border border-line bg-canvas p-3">
              <input type="hidden" name="secret" value={v.secret} />
              <label className="label" htmlFor="by-hand-slug">The App&rsquo;s short name on GitHub (optional, from its web address)</label>
              <input id="by-hand-slug" name="appSlug" className="input !h-10 !w-full sm:!w-64" autoComplete="off" placeholder="mergeport-my-team-abcd" pattern="[A-Za-z0-9\-]{1,100}" />
            </ActionForm>
          </>
        )}
        {enabled && (
          <Sheet title="Turn off instant GitHub updates?" description="The server stops accepting events from GitHub. Everyone's apps go back to checking GitHub every 15 minutes. The GitHub App itself is not deleted." trigger={<button type="button" className="btn btn-danger !h-10 self-start"><Trash2 size={14} aria-hidden />Turn off</button>}>
            <ActionForm action={turnOffInstantUpdatesAction} submitLabel="Turn off" pendingLabel="Turning off…" submitClassName="btn btn-danger !h-10" closeOnSuccess>
              <p className="text-[13px] text-ink-3">Delete the App on GitHub too if you no longer need it.</p>
            </ActionForm>
          </Sheet>
        )}
      </div>
    </details>
  );
}
