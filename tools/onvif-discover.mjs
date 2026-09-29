#!/usr/bin/env node
/**
 * npm run discover:onvif — F4: descubrimiento ONVIF por WS-Discovery (UDP).
 *
 *   1. M-SEARCH Probe a 239.255.255.250:3702 desde cada interfaz IPv4
 *   2. por cada XAddr: GetDeviceInformation → GetCapabilities → GetProfiles
 *      → GetStreamUri (si la cámara da credenciales: --user/--pass)
 *   3. imprime IP, marca, modelo y la URL RTSP resultante
 *
 * Opciones:
 *   --timeout <ms>   cuánto se escucha la respuesta (def. 4000)
 *   --xaddr <url>    salta la búsqueda y habla con un endpoint concreto
 *   --user <u> --pass <p>   credenciales ONVIF (WS-Security UsernameToken)
 *   --json           salida en JSON
 *
 * Nota: cámaras "RTSP puro" (p. ej. la O-KAM de esta red) no responden: sólo
 * abren el puerto 10554. Aquí se buscan dispositivos ONVIF de verdad.
 */
import dgram from "node:dgram";
import os from "node:os";
import { createHash, randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";

const MULTICAST = "239.255.255.250";
const DISCOVERY_PORT = 3702;
const NAMESPACES = {
  s: "http://www.w3.org/2003/05/soap-envelope",
  tds: "http://www.onvif.org/ver10/device/wsdl",
  trt: "http://www.onvif.org/ver10/media/wsdl",
  tt: "http://www.onvif.org/ver10/schema",
  wsa: "http://www.w3.org/2005/08/addressing",
  wsse: "http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd",
  wsu: "http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd",
};

function probeMessage() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<e:Envelope xmlns:e="http://www.w3.org/2003/05/soap-envelope" xmlns:w="http://schemas.xmlsoap.org/ws/2004/08/addressing" xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery" xmlns:dn="http://www.onvif.org/ver10/network/wsdl">
  <e:Header>
    <w:MessageID>uuid:${cryptoUuid()}</w:MessageID>
    <w:To e:mustUnderstand="true">urn:schemas-xmlsoap-org:ws:2005:04:discovery</w:To>
    <w:Action e:mustUnderstand="true">http://schemas.xmlsoap.org/ws/2005/04/discovery/Probe</w:Action>
  </e:Header>
  <e:Body><d:Probe><d:Types>dn:NetworkVideoTransmitter</d:Types></d:Probe></e:Body>
</e:Envelope>`;
}

function cryptoUuid() {
  const b = randomBytes(16);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function xmlEscape(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Cabecera SOAP + WS-Addressing (+ WS-Security si hay credenciales). */
function soapEnvelope(action, bodyXml, credentials) {
  const security = credentials ? wsseSecurity(credentials) : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<s:Envelope xmlns:s="${NAMESPACES.s}" xmlns:tds="${NAMESPACES.tds}" xmlns:trt="${NAMESPACES.trt}" xmlns:tt="${NAMESPACES.tt}" xmlns:wsa="${NAMESPACES.wsa}">
  <s:Header>${security}<wsa:Action s:mustUnderstand="1">${xmlEscape(action)}</wsa:Action><wsa:To s:mustUnderstand="1">${xmlEscape(action)}Service</wsa:To><wsa:MessageID>urn:uuid:${cryptoUuid()}</wsa:MessageID></s:Header>
  <s:Body>${bodyXml}</s:Body>
</s:Envelope>`;
}

/** WS-Security UsernameToken con PasswordDigest (lo que pide ONVIF). */
function wsseSecurity({ user, pass }) {
  const created = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const nonce = randomBytes(16);
  const digest = createHash("sha1").update(Buffer.concat([nonce, Buffer.from(created, "utf8"), Buffer.from(pass, "utf8")])).digest("base64");
  return `<wsse:Security xmlns:wsse="${NAMESPACES.wsse}" xmlns:wsu="${NAMESPACES.wsu}"><wsse:UsernameToken><wsse:Username>${xmlEscape(user)}</wsse:Username><wsse:Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest">${digest}</wsse:Password><wsse:Nonce EncodingType="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary">${nonce.toString("base64")}</wsse:Nonce><wsu:Created>${created}</wsu:Created></wsse:UsernameToken></wsse:Security>`;
}

