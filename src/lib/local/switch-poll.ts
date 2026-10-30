export type SwitchOutcome = "go-launch" | "restored" | "timeout";
export type Ready = { bootId: string; backend: string };

/**
 * Accepts only `http://127.0.0.1:<port>/api/local/launch?token=...` on the page's own host, so a switch can never
 * send the browser somewhere else (no open redirect).
 */
export function validateSwitchTarget(url: string, host: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== "http:" || u.hostname !== "127.0.0.1" || !u.port) return false;
  if (u.username || u.password || u.hash) return false;
  if (u.host !== host) return false;
  return u.pathname === "/api/local/launch" && (u.searchParams.get("token") ?? "") !== "";
}

/**
 * Waits for the app to restart. Fetch errors while the old child is down are expected and ignored.
 * With no known previous boot id, the first successful fetch before any error is the old process; a success after an
 * error is a new boot.
 */
export async function pollSwitch(i: {
  fetchReady: () => Promise<Ready>;
  previousBootId: string | null;
  expectedBackend: string;
  timeoutMs?: number;
  intervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<SwitchOutcome> {
  const timeoutMs = i.timeoutMs ?? 60_000;
  const intervalMs = i.intervalMs ?? 400;
  const sleep = i.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = Date.now() + timeoutMs;
  let previous = i.previousBootId;
  let sawError = false;
  for (let tick = 0; tick * intervalMs < timeoutMs && Date.now() < deadline; tick++) {
    try {
      const r = await i.fetchReady();
      if (previous === null && !sawError) previous = r.bootId;
      else if (r.bootId !== previous) return r.backend === i.expectedBackend ? "go-launch" : "restored";
    } catch {
      sawError = true;
    }
    await sleep(intervalMs);
  }
  return "timeout";
}
