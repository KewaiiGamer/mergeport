"use client";

import { useEffect, useRef, useState, useTransition, type FormEvent, type ReactNode } from "react";
import type { ActionResult } from "@/lib/action-result";
import { CircleAlert, LoaderCircle } from "@/components/ui/icons";
import { useSheetClose } from "@/components/ui/dialog";
import { CopyField } from "./CopyField";

/**
 * Form wrapper for server actions.
 * - Drafts survive failures: the form is only reset after a successful result.
 * - Double submits are impossible: the submit button is disabled while pending.
 * - Errors are announced (role=alert) and retryable.
 */
export function ActionForm({
  action,
  children,
  submitLabel,
  pendingLabel = "Working…",
  className,
  resetOnSuccess = true,
  closeOnSuccess = false,
  onDone,
  secondary,
  success,
  submitClassName = "btn btn-primary",
  submitAriaLabel,
}: {
  action: (fd: FormData) => Promise<ActionResult>;
  children: ReactNode;
  submitLabel: string;
  pendingLabel?: string;
  className?: string;
  resetOnSuccess?: boolean;
  /** Inside a Sheet: close the dialog after a successful submit. A failure keeps it open with the input intact. */
  closeOnSuccess?: boolean;
  onDone?: (r: ActionResult) => void;
  secondary?: ReactNode;
  /** Server Components cannot pass functions, so the success output is described as data. */
  success?: { copy?: { field: string; label: string; hint?: string; absolute?: boolean }; link?: { href: string; label: string } };
  submitClassName?: string;
  /** Distinguishes repeated buttons ("Refresh" in every row) for assistive technology. */
  submitAriaLabel?: string;
}) {
  const [pending, start] = useTransition();
  const [result, setResult] = useState<ActionResult | null>(null);
  const [seq, setSeq] = useState(0);
  const ref = useRef<HTMLFormElement>(null);
  const row = useRef<HTMLDivElement>(null);
  const [slow, setSlow] = useState(false);
  const closeSheet = useSheetClose();

  // Real pending work only: after a few seconds say so in words, so a slow network is not mistaken for a dead button.
  useEffect(() => {
    if (!pending) return;
    const t = setTimeout(() => setSlow(true), 3000);
    return () => clearTimeout(t);
  }, [pending]);

  // A failed submit nudges the action row once (not the whole form, and never the focused field). The message is the real feedback.
  const failed = !!result && !result.ok;
  useEffect(() => {
    const el = row.current;
    if (!failed || !el) return;
    el.classList.remove("shake");
    void el.offsetWidth; // restart the animation for a second failure in a row
    el.classList.add("shake");
  }, [failed, seq]);

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (pending) return;
    setSlow(false);
    const fd = new FormData(e.currentTarget);
    start(async () => {
      let r: ActionResult;
      try {
        r = await action(fd);
      } catch {
        // Offline or the server is unreachable. The input is kept so nothing has to be retyped.
        r = { ok: false, error: "Could not reach the server. Your input is kept. Check your connection and try again.", retryable: true };
      }
      setResult(r);
      setSeq((n) => n + 1);
      if (r.ok && resetOnSuccess) ref.current?.reset();
      if (r.ok && closeOnSuccess) closeSheet?.();
      onDone?.(r);
    });
  }

  return (
    <form ref={ref} onSubmit={submit} className={className} aria-busy={pending}>
      {children}
      <div ref={row} className="mt-3 flex flex-wrap items-center gap-2" onAnimationEnd={(e) => { if (e.target === e.currentTarget) e.currentTarget.classList.remove("shake"); }}>
        <button type="submit" className={submitClassName} disabled={pending} data-loading={pending} aria-label={submitAriaLabel}>
          {pending ? <LoaderCircle size={14} aria-hidden className="animate-spin" /> : null}
          {pending ? pendingLabel : submitLabel}
        </button>
        {secondary}
        {/* Two permanent regions: a region that changes role in the same render it gains text is often not announced. */}
        <p role="status" aria-live="polite" className="min-h-5 text-[12.5px]">
          {pending && slow && <span className="text-ink-3">Still working. This is taking longer than usual; your input is kept.</span>}
          {!pending && result?.ok && (
            <span key={seq} className="result-in inline-flex items-center gap-1 text-ok">
              <svg className="check-draw shrink-0" width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M20 6 9 17l-5-5" pathLength={1} />
              </svg>
              {result.message ?? "Saved"}
            </span>
          )}
        </p>
        <p role="alert" className="text-[12.5px]">
          {result && !result.ok && (
            <span key={seq} className="result-in inline-flex items-start gap-1 text-blocked">
              <CircleAlert size={14} aria-hidden className="mt-0.5 shrink-0" /> {result.error}
            </span>
          )}
        </p>
      </div>
      {result?.ok && success?.copy && result.data?.[success.copy.field] ? (
        <div className="mt-2"><CopyField absolute={success.copy.absolute} label={success.copy.label} value={String(result.data[success.copy.field])} hint={success.copy.hint} /></div>
      ) : null}
      {result?.ok && success?.link ? <div className="mt-2"><a className="btn btn-primary" href={success.link.href}>{success.link.label}</a></div> : null}
    </form>
  );
}
