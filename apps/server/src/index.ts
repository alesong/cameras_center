import http from "node:http";
import express from "express";
import cors from "cors";
import { API } from "@cameras/protocol";
import { config } from "./config";
import { seedDemo } from "./store";
import { healthRouter } from "./routes/health";
import { camerasRouter } from "./routes/cameras";
import { agentRouter } from "./routes/agent";
import { createGateway } from "./ws/gateway";

const app = express();

app.use(cors({ origin: config.corsOrigin, credentials: true }));
app.use(express.json({ limit: "1mb" }));

app.use(healthRouter);
app.use(API.cameras, camerasRouter);
app.use("/api/agent", agentRouter);

// 404 JSON (evita que un 404 en HTML rompa a los clientes de API)
app.use((req, res) => {
  res.status(404).json({ error: "Ruta no encontrada", path: req.path });
});

app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error("[server] error no controlado:", err);
  res.status(500).json({ error: "Error interno del servidor" });
});

const httpServer = http.createServer(app);
const gateway = createGateway(httpServer);

// F3: el server pedirá al agent que arranque/pare streams según espectadores.
gateway.onStreamRequest(({ cameraId, profile }) => {
  console.log(`[gateway] solicitar stream -> ${cameraId} (${profile})`);
});
gateway.onStreamRelease((cameraId) => {
  console.log(`[gateway] sin espectadores -> parar ${cameraId}`);
});

seedDemo();

httpServer.listen(config.port, () => {
  console.log(`\n  🖥  server   http://localhost:${config.port}`);
  console.log(`     health   http://localhost:${config.port}${API.health}`);
  console.log(`     api      http://localhost:${config.port}${API.cameras}`);
  console.log(`     ws       origin=${config.corsOrigin}\n`);
});
