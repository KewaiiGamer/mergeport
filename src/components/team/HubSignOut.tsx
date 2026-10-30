"use client";

import { useState, useTransition } from "react";
import { SwitchingOverlay } from "@/components/shell/SwitchingOverlay";
import { Banner } from "@/components/ui/primitives";
import { LoaderCircle, LogOut } from "@/components/ui/icons";
import type { ActionResult } from "@/lib/action-result";

type Switch = { launchUrl: string; previousBootId: string | null; expectedBackend: string };

/** Ends the hub session, then asks the launcher to restart the app on GitHub. The overlay is rendered here, in place, until it answers. */
export function HubSignOut({ action }: { action: () => Promise<ActionResult> }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [sw, setSw] = useState<Switch | null>(null);

  function go() {
    setError(null);
    start(async () => {
      try {
        const r = await action();
        if (!r.ok) return void setError(r.error);
        const res = await fetch("/api/local/switch", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ backend: "github" }) });
        const body = (await res.json().catch(() => ({}))) as Partial<Switch> & { error?: string };
        if (!res.ok || !body.launchUrl || !body.expectedBackend) return void setError(body.error ?? "Signed out of the server, but could not switch to GitHub. Restart Mergeport.");
        setSw({ launchUrl: body.launchUrl, previousBootId: body.previousBootId ?? null, expectedBackend: body.expectedBackend });
      } catch {
        setError("Could not reach Mergeport. Check that it is still running.");
      }
    });
  }

  return (
    <>
      <div className="flex flex-col items-start gap-2">
        <button type="button" className="btn !h-10" onClick={go} disabled={pending || !!sw} data-loading={pending}>
          {pending ? <LoaderCircle size={14} aria-hidden className="animate-spin" /> : <LogOut size={14} aria-hidden />}
          Sign out of this server
        </button>
        {error && <Banner tone="error" title={error} />}
      </div>
      {sw && <SwitchingOverlay {...sw} />}
    </>
  );
}
