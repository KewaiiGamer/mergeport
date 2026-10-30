"use client";

import { useEffect, useRef, useState } from "react";
import { Banner } from "@/components/ui/primitives";
import { LoaderCircle } from "@/components/ui/icons";
import { SwitchingOverlay } from "@/components/shell/SwitchingOverlay";
import { runPollLoop } from "@/lib/hub/poll-loop";

type Switch = { launchUrl: string; previousBootId: string | null; expectedBackend: string };
type Step =
  | { s: "url" }
  | { s: "checked"; origin: string; teamName: string | null }
  | { s: "code"; origin: string; userCode: string; verificationUri: string; interval: number; pollId: string }
  | { s: "switching"; sw: Switch };

const POLL_ERRORS: Record<string, string> = {
  mismatch: "gh is signed in as a different account than the one you used on that server. Switch with gh auth switch, then try again.",
  "gh-login": "gh is not signed in to GitHub yet. Sign in with the card above first.",
  "gh-missing": "The GitHub CLI (gh) is not installed.",
  "gh-error": "gh could not reach GitHub. Check your connection and try again.",
  "bad-request": "Something went wrong. Start again.",
};

type PollReply = { status: string; slowDown?: boolean; reason?: string; error?: string; message?: string; switch?: Switch };
/** GitHub's slow_down: every poll must wait this much longer from then on. */
const SLOW_DOWN_MS = 5000;

async function post<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const res = await fetch(`/api/local/hub/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal });
  return (await res.json()) as T;
}

/** "Connect to a server": check the address, sign in with GitHub through the server's device flow, then restart on that workspace. */
export function HubConnect() {
  const [step, setStep] = useState<Step>({ s: "url" });
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const reset = (message: string | null) => {
    setErr(message);
    setStep({ s: "url" });
  };

  async function check() {
    setBusy(true);
    setErr(null);
    try {
      const r = await post<{ ok: true; teamName: string | null; origin: string } | { ok: false; error: string }>("check", { url });
      if (r.ok) setStep({ s: "checked", origin: r.origin, teamName: r.teamName });
      else setErr(r.error);
    } catch {
      setErr("Could not check that server.");
    }
    setBusy(false);
  }

  async function connect(origin: string) {
    setBusy(true);
    setErr(null);
    try {
      const r = await post<{ ok: true; userCode: string; verificationUri: string; interval: number; pollId: string } | { ok: false; error: string }>("start", { url: origin });
      if (r.ok) setStep({ s: "code", origin, userCode: r.userCode, verificationUri: r.verificationUri, interval: r.interval, pollId: r.pollId });
      else setErr(r.error);
    } catch {
      setErr("Could not start sign-in.");
    }
    setBusy(false);
  }

  const codeStep = step.s === "code" ? step : null;
  useEffect(() => {
    if (!codeStep) return;
    const { pollId } = codeStep;
    const ac = new AbortController();
    let intervalMs = Math.max(1, codeStep.interval) * 1000;
    void runPollLoop({
      poll: (signal) => post<PollReply>("poll", { pollId }, signal),
      intervalMs: () => intervalMs,
      signal: ac.signal,
      onResult: (r) => {
        if (r.status === "pending") {
          if (r.slowDown) intervalMs += SLOW_DOWN_MS;
          return false;
        }
        if (r.status === "ok" && r.switch) setStep({ s: "switching", sw: r.switch });
        else if (r.status === "refused") reset(r.reason === "removed" ? "You were removed from that server. Ask its owner to reinstate you." : "That GitHub account is not invited to this server. Ask its owner to invite you.");
        else if (r.status === "expired") reset("The code expired. Start again.");
        else reset(r.message ?? POLL_ERRORS[r.error ?? ""] ?? "Could not finish connecting.");
        return true;
      },
    });
    return () => ac.abort();
  }, [codeStep]);

  if (step.s === "switching") return <SwitchingOverlay launchUrl={step.sw.launchUrl} previousBootId={step.sw.previousBootId} expectedBackend={step.sw.expectedBackend} />;

  return (
    <div className="flex flex-col gap-3 text-[13px]">
      {err && <Banner tone="error" title="Could not connect">{err}</Banner>}

      {step.s === "url" && (
        <form
          className="flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (url.trim()) void check();
          }}
        >
          <label htmlFor="hub-url" className="text-ink-2">Server address</label>
          <input id="hub-url" className="input mono !h-10" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://mergeport.example.com" inputMode="url" autoComplete="off" spellCheck={false} />
          <button className="btn !h-10 w-fit" disabled={busy || !url.trim()}>
            {busy && <LoaderCircle size={14} aria-hidden className="animate-spin" />} Check server
          </button>
        </form>
      )}

      {step.s === "checked" && (
        <div className="flex flex-col gap-3">
          <p>
            {step.teamName ? <strong>{step.teamName}</strong> : "This server has no team yet."} <span className="text-ink-3">at</span> <span className="mono break-all">{step.origin}</span>
          </p>
          <div className="flex gap-2">
            <button className="btn btn-primary !h-10" disabled={busy} onClick={() => void connect(step.origin)}>
              {busy && <LoaderCircle size={14} aria-hidden className="animate-spin" />} Connect
            </button>
            <button className="btn !h-10" disabled={busy} onClick={() => reset(null)}>Change</button>
          </div>
        </div>
      )}

      {step.s === "code" && (
        <div className="flex flex-col gap-3" role="status">
          <p>Enter this code on GitHub to sign in to the server.</p>
          <p className="mono rounded-[8px] border border-line bg-canvas p-3 text-center text-[20px] tracking-widest">{step.userCode}</p>
          <a className="btn btn-primary !h-10 w-fit" href={step.verificationUri} target="_blank" rel="noopener noreferrer">Open GitHub</a>
          <p className="flex items-center gap-2 text-ink-3"><LoaderCircle size={14} aria-hidden className="animate-spin" />Waiting for you to approve…</p>
          <button className="btn !h-10 w-fit" onClick={() => reset(null)}>Cancel</button>
        </div>
      )}
    </div>
  );
}
