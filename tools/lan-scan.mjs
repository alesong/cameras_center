#!/usr/bin/env node
/**
 * Descubrimiento de cámaras IP en la red local.
 *
 *   npm run discover                          # barre 192.168.1.0/24 (IP por defecto)
 *   npm run discover -- --subnet 192.168.18.0/24
 *   npm run discover -- --ip 192.168.18.36
 *   npm run discover -- --ports 554,80,443,10554,8554
 *   npm run discover -- --subnet 192.168.18.0/24 --user admin --pass PASSWORD   # prueba RTSP con ffprobe
 *
 * Sin dependencias externas. Usa TCP (no ICMP) para detectar hosts.
 */

import net from "node:net";
import os from "node:os";
import { existsSync, readdirSync } from "node:fs";
import { join, delimiter } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const DEFAULT_PORTS = [80, 443, 554, 8554, 8080, 8000, 37777, 8899, 10554, 34567];
const CONNECT_TIMEOUT = 800;
const POOL = 250;

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const args = { subnet: null, ip: null, ports: DEFAULT_PORTS, user: null, pass: null, timeout: CONNECT_TIMEOUT };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--subnet") args.subnet = argv[++i];
    else if (a === "--ip") args.ip = argv[++i];
    else if (a === "--ports") args.ports = argv[++i].split(",").map(Number).filter(Boolean);
    else if (a === "--user") args.user = argv[++i];
    else if (a === "--pass") args.pass = argv[++i];
    else if (a === "--timeout") args.timeout = Number(argv[++i]) || CONNECT_TIMEOUT;
    else if (a === "--help" || a === "-h") {
      console.log("Uso: npm run discover -- [--subnet X.X.X.0/24 | --ip X.X.X.X] [--ports a,b,c] [--user u --pass p]");
      process.exit(0);
    }
  }
  return args;
}

/** Detecta la subred local por defecto a partir de la interfaz activa. */
function guessSubnet() {
  const skip = /vbox|vmware|vmnet|docker|veth|br-|tun|tap|wsl|hyper-v/i;
  const preferred = /^(en|eth|wl|wlan|wi-fi|ethernet|wi fi)/i;
  const candidates = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === "IPv4" && !a.internal) candidates.push({ name, address: a.address });
    }
  }
  const pick =
    candidates.find((c) => preferred.test(c.name) && !skip.test(c.name)) ??
    candidates.find((c) => !skip.test(c.name)) ??
    candidates[0];
  if (!pick) return "192.168.1.0/24";
  const parts = pick.address.split(".");
  return `${parts[0]}.${parts[1]}.${parts[2]}.0/24`;
}

function hostsOf(subnet, explicitIp) {
  if (explicitIp) return [explicitIp];
  const base = subnet.split("/")[0];
  const parts = base.split(".").map(Number);
  if (parts.length !== 4 || Number.isNaN(parts[3])) {
    throw new Error(`Subred inválida: ${subnet}`);
  }
  const list = [];
  for (let i = 1; i <= 254; i++) list.push(`${parts[0]}.${parts[1]}.${parts[2]}.${i}`);
  return list;
}

// ---------------------------------------------------------------------------
// Pool de conexiones
// ---------------------------------------------------------------------------
async function mapPool(items, concurrency, fn) {
  const results = [];
  let index = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    for (;;) {
      const i = index++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

function tryConnect(ip, port, timeout) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const done = (open) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(timeout);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
    socket.connect(port, ip);
  });
}

// ---------------------------------------------------------------------------
// Sondas de protocolo
// ---------------------------------------------------------------------------
// Algunas cámaras (O-KAM/EZVIZ) no contestan a `DESCRIBE /` pero sí a una ruta
// concreta, así que probamos varias hasta encontrar un servidor RTSP vivo.
const RTSP_PROBE_URIS = ["/tcp/av0_0", "/", "/live", "/Streaming/Channels/101", "/h264_preview_01"];

async function rtspRequest(ip, port, uri, timeout = 2500) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let buffer = "";
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeout);
    socket.on("connect", () => {
      // DESCRIBE en vez de OPTIONS: cámaras como la O-KAM ignoran OPTIONS y
      // cierran el socket, lo que daba el falso negativo "no habla RTSP".
      // Un 401 ya prueba que hay un servidor RTSP con Digest detrás.
      socket.write(`DESCRIBE rtsp://${ip}:${port}${uri} RTSP/1.0\r\nCSeq: 1\r\nAccept: application/sdp\r\n\r\n`);
    });
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      if (buffer.includes("RTSP/1.0")) done({ ok: true, banner: buffer.split("\r\n")[0] });
    });
    socket.on("timeout", () => done({ ok: false, banner: buffer.slice(0, 80) }));
    socket.on("error", () => done({ ok: false, banner: "" }));
    socket.on("close", () => done({ ok: buffer.includes("RTSP/1.0"), banner: buffer.split("\r\n")[0] ?? "" }));
    socket.connect(port, ip);
  });
}

async function probeRtsp(ip, port) {
  for (const uri of RTSP_PROBE_URIS) {
    const res = await rtspRequest(ip, port, uri);
    if (res.ok) return { ...res, uri };
  }
  return { ok: false, banner: "", uri: null };
}