/** POST SOAP. Devuelve el XML o lanza con `status` para poder detectar 401. */
export async function soapPost(url, xml, { credentials, timeoutMs = 4000 } = {}) {
  const headers = { "content-type": "application/soap+xml; charset=utf-8" };
  if (credentials?.user && !credentials.digest) {
    headers.authorization = `Basic ${Buffer.from(`${credentials.user}:${credentials.pass ?? ""}`).toString("base64")}`;
  }
  const response = await fetch(url, { method: "POST", body: xml, headers, signal: AbortSignal.timeout(timeoutMs) });
  const text = await response.text();
  if (!response.ok) {
    const error = new Error(`HTTP ${response.status}`);
    error.status = response.status;
    error.body = text;
    throw error;
  }
  return text;
}

function tag(xml, name) {
  const match = new RegExp(`<(?:\\w+:)?${name}[^>]*>([^<]*)</(?:\\w+:)?${name}>`, "i").exec(xml);
  return match?.[1]?.trim() ?? null;
}

function attr(xml, name, attribute) {
  const match = new RegExp(`<${name}[^>]*\\s${attribute}="([^"]+)"`, "i").exec(xml);
  return match?.[1] ?? null;
}

/**
 * Habla con un endpoint ONVIF y devuelve {ip, manufacturer, model, firmware,
 * profiles, rtsp, authRequired, error}.
 */
export async function describeDevice(xaddr, { credentials, timeoutMs = 4000 } = {}) {
  const result = {
    xaddr,
    ip: ipFromUrl(xaddr),
    manufacturer: null,
    model: null,
    firmware: null,
    mediaXaddr: null,
    profiles: [],
    rtsp: null,
    authRequired: false,
    error: null,
  };

  try {
    const info = await soapPost(
      xaddr,
      soapEnvelope("http://www.onvif.org/ver10/device/wsdl/GetDeviceInformation", "<tds:GetDeviceInformation/>", credentials),
      { credentials, timeoutMs },
    );
    result.manufacturer = tag(info, "Manufacturer");
    result.model = tag(info, "Model");
    result.firmware = tag(info, "FirmwareVersion");
  } catch (error) {
    if (error.status === 401) {
      result.authRequired = true;
      result.error = "requiere credenciales (usa --user/--pass)";
      return result;
    }
    result.error = error.message;
    return result;
  }

  // GetCapabilities → dónde está el servicio de media (GetProfiles/GetStreamUri)
  try {
    const caps = await soapPost(
      xaddr,
      soapEnvelope("http://www.onvif.org/ver10/device/wsdl/GetCapabilities", '<tds:GetCapabilities><tds:Category>All</tds:Category></tds:GetCapabilities>', credentials),
      { credentials, timeoutMs },
    );
    const media = /<(?:\w+:)?Media\b[^>]*>[\s\S]*?<(?:\w+:)?XAddr>([^<]+)<\/(?:\w+:)?XAddr>/i.exec(caps);
    result.mediaXaddr = media?.[1]?.trim() || xaddr;
  } catch {
    result.mediaXaddr = xaddr; // muchas cámaras resuelven todo en device_service
  }

  const media = result.mediaXaddr;
  try {
    const profiles = await soapPost(
      media,
      soapEnvelope("http://www.onvif.org/ver10/media/wsdl/GetProfiles", "<trt:GetProfiles/>", credentials),
      { credentials, timeoutMs },
    );
    const tokens = [...profiles.matchAll(/<(?:\w+:)?Profiles\b[^>]*\stoken="([^"]+)"/gi)].map((m) => m[1]);
    result.profiles = tokens;

    if (tokens.length > 0) {
      const stream = await soapPost(
        media,
        soapEnvelope(
          "http://www.onvif.org/ver10/media/wsdl/GetStreamUri",
          `<trt:GetStreamUri><trt:StreamSetup><tt:Stream>RTP-Unicast</tt:Stream><tt:Transport><tt:Protocol>RTSP</tt:Protocol></tt:Transport></trt:StreamSetup><trt:ProfileToken>${xmlEscape(tokens[0])}</trt:ProfileToken></trt:GetStreamUri>`,
          credentials,
        ),
        { credentials, timeoutMs },
      );
      result.rtsp = tag(stream, "Uri");
    }
  } catch (error) {
    if (error.status === 401) {
      result.authRequired = true;
      result.error = "requiere credenciales (usa --user/--pass)";
    } else if (!result.error) {
      result.error = `media: ${error.message}`;
    }
  }

  return result;
}

