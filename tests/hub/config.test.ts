import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../hub/src/config";
import { openHubDb } from "../../hub/src/db";
import { startTestHub } from "./harness";

describe("hub config and health", () => {
  it("refuses to start without GitHub OAuth values", () => {
    expect(() => loadConfig({ MERGEPORT_HUB_PUBLIC_URL: "https://h.example" })).toThrow(/MERGEPORT_HUB_GITHUB_CLIENT_ID/);
  });
  it("refuses to start without the owner login", () => {
    const base = { MERGEPORT_HUB_GITHUB_CLIENT_ID: "a", MERGEPORT_HUB_GITHUB_CLIENT_SECRET: "b", MERGEPORT_HUB_DATA: "x", MERGEPORT_HUB_PUBLIC_URL: "https://h.example" };
    expect(() => loadConfig(base)).toThrow(/MERGEPORT_HUB_OWNER_LOGIN/);
    expect(() => loadConfig({ ...base, MERGEPORT_HUB_OWNER_LOGIN: "not a login" })).toThrow(/MERGEPORT_HUB_OWNER_LOGIN/);
    expect(loadConfig({ ...base, MERGEPORT_HUB_OWNER_LOGIN: "Olive-1" }).ownerLogin).toBe("Olive-1");
  });
  it("binds loopback unless trustProxy=false and https public url", () => {
    const base = { MERGEPORT_HUB_GITHUB_CLIENT_ID: "a", MERGEPORT_HUB_GITHUB_CLIENT_SECRET: "b", MERGEPORT_HUB_DATA: "x", MERGEPORT_HUB_OWNER_LOGIN: "olive" };
    expect(loadConfig({ ...base, MERGEPORT_HUB_PUBLIC_URL: "https://h.example", MERGEPORT_HUB_TRUST_PROXY: "true" }).bindHost).toBe("127.0.0.1");
    expect(loadConfig({ ...base, MERGEPORT_HUB_PUBLIC_URL: "http://h.example", MERGEPORT_HUB_TRUST_PROXY: "false" }).bindHost).toBe("127.0.0.1");
    expect(loadConfig({ ...base, MERGEPORT_HUB_PUBLIC_URL: "https://h.example", MERGEPORT_HUB_TRUST_PROXY: "false" }).bindHost).toBe("0.0.0.0");
  });
  it("MERGEPORT_HUB_BIND_HOST overrides the derived bind address", () => {
    const base = { MERGEPORT_HUB_GITHUB_CLIENT_ID: "a", MERGEPORT_HUB_GITHUB_CLIENT_SECRET: "b", MERGEPORT_HUB_DATA: "x", MERGEPORT_HUB_OWNER_LOGIN: "olive", MERGEPORT_HUB_PUBLIC_URL: "https://h.example", MERGEPORT_HUB_TRUST_PROXY: "true" };
    expect(loadConfig({ ...base, MERGEPORT_HUB_BIND_HOST: "0.0.0.0" }).bindHost).toBe("0.0.0.0");
    expect(loadConfig({ ...base, MERGEPORT_HUB_BIND_HOST: "172.18.0.5" }).bindHost).toBe("172.18.0.5");
    expect(() => loadConfig({ ...base, MERGEPORT_HUB_BIND_HOST: "not an ip" })).toThrow(/MERGEPORT_HUB_BIND_HOST/);
  });
  it("trustProxy defaults to false (binds 0.0.0.0 with an https public url, loopback otherwise)", () => {
    const base = { MERGEPORT_HUB_GITHUB_CLIENT_ID: "a", MERGEPORT_HUB_GITHUB_CLIENT_SECRET: "b", MERGEPORT_HUB_DATA: "x", MERGEPORT_HUB_OWNER_LOGIN: "olive" };
    const https = loadConfig({ ...base, MERGEPORT_HUB_PUBLIC_URL: "https://h.example" });
    expect(https.trustProxy).toBe(false);
    expect(https.bindHost).toBe("0.0.0.0");
    const http = loadConfig({ ...base, MERGEPORT_HUB_PUBLIC_URL: "http://h.example" });
    expect(http.trustProxy).toBe(false);
    expect(http.bindHost).toBe("127.0.0.1");
    expect(loadConfig({ ...base, MERGEPORT_HUB_PUBLIC_URL: "https://h.example", MERGEPORT_HUB_TRUST_PROXY: "true" }).trustProxy).toBe(true);
  });
  it("serves /health with team null before bootstrap", async () => {
    const hub = await startTestHub();
    const r = await hub.api()("GET", "/health");
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, bootstrapped: false, team: null, schema: 1, publicUrl: hub.url, githubHost: "github.com" });
    await hub.close();
  });
  it("refuses a database from a newer hub", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "hub-"));
    const db = openHubDb(dir);
    db.prepare("INSERT INTO _mergeport_migrations (name, applied_at) VALUES ('99999999999999_future', 'now')").run();
    db.close();
    expect(() => openHubDb(dir)).toThrow(/newer/);
  });
  it("answers 400 to a malformed JSON body", async () => {
    const hub = await startTestHub();
    const r = await fetch(hub.url + "/auth/device/poll", { method: "POST", body: "{not json", headers: { "content-type": "application/json" } });
    expect(r.status).toBe(400);
    await hub.close();
  });
  it("answers 413 to an oversized body", async () => {
    const hub = await startTestHub();
    const r = await fetch(hub.url + "/auth/device/poll", { method: "POST", body: "x".repeat(5_000_000), headers: { "content-type": "application/json" } });
    expect(r.status).toBe(413);
    await hub.close();
  });
});
