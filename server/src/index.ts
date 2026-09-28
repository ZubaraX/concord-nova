import dns from "node:dns";
// Prefer IPv4 for outbound connections: VPS IPv6 routes are often flaky and
// Node would otherwise stall on an IPv6 attempt (GIF search, link previews).
dns.setDefaultResultOrder("ipv4first");

import { config, voiceEnabled } from "./config";
import { prisma, tuneSqlite } from "./db";
import { buildApp } from "./app";
import { cache } from "./state/cache";
import { voice } from "./state/voice";
import { attachGateway } from "./gateway";
import { setIO } from "./gateway/io";
import { startJobs } from "./jobs";
import { loadInstanceSettings } from "./services/instance";
import { lockPublicDemoAccount } from "./services/admin";

async function main() {
  await tuneSqlite();
  await loadInstanceSettings();
  await cache.loadAll();

  const app = await buildApp();
  await lockPublicDemoAccount(app.log);
  await app.listen({ port: config.PORT, host: config.HOST });
  const io = attachGateway(app.server, app.log);
  const timers = startJobs(app.log);

  if (voiceEnabled()) {
    app.log.info(`voice: LiveKit at ${config.livekit.internalUrl} (clients: ${config.livekit.publicUrl || "same origin /rtc"})`);
    // Rebuild voice occupancy after a restart without waiting for the first tick.
    void voice.reconcile().catch(() => {});
  } else {
    app.log.warn("voice disabled: set LIVEKIT_API_KEY / LIVEKIT_API_SECRET");
  }
  app.log.info(`${config.SERVER_NAME} ${config.version} ready on :${config.PORT}`);

  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
    app.log.info(`${signal} — shutting down`);
    timers.forEach(clearInterval);
    const force = setTimeout(() => process.exit(1), 10_000);
    force.unref();
    try {
      io.close();
      setIO(null);
      await app.close();
      await prisma.$disconnect();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("unhandledRejection", (err) => app.log.error({ err }, "unhandled rejection"));
}

main().catch((err) => {
  console.error("Fatal boot error:", err);
  process.exit(1);
});