function ipFromUrl(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

/** Escucha WS-Discovery durante `timeoutMs` y devuelve los XAddr encontrados. */
export async function discoverXAddrs(timeoutMs = 4000) {
  const interfaces = [];
  for (const [name, entries] of Object.entries(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal) interfaces.push({ name, address: entry.address });
    }
  }
  if (interfaces.length === 0) interfaces.push({ name: "default", address: "0.0.0.0" });

  const found = new Set();
  const sockets = [];
  const message = Buffer.from(probeMessage(), "utf8");

  await Promise.all(
    interfaces.map(
      (iface) =>
        new Promise((resolve) => {
          const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
          sockets.push(socket);
          socket.on("message", (msg, rinfo) => {
            const text = msg.toString("utf8");
            const match = /<a:XAddrs>([^<]+)<\/a:XAddrs>|<XAddrs>([^<]+)<\/XAddrs>/i.exec(text);
            const value = match?.[1] ?? match?.[2];
            if (!value) return;
            for (const xaddr of value.split(/\s+/)) {
              if (/^https?:\/\//i.test(xaddr)) found.add(xaddr);
            }
            void rinfo;
          });
          socket.on("error", () => resolve());
          socket.bind({ address: iface.address, port: 0 }, () => {
            try {
              socket.setMulticastTTL(4);
              socket.setMulticastLoopback(false);
              socket.addMembership(MULTICAST, iface.address);
            } catch {
              // algunas interfaces no permiten unirse al grupo: igual envía
            }
            socket.send(message, DISCOVERY_PORT, MULTICAST, () => resolve());
          });
        }),
    ),
  );

  await new Promise((resolve) => setTimeout(resolve, timeoutMs));
  for (const socket of sockets) {
    try {
      socket.close();
    } catch {
      // ya cerrado
    }
  }
  return [...found];
}

function parseArgs(argv) {
  const args = { timeout: 4000, xaddr: null, user: null, pass: null, json: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--timeout") args.timeout = Number(argv[++i]) || 4000;
    else if (arg === "--xaddr") args.xaddr = argv[++i];
    else if (arg === "--user") args.user = argv[++i];
    else if (arg === "--pass") args.pass = argv[++i];
    else if (arg === "--json") args.json = true;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const credentials = args.user ? { user: args.user, pass: args.pass ?? "" } : null;

  let xaddrs = [];
  if (args.xaddr) {
    xaddrs = [args.xaddr];
  } else {
    console.log(`🔍 WS-Discovery en ${MULTICAST}:${DISCOVERY_PORT} (${args.timeout} ms)…`);
    xaddrs = await discoverXAddrs(args.timeout);
  }

  if (xaddrs.length === 0) {
    console.log("\nNingún dispositivo ONVIF respondió.");
    console.log("  · cámaras \"RTSP puro\" (p. ej. la O-KAM) no hablan ONVIF: sólo abren 10554");
    console.log("  · prueba con más tiempo:  npm run discover:onvif -- --timeout 8000");
    console.log("  · o apunta directo:       npm run discover:onvif -- --xaddr http://<ip>:8000/onvif/device_service");
    process.exitCode = 1;
    return;
  }

  const devices = [];
  for (const xaddr of xaddrs) {
    process.stdout.write(`  → ${xaddr} … `);
    const device = await describeDevice(xaddr, { credentials });
    devices.push(device);
    console.log(device.error ? `✗ ${device.error}` : `✓ ${device.model ?? "?"}`);
  }

  if (args.json) {
    console.log(JSON.stringify(devices, null, 2));
    return;
  }

  console.log("\nIP             Marca        Modelo               Firmware     RTSP");
  console.log("─".repeat(96));
  for (const device of devices) {
    const row = [
      (device.ip ?? "?").padEnd(14),
      (device.manufacturer ?? "?").padEnd(12),
      (device.model ?? "?").slice(0, 20).padEnd(22),
      (device.firmware ?? "?").slice(0, 12).padEnd(14),
      device.rtsp ?? (device.authRequired ? "(credenciales)" : `(${device.error ?? "sin rtsp"})`),
    ];
    console.log(row.join(" "));
    if (device.rtsp) console.log(`  ${device.rtsp}`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error("Fallo:", error.message);
    process.exit(1);
  });
}
