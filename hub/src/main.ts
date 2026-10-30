import { loadConfig } from "./config";
import { openHubDb } from "./db";
import { createHub } from "./server";

async function main() {
  const config = loadConfig(process.env);
  const db = openHubDb(config.dataDir);
  const hub = createHub({ config, db });
  const { url } = await hub.listen(config.port);
  console.log(`Mergeport hub listening on ${url} (bind ${config.bindHost}, public ${config.publicUrl})`);

  let stopping = false;
  async function stop() {
    if (stopping) return;
    stopping = true;
    await hub.close();
    db.close();
    process.exit(0);
  }
  process.on("SIGTERM", () => void stop());
  process.on("SIGINT", () => void stop());
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
