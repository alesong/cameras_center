import { config } from "./config";
import { checkFfmpeg, ensureDataDir } from "./pipeline/ffmpeg";
import { PipelineRegistry, type AgentCamera } from "./pipeline/registry";
import { createStreamServer } from "./local/streamServer";
import { connectToServer } from "./transport/server";

const registry = new PipelineRegistry();

/** Descarga la lista de cámaras (con conexión) desde el server. */
async function syncCameras(): Promise<boolean> {
  try {
    const response = await fetch(`${config.serverUrl}/api/agent/cameras`, {
      headers: config.agentTokenOut ? { "x-agent-token": config.agentTokenOut } : {},
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      console.warn(`[agent] sync rechazado: HTTP ${response.status}`);
      return false;
    }
    const data = (await response.json()) as { cameras: AgentCamera[] };
    registry.sync(data.cameras ?? []);
    return true;
  } catch (error) {
    console.warn(`[agent] sync falló: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

async function main() {
  console.log(`
  📹  cameras-center agent
      id      ${config.agentId}
      server  ${config.serverUrl}
      stream  http://localhost:${config.streamPort}
      data    ${ensureDataDir()}
`);

  const ffmpeg = await checkFfmpeg();
  if (ffmpeg.ok) {
    console.log(`  ✅ FFmpeg: ${ffmpeg.version}`);
    console.log(`     ${ffmpeg.path}\n`);
  } else {
    console.warn(`  ⚠️  ${ffmpeg.error}`);
    console.warn("     Instálalo o define FFMPEG_PATH en .env\n");
  }

  await syncCameras();

  const transport = connectToServer(() => ({
    agentId: config.agentId,
    version: config.version,
    cameras: registry.listCameras(),
    capabilities: ["rtsp", "mjpeg", "test"],
  }));

  // --- Servidor de streams local (visión en LAN) ---
  const streamServer = createStreamServer(registry, config.streamPort);
  streamServer.listen(config.streamPort, () => {
    console.log(`  🎞  stream   http://localhost:${config.streamPort}/stream/:id.mjpg\n`);
  });

  // --- Bucles de mantenimiento ---
  const syncTimer = setInterval(() => void syncCameras(), config.syncIntervalMs);
  const statusTimer = setInterval(() => {
    for (const pipeline of registry.all()) {
      transport.emitStatus(pipeline.reportStatus());
    }
  }, 10000);

  const shutdown = () => {
    console.log("\n[agent] apagando...");
    clearInterval(syncTimer);
    clearInterval(statusTimer);
    registry.stopAll();
    streamServer.close();
    transport.socket.disconnect();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error) => {
  console.error("[agent] error fatal:", error);
  process.exit(1);
});
