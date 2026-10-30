"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Select } from "@/components/ui/Select";
import { useToast } from "@/components/ui/ToastProvider";
import { SwitchingOverlay } from "@/components/shell/SwitchingOverlay";
import type { WorkspaceEntry } from "@/lib/local/workspaces";

const CONNECT = "__connect__";
type Switch = { launchUrl: string; previousBootId: string | null; expectedBackend: string };

/** Picks which workspace the app runs on. A choice restarts the app, so the overlay is rendered here, in place, until the new one answers. */
export function WorkspaceSwitcher({ entries, active, switchable }: { entries: WorkspaceEntry[]; active: string; switchable: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const [sw, setSw] = useState<Switch | null>(null);
  const [busy, setBusy] = useState(false);

  async function choose(value: string) {
    if (value === CONNECT) {
      router.push("/sign-in?connect=1");
      return;
    }
    if (value === active || busy) return;
    setBusy(true);
    try {
      const res = await fetch("/api/local/switch", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ backend: value }) });
      const body = (await res.json().catch(() => ({}))) as Partial<Switch> & { error?: string };
      if (!res.ok || !body.launchUrl || !body.expectedBackend) {
        toast.show("error", body.error ?? "Could not switch workspace.");
        setBusy(false);
        return;
      }
      setSw({ launchUrl: body.launchUrl, previousBootId: body.previousBootId ?? null, expectedBackend: body.expectedBackend });
    } catch {
      toast.show("error", "Could not reach Mergeport to switch workspace.");
      setBusy(false);
    }
  }

  if (!switchable) return <span className="max-w-[7.5rem] shrink-0 truncate text-[12px] text-ink-3 sm:max-w-none">GitHub (repositories)</span>;
  return (
    <>
      <div className="w-[7.5rem] shrink-0 sm:w-[13rem]">
        <Select aria-label="Workspace" aria-busy={busy} className="select !h-10 text-[13px]" value={active} disabled={busy} onChange={(e) => void choose(e.target.value)}>
          {entries.map((e) => (
            <option key={e.backend} value={e.backend} disabled={!e.available}>
              {e.detail ? `${e.label} · ${e.detail}` : e.label}
            </option>
          ))}
          <option value={CONNECT}>Connect to a server…</option>
        </Select>
      </div>
      {sw && <SwitchingOverlay {...sw} />}
    </>
  );
}
