import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { hubBackendId, isHubBackend, normalizeHubOrigin } from "@/lib/local/backends";
import { profileDbPath } from "@/lib/local/profile";
import { readActive, readHubs, removeHub, upsertHub, writeActive, type HubEntry } from "@/lib/local/registry";
import { savedProfiles } from "@/lib/local/saved-profiles";

const dirs: string[] = [];
const home = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "mp-registry-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function profileDir(h: string, dirName: string, id: number, login: string) {
  const dir = path.join(h, "profiles", dirName);
  fs.mkdirSync(dir, { recursive: true });
  const db = new Database(path.join(dir, "mergeport.db"));
  db.exec("create table User (id text, githubId integer, login text, isDemo integer, createdAt text)");
  db.prepare("insert into User values ('u', ?, ?, 0, '2026-01-01')").run(id, login);
  db.close();
}

const entry = (over: Partial<HubEntry> = {}): HubEntry => ({ origin: "https://hub.example.com", teamName: "Team", lastSignedInAs: { id: "5", login: "octocat" }, addedAt: "2026-10-29T00:00:00.000Z", ...over });

describe("hub origin and backend id", () => {
  it("normalizes scheme, host, port, path, query and hash", () => {
    expect(normalizeHubOrigin("HTTPS://Hub.Example.com:443/x/?a#b")).toBe("https://hub.example.com");
    expect(normalizeHubOrigin("http://localhost:8787/")).toBe("http://localhost:8787");
  });
  it("refuses plain http off loopback, userinfo and non-URLs", () => {
    expect(() => normalizeHubOrigin("http://hub.example.com")).toThrow();
    expect(() => normalizeHubOrigin("https://u:p@hub.example.com")).toThrow();
    expect(() => normalizeHubOrigin("nope")).toThrow();
  });
  it("gives one fingerprint per origin", () => {
    const a = hubBackendId("https://hub.example.com/");
    expect(a).toBe(hubBackendId("https://HUB.example.com"));
    expect(a).toMatch(/^hub-[0-9a-f]{16}$/);
    expect(isHubBackend(a)).toBe(true);
    expect(isHubBackend("github")).toBe(false);
  });
});

describe("profile paths", () => {
  it("leaves the github path unchanged and suffixes hub profiles", () => {
    const h = home();
    expect(profileDbPath(h, "github.com", 5n)).toBe(path.join(h, "profiles", "github.com-5", "mergeport.db"));
    const b = hubBackendId("https://hub.example.com");
    expect(profileDbPath(h, "github.com", 5n, b)).toBe(path.join(h, "profiles", `github.com-5-${b}`, "mergeport.db"));
  });
  it("savedProfiles ignores hub dirs beside github dirs", () => {
    const h = home();
    profileDir(h, "github.com-5", 5, "octocat");
    profileDir(h, "github.com-5-hub-0123456789abcdef", 5, "octocat");
    expect(savedProfiles(h, "github.com").map((p) => p.id)).toEqual([5n]);
  });
});

describe("active.json and hubs.json", () => {
  it("readActive tolerates missing, corrupt and wrong-shape files", () => {
    const h = home();
    expect(readActive(h)).toBeNull();
    fs.writeFileSync(path.join(h, "active.json"), "{not json");
    expect(readActive(h)).toBeNull();
    fs.writeFileSync(path.join(h, "active.json"), JSON.stringify({ host: "github.com", accountId: 5 }));
    expect(readActive(h)).toBeNull();
  });
  it("round-trips active", () => {
    const h = home();
    writeActive(h, { host: "github.com", accountId: "12345678901234567890", backend: "github" });
    expect(readActive(h)).toEqual({ host: "github.com", accountId: "12345678901234567890", backend: "github" });
  });
  it("upserts hubs by origin, removes them and survives corruption", () => {
    const h = home();
    upsertHub(h, entry());
    upsertHub(h, entry({ teamName: "Renamed" }));
    expect(readHubs(h)).toHaveLength(1);
    expect(readHubs(h)[0].teamName).toBe("Renamed");
    expect(fs.readFileSync(path.join(h, "hubs.json"), "utf8")).not.toMatch(/"(token|session)"/);
    removeHub(h, "https://hub.example.com");
    expect(readHubs(h)).toEqual([]);
    fs.writeFileSync(path.join(h, "hubs.json"), "{{{");
    expect(readHubs(h)).toEqual([]);
  });
});
