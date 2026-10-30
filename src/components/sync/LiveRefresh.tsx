"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";

const DEBOUNCE_MS = 400;
const MAX_WAIT_MS = 4000;
const MIN_GAP_MS = 3000;
/**
 * A teammate's edit that just arrived (reason "pulled") is what a person is waiting to see, and on a hub server it comes in over the
 * live link within milliseconds. It gets a much shorter debounce and gap than the "state" bursts of background jobs, which stay throttled.
 */
const PULLED_DEBOUNCE_MS = 100;
const PULLED_MIN_GAP_MS = 600;

/**
 * Keeps the open page current without a manual reload: listens for change events from the local server (a teammate's
 * edit arrived, a push finished) and refreshes the server-rendered data. Refreshes are debounced with a maximum wait and
 * a minimum gap, skipped while the tab is hidden (one catch-up refresh happens when it becomes visible), and never replay
 * entrance animations; scroll position and focus are preserved by router.refresh(). It also tells the server whether
 * this tab is visible so background polling can slow down, and reconnects if the stream drops.
 */
export function LiveRefresh() {
  const router = useRouter();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const firstEvent = useRef(0);
  const lastRefresh = useRef(0);
  const stale = useRef(false);

  useEffect(() => {
    let es: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let backoff = 1000;
    let closed = false;

    const refreshNow = () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      firstEvent.current = 0;
      if (document.visibilityState !== "visible") {
        stale.current = true;
        return;
      }
      stale.current = false;
      lastRefresh.current = Date.now();
      router.refresh();
    };
    const schedule = (urgent = false) => {
      const now = Date.now();
      if (!firstEvent.current) firstEvent.current = now;
      if (timer.current) clearTimeout(timer.current);
      const debounce = urgent ? PULLED_DEBOUNCE_MS : DEBOUNCE_MS;
      const gap = urgent ? PULLED_MIN_GAP_MS : MIN_GAP_MS;
      const wait = Math.min(Math.max(debounce, lastRefresh.current + gap - now), Math.max(0, firstEvent.current + MAX_WAIT_MS - now));
      timer.current = setTimeout(refreshNow, wait);
    };
    const connect = () => {
      if (closed) return;
      es = new EventSource("/api/sync/events");
      es.onopen = () => {
        backoff = 1000;
      };
      es.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data) as { hello?: boolean; reason?: string };
          if (msg.hello) return;
          if (msg.reason === "pulled") schedule(true);
          else if (msg.reason === "pushed" || msg.reason === "state") schedule();
        } catch {
          /* ignore malformed event */
        }
      };
      es.onerror = () => {
        es?.close();
        es = null;
        if (closed) return;
        retry = setTimeout(connect, backoff);
        backoff = Math.min(backoff * 2, 30_000);
      };
    };
    const report = () => {
      void fetch("/api/sync/visibility", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ visible: document.visibilityState === "visible" }) }).catch(() => {});
      if (document.visibilityState === "visible" && stale.current) refreshNow();
    };
    connect();
    report();
    document.addEventListener("visibilitychange", report);
    return () => {
      closed = true;
      es?.close();
      if (retry) clearTimeout(retry);
      document.removeEventListener("visibilitychange", report);
      if (timer.current) clearTimeout(timer.current);
    };
  }, [router]);
  return null;
}
