"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { Logo } from "@/components/ui/Logo";
import { Banner } from "@/components/ui/primitives";
import { pollSwitch, validateSwitchTarget, type Ready } from "@/lib/local/switch-poll";

type Props = { launchUrl: string; previousBootId: string | null; expectedBackend: string };

/** Full-screen state shown in place while the app restarts on another workspace. Rendered by the caller, not a route: the old app stops serving pages. */
export function SwitchingOverlay({ launchUrl, previousBootId, expectedBackend }: Props) {
  const [state, setState] = useState<"waiting" | "timeout" | "invalid">("waiting");
  const mounted = useSyncExternalStore(() => () => {}, () => true, () => false);

  useEffect(() => {
    let cancelled = false;
    const fetchReady = async (): Promise<Ready> => {
      const res = await fetch("/api/local/ready", { cache: "no-store", signal: AbortSignal.timeout(2000) });
      if (!res.ok) throw new Error("not ready");
      return (await res.json()) as Ready;
    };
    void (async () => {
      if (!validateSwitchTarget(launchUrl, window.location.host)) {
        if (!cancelled) setState("invalid");
        return;
      }
      const outcome = await pollSwitch({ fetchReady, previousBootId, expectedBackend });
      if (cancelled) return;
      if (outcome === "go-launch") window.location.href = launchUrl;
      else if (outcome === "restored") window.location.href = `${window.location.origin}/`;
      else setState("timeout");
    })();
    return () => {
      cancelled = true;
    };
  }, [launchUrl, previousBootId, expectedBackend]);

  // A full page load on purpose: the app behind this page may have restarted.
  // eslint-disable-next-line @next/next/no-html-link-for-pages
  const back = <a href="/" className="btn">Back</a>;
  // Portaled to <body>: a caller inside the top bar (backdrop-blur) would otherwise confine position:fixed to the header.
  if (!mounted) return null;
  return createPortal(
    <div className="fixed inset-0 z-50 grid place-items-center bg-canvas p-6">
      <div className="panel w-full max-w-[420px]">
        <div className="panel-body flex flex-col items-center gap-4 p-6 text-center">
          <Logo size={40} />
          {state === "waiting" ? (
            <div role="status">
              <h1 className="text-[20px] font-medium">Switching workspace…</h1>
              <p className="mt-2 text-[13px] text-ink-3">This takes a few seconds.</p>
            </div>
          ) : (
            <div className="w-full text-left">
              <Banner tone="error" title={state === "invalid" ? "The switch link is not valid" : "The other workspace did not start"} action={back} />
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
