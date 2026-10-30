// Stand-in for the app child process, used by supervisor/profile-switch tests.
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";

const bootId = randomUUID();
const db = process.env.MERGEPORT_DB ?? "";
const sid = createHash("sha256").update(db).digest("hex").slice(0, 16);
let tokenUsed = false;

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (req.method === "GET" && url.pathname === "/api/local/ready") {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ bootId, backend: process.env.MERGEPORT_BACKEND ?? "github" }));
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/local/launch") {
    if (tokenUsed || url.searchParams.get("token") !== process.env.MERGEPORT_LAUNCH_TOKEN) {
      res.statusCode = 403;
      res.end("forbidden");
      return;
    }
    tokenUsed = true;
    res.statusCode = 302;
    res.setHeader("set-cookie", `sid=${sid}; Path=/; HttpOnly`);
    res.setHeader("location", "/");
    res.end();
    return;
  }
  if (req.method === "GET" && url.pathname === "/whoami") {
    if (!(req.headers.cookie ?? "").split(/;\s*/).includes(`sid=${sid}`)) {
      res.statusCode = 401;
      res.end();
      return;
    }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ db }));
    return;
  }
  res.statusCode = 404;
  res.end();
});

server.listen(Number(process.env.MERGEPORT_PORT), "127.0.0.1");
