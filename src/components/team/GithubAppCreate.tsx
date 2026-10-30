"use client";

import { useEffect, useRef, useState, type Ref } from "react";
import { LoaderCircle } from "@/components/ui/icons";
import type { GithubAppManifest } from "@/lib/hub/github-app-manifest";

export type StartAnswer = { actionUrl: string; manifest: GithubAppManifest; state: string };

/**
 * The hidden form that posts the manifest to GitHub (a top-level navigation; GitHub shows the prefilled App and the owner
 * presses "Create GitHub App"). Built only from what the `start` route answered. The manifest is one field, as GitHub expects.
 */
export function ManifestForm({ actionUrl, manifest, formRef }: StartAnswer & { state?: string; formRef?: Ref<HTMLFormElement> }) {
  return (
    <form method="post" action={actionUrl} ref={formRef} hidden data-testid="manifest-form">
      <input type="hidden" name="manifest" value={JSON.stringify(manifest)} />
    </form>
  );
}

const isGithubUrl = (u: string) => {
  try {
    const x = new URL(u);
    return x.protocol === "https:" && x.hostname === "github.com";
  } catch {
    return false;
  }
};

/** Step 1 (owner only): choose where the App lives, then send the browser to GitHub with the manifest. */
export function GithubAppCreate() {
  const [account, setAccount] = useState<"personal" | "org">("personal");
  const [org, setOrg] = useState("");
  const [teammates, setTeammates] = useState(true);
  const [contents, setContents] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [answer, setAnswer] = useState<StartAnswer | null>(null);
  const form = useRef<HTMLFormElement>(null);

  // The hidden form exists only after the route answered; submitting it leaves this page for GitHub.
  useEffect(() => {
    if (answer) form.current?.submit();
  }, [answer]);

  async function go() {
    setError(null);
    setPending(true);
    try {
      const res = await fetch("/api/local/hub/github-app/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(account === "org" ? { account, org: org.trim(), contents, teammates } : { account, contents, teammates }),
      });
      const body = (await res.json().catch(() => ({}))) as Partial<StartAnswer> & { error?: string };
      if (!res.ok || !body.actionUrl || !body.manifest || !isGithubUrl(body.actionUrl)) {
        setError(body.error ?? "Could not prepare the GitHub App. Try again.");
        setPending(false);
        return;
      }
      setAnswer({ actionUrl: body.actionUrl, manifest: body.manifest, state: body.state ?? "" });
    } catch {
      setError("Could not reach Mergeport. Check that it is still running.");
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col gap-3 text-[13px]">
      <fieldset className="flex flex-col gap-1">
        <legend className="label">Where should the GitHub App live?</legend>
        <label className="flex min-h-10 items-center gap-2"><input type="radio" name="gh-app-account" checked={account === "personal"} onChange={() => setAccount("personal")} /> my GitHub account</label>
        <label className="flex min-h-10 items-center gap-2"><input type="radio" name="gh-app-account" checked={account === "org"} onChange={() => setAccount("org")} /> an organisation</label>
        {account === "org" && (
          <div>
            <label className="label" htmlFor="gh-app-org">Organisation login on GitHub</label>
            <input id="gh-app-org" className="input !h-10 !w-full sm:!w-64" value={org} onChange={(e) => setOrg(e.target.value)} autoComplete="off" placeholder="my-company" />
          </div>
        )}
      </fieldset>
      <label className="flex items-start gap-2"><input type="checkbox" className="mt-1" checked={teammates} onChange={(e) => setTeammates(e.target.checked)} /> <span>Let teammates install it on their own repositories<span className="block text-[12px] text-ink-3">A private App can only be installed by the account that owns it.</span></span></label>
      <label className="flex items-start gap-2"><input type="checkbox" className="mt-1" checked={contents} onChange={(e) => setContents(e.target.checked)} /> <span>Also refresh branches and commits instantly</span></label>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="btn btn-primary !h-10" onClick={go} disabled={pending || (account === "org" && !org.trim())} data-loading={pending}>
          {pending ? <LoaderCircle size={14} aria-hidden className="animate-spin" /> : null}
          {pending ? "Opening GitHub…" : "Create the GitHub App on GitHub"}
        </button>
        <p role="alert" className="text-[12.5px] text-blocked">{error}</p>
      </div>
      <p className="text-[12px] text-ink-3">GitHub shows the App prefilled. You may change its name (it must be unique), then press &ldquo;Create GitHub App&rdquo;. Mergeport keeps only the webhook secret and discards the App&rsquo;s private key.</p>
      {answer && <ManifestForm {...answer} formRef={form} />}
    </div>
  );
}
