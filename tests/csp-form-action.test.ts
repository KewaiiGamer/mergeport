import { describe, expect, it } from "vitest";
import config from "../next.config";

describe("Content-Security-Policy form-action", () => {
  it("allows only the manifest paths on github.com, never github.com as a whole", async () => {
    const rules = await config.headers!();
    const csp = rules.flatMap((r) => r.headers).find((h) => h.key === "Content-Security-Policy")!.value;
    const directives = Object.fromEntries(csp.split(";").map((d) => d.trim().split(/\s+/)).map(([k, ...v]) => [k, v]));
    const sources = directives["form-action"];
    expect(sources).toEqual(["'self'", "https://github.com/settings/apps/new", "https://github.com/organizations/"]);
    expect(sources).not.toContain("https://github.com");
    expect(sources.some((s) => /^https:\/\/github\.com\/?$/.test(s) || s.includes("*"))).toBe(false);
    expect(directives["frame-ancestors"]).toEqual(["'none'"]);
    expect(directives["base-uri"]).toEqual(["'self'"]);
    expect(directives["object-src"]).toEqual(["'none'"]);
  });
});
