import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { createPrisma } from "@/lib/db";
import { clearHubSession, loadHubSession, openVault, saveHubSession } from "@/lib/hub/session-vault";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hub-vault-"));
const db = createPrisma(path.resolve(".data", `hub-client-vault-${process.pid}.db`));
afterAll(async () => {
  await db.$disconnect();
  fs.rmSync(dir, { recursive: true, force: true });
});

const TOKEN = "hubtok-SECRET-1234567890";
const sess = { origin: "https://hub.example", token: TOKEN, githubId: 42n, login: "alice" };

describe("session vault", () => {
  it("creates the key file once and reuses it", () => {
    const keyFile = path.join(dir, "key1");
    const a = openVault(keyFile);
    const b = openVault(keyFile);
    expect(b.decrypt(a.encrypt("hello"))).toBe("hello");
    expect(fs.readFileSync(keyFile).length).toBe(32);
  });

  it("encrypts to v1.iv.tag.data", () => {
    const c = openVault(path.join(dir, "key1")).encrypt("x");
    expect(c.split(".")).toHaveLength(4);
    expect(c.startsWith("v1.")).toBe(true);
  });

  it("round-trips a session without exposing the token in the DB or key file", async () => {
    const keyFile = path.join(dir, "key2");
    const vault = openVault(keyFile);
    await saveHubSession(db, vault, sess);
    expect(await loadHubSession(db, vault)).toEqual(sess);
    const row = await db.hubSession.findUniqueOrThrow({ where: { id: "session" } });
    expect(row.cipher).not.toContain(TOKEN);
    expect(fs.readFileSync(keyFile).toString("latin1")).not.toContain(TOKEN);
  });

  it("upserts the single session row", async () => {
    const vault = openVault(path.join(dir, "key2"));
    await saveHubSession(db, vault, { ...sess, login: "bob" });
    expect((await loadHubSession(db, vault))?.login).toBe("bob");
    expect(await db.hubSession.count()).toBe(1);
  });

  it("returns null with a different key file", async () => {
    const other = openVault(path.join(dir, "key3"));
    expect(await loadHubSession(db, other)).toBeNull();
  });

  it("returns null for a tampered cipher", async () => {
    const vault = openVault(path.join(dir, "key2"));
    const row = await db.hubSession.findUniqueOrThrow({ where: { id: "session" } });
    const parts = row.cipher.split(".");
    parts[3] = Buffer.from("tampered").toString("base64");
    await db.hubSession.update({ where: { id: "session" }, data: { cipher: parts.join(".") } });
    expect(await loadHubSession(db, vault)).toBeNull();
  });

  it("clearHubSession removes the session", async () => {
    const vault = openVault(path.join(dir, "key2"));
    await saveHubSession(db, vault, sess);
    await clearHubSession(db);
    expect(await loadHubSession(db, vault)).toBeNull();
    await clearHubSession(db);
  });

  it("throws on a wrong-length key file and leaves it untouched", () => {
    const keyFile = path.join(dir, "key-bad");
    fs.writeFileSync(keyFile, "short");
    expect(() => openVault(keyFile)).toThrow(/corrupt/);
    expect(fs.readFileSync(keyFile, "utf8")).toBe("short");
  });

  it("returns null when the auth tag segment is tampered", async () => {
    const vault = openVault(path.join(dir, "key2"));
    await saveHubSession(db, vault, sess);
    const row = await db.hubSession.findUniqueOrThrow({ where: { id: "session" } });
    const parts = row.cipher.split(".");
    parts[2] = Buffer.alloc(16, 1).toString("base64");
    await db.hubSession.update({ where: { id: "session" }, data: { cipher: parts.join(".") } });
    expect(await loadHubSession(db, vault)).toBeNull();
    parts[2] = Buffer.alloc(4, 1).toString("base64");
    await db.hubSession.update({ where: { id: "session" }, data: { cipher: parts.join(".") } });
    expect(await loadHubSession(db, vault)).toBeNull();
  });

  it("concurrent first opens from separate processes converge on one key", async () => {
    const keyFile = path.join(dir, "key-race");
    const script = pathToFileURL(path.resolve("src/lib/hub/session-vault.ts")).href;
    const code = `import { openVault } from ${JSON.stringify(script)}; process.stdout.write(openVault(${JSON.stringify(keyFile)}).encrypt("x"));`;
    const tsx = path.resolve("node_modules/tsx/dist/cli.mjs");
    const run = () =>
      new Promise<string>((resolve, reject) =>
        execFile(process.execPath, [tsx, "--input-type=module", "-e", code], (err, out) => (err ? reject(err) : resolve(out))),
      );
    const ciphers = await Promise.all(Array.from({ length: 6 }, run));
    const vault = openVault(keyFile);
    for (const c of ciphers) expect(vault.decrypt(c)).toBe("x");
    expect(fs.readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  }, 60000);

  it.skipIf(process.platform === "win32")("key file mode is 0600", () => {
    const keyFile = path.join(dir, "key-mode");
    openVault(keyFile);
    expect(fs.statSync(keyFile).mode & 0o777).toBe(0o600);
  });
});
