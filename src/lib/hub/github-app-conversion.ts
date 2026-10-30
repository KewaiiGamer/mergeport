/**
 * Exchanges the manifest `code` GitHub hands back for the new App's settings (`POST /app-manifests/<code>/conversions`,
 * no authentication). The answer also carries the App's private key (`pem`), `client_secret`, `client_id` and `id`. This
 * function reads the JSON, copies out `webhook_secret` and `slug`, and lets everything else go out of scope: nothing else is
 * returned, stored, logged or put in an error, so no caller can leak it.
 */
export type ConversionReason = "bad-code" | "network" | "refused" | "bad-answer";
export class ConversionError extends Error {
  constructor(readonly reason: ConversionReason) {
    super(`GitHub App conversion failed: ${reason}`);
    this.name = "ConversionError";
  }
}

const TIMEOUT_MS = 15_000;
const CODE = /^[A-Za-z0-9_-]{8,128}$/;
const SLUG = /^[A-Za-z0-9-]{1,100}$/;

let injected: typeof fetch | null = null;
/** Tests only: route the call to a fake GitHub. Pass null to restore the real `fetch`. */
export function useConversionFetch(f: typeof fetch | null): void {
  injected = f;
}

export async function convertManifest(code: string, fetchImpl: typeof fetch = injected ?? fetch): Promise<{ secret: string; slug: string }> {
  if (!CODE.test(code)) throw new ConversionError("bad-code");
  let res: Response;
  try {
    res = await fetchImpl(`https://api.github.com/app-manifests/${code}/conversions`, {
      method: "POST",
      headers: { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "mergeport" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: "error",
    });
  } catch {
    throw new ConversionError("network");
  }
  if (res.status !== 201 && res.status !== 200) throw new ConversionError("refused");
  let secret: unknown;
  let slug: unknown;
  try {
    const j = (await res.json()) as Record<string, unknown>;
    secret = j.webhook_secret;
    slug = j.slug;
  } catch {
    throw new ConversionError("bad-answer");
  }
  if (typeof secret !== "string" || secret.length < 32 || secret.length > 256 || typeof slug !== "string" || !SLUG.test(slug)) throw new ConversionError("bad-answer");
  return { secret, slug };
}