async function probeHttp(ip, port, timeout = 3000) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let buffer = "";
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeout);
    socket.on("connect", () => socket.write(`GET / HTTP/1.1\r\nHost: ${ip}\r\nConnection: close\r\n\r\n`));
    socket.on("data", (c) => (buffer += c.toString("utf8")));
    socket.on("timeout", () => done(null));
    socket.on("error", () => done(null));
    socket.on("close", () => {
      if (!buffer.startsWith("HTTP/")) return done(null);
      const server = /Server:\s*([^\r\n]+)/i.exec(buffer)?.[1] ?? "-";
      const title = /<title[^>]*>(.*?)<\/title>/i.exec(buffer)?.[1] ?? "-";
      done({ server, title: title.trim().slice(0, 50) });
    });
    socket.connect(port, ip);
  });
}

function findFfprobe() {
  const bin = process.platform === "win32" ? "ffprobe.exe" : "ffprobe";
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, bin);
    if (existsSync(candidate)) return candidate;
  }
  if (process.platform === "win32") {
    // FFmpeg instalado por winget pero no añadido al PATH (caso de esta máquina)
    const packages = join(process.env.LOCALAPPDATA ?? "", "Microsoft", "WinGet", "Packages");
    try {
      for (const pkg of readdirSync(packages)) {
        if (!/ffmpeg/i.test(pkg)) continue;
        for (const sub of readdirSync(join(packages, pkg))) {
          const candidate = join(packages, pkg, sub, "bin", bin);
          if (existsSync(candidate)) return candidate;
        }
      }
    } catch {
      // no hay carpeta de winget: seguimos
    }
  }
  return null;
}

const FFPROBE = findFfprobe();

async function ffprobe(url) {
  if (!FFPROBE) return "ERROR: ffprobe no encontrado (instala FFmpeg o añádelo al PATH)";
  try {
    const { stdout } = await execFileAsync(
      FFPROBE,
      ["-v", "error", "-rtsp_transport", "tcp", "-i", url, "-show_entries", "stream=codec_name,width,height,avg_frame_rate", "-of", "csv=p=0"],
      { timeout: 15000 },
    );
    return stdout.trim().split("\n")[0] ?? "";
  } catch (error) {
    return `ERROR: ${(error.stderr ?? error.message ?? "").toString().split("\n")[0].slice(0, 120)}`;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
(async () => {
  const args = parseArgs(process.argv.slice(2));
  const subnet = args.ip ?? args.subnet ?? guessSubnet();
  const hosts = hostsOf(subnet, args.ip);

  console.log(`\n🔎 Barriendo ${hosts.length} host(s) en ${subnet}`);
  console.log(`   Puertos: ${args.ports.join(", ")}  (timeout ${args.timeout} ms)\n`);

  const started = Date.now();
  const found = [];

  await mapPool(hosts, POOL, async (ip) => {
    const open = [];
    await mapPool(args.ports, 8, async (port) => {
      if (await tryConnect(ip, port, args.timeout)) open.push(port);
    });
    if (open.length) found.push({ ip, open: open.sort((a, b) => a - b) });
  });

  console.log(`Barrida completada en ${((Date.now() - started) / 1000).toFixed(1)} s\n`);

  if (!found.length) {
    console.log("No se encontró ningún host con puertos abiertos.");
    console.log("Comprueba que estás en la misma subred que las cámaras y que el Wi-Fi no tiene aislamiento de clientes.\n");
    process.exit(0);
  }

  for (const host of found.sort((a, b) => ipToNum(a.ip) - ipToNum(b.ip))) {
    console.log(`${host.ip.padEnd(16)} puertos: ${host.open.join(", ")}`);

    const httpPort = host.open.includes(80) ? 80 : host.open.includes(443) ? 443 : host.open.includes(8080) ? 8080 : null;
    if (httpPort) {
      const info = await probeHttp(host.ip, httpPort);
      if (info) console.log(`${" ".repeat(16)}   HTTP ${httpPort}: Server=${info.server} Title=${info.title}`);
    }

    const rtspPorts = host.open.filter((p) => [554, 8554, 10554, 5540].includes(p));
    for (const port of rtspPorts) {
      const res = await probeRtsp(host.ip, port);
      console.log(
        `${" ".repeat(16)}   RTSP ${port}: ${res.ok ? `OK (${res.banner}) en ${res.uri}` : "no habla RTSP (probablemente deshabilitado)"}`,
      );
      if (res.ok && args.user) {
        const candidates = [
          res.uri, // primero la ruta que ya respondió
          `/tcp/av0_0`, // EZVIZ / O-KAM
          `/Streaming/Channels/101`,
          `/Streaming/Channels/102`,
          `/h264_preview_01`,
          `/live`,
          `/live/ch00_0`,
        ].filter((p, i, arr) => p && arr.indexOf(p) === i);
        for (const path of candidates) {
          const url = `rtsp://${args.user}:${args.pass ?? ""}@${host.ip}:${port}${path}`;
          const clean = url.replace(/:[^:@]*@/, ":***@");
          const result = await ffprobe(url);
          console.log(`${" ".repeat(16)}      ${clean.padEnd(62)} -> ${result}`);
        }
      }
    }
    console.log("");
  }

  console.log("Sugerencias de URL por marca:");
  console.log("  Hikvision / EZVIZ : rtsp://admin:<pass>@<ip>:554/Streaming/Channels/101");
  console.log("  EZVIZ (variantes) : rtsp://admin:<pass>@<ip>:554/h264_preview_01");
  console.log("  Genéricas ONVIF  : rtsp://<ip>:554/live   ·   ONVIF: http://<ip>/onvif/device_service\n");
})();

function ipToNum(ip) {
  return ip.split(".").reduce((acc, octet) => (acc << 8) + Number(octet), 0) >>> 0;
}
