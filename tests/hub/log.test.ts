import { describe, expect, it } from "vitest";
import { createLogger, redact } from "../../hub/src/log";

describe("log", () => {
  it("redact drops token/secret/code/data keys", () => {
    expect(redact({ accessToken: "x", clientSecret: "y", deviceCode: "z", data: "d", login: "olive" })).toEqual({ login: "olive" });
  });
  it("logger writes redacted JSON lines to the sink", () => {
    const lines: string[] = [];
    createLogger((l) => lines.push(l)).warn("hi", { token: "abc", githubId: 5n });
    expect(JSON.parse(lines[0])).toEqual({ level: "warn", msg: "hi", githubId: "5" });
  });
});
