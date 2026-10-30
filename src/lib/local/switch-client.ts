import type { Backend } from "@/lib/local/backends";
import { ValidationError } from "@/lib/errors";

/** Asks the launcher (the supervisor's loopback control channel) to restart the app on another workspace. */
export async function requestSwitch(backend: Backend, deps: { env?: Record<string, string | undefined>; fetch?: typeof fetch } = {}): Promise<{ launchUrl: string; previousBootId: string | null }> {
  const e = deps.env ?? process.env;
  const url = e.MERGEPORT_CONTROL_URL;
  // This child's own launch token: the supervisor accepts only the current child's, so an older process cannot switch.
  const token = e.MERGEPORT_LAUNCH_TOKEN;
  if (!url || !token) throw new ValidationError("Switching needs the launcher. Start Mergeport with npm run local.");
  const res = await (deps.fetch ?? fetch)(`${url}/switch`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-mergeport-control": token },
    body: JSON.stringify({ backend }),
  });
  const body = (await res.json().catch(() => ({}))) as { launchUrl?: string; previousBootId?: string | null; error?: string };
  if (!res.ok || !body.launchUrl) throw new Error(body.error ?? `Switch failed (${res.status})`);
  return { launchUrl: body.launchUrl, previousBootId: body.previousBootId ?? null };
}
