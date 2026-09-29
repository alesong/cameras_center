#!/usr/bin/env node
/**
 * npm run test:onvif — F4: auto-test de la sonda ONVIF contra un mock.
 *
 * Levanta un servidor SOAP local que se hace pasar por una cámara ONVIF y
 * comprueba que `describeDevice` hace bien las 4 llamadas (GetDeviceInformation,
 * GetCapabilities, GetProfiles, GetStreamUri), que parsea la URL RTSP y que
 * maneja el 401 con credenciales.
 */
import http from "node:http";
import { describeDevice } from "./onvif-discover.mjs";

const results = [];
let failures = 0;
const check = (ok, label) => {
  results.push(`${ok ? "OK  " : "FAIL"} ${label}`);
  if (!ok) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const seen = { deviceInfo: 0, capabilities: 0, profiles: 0, streamUri: 0, wsse: 0, basic: 0 };

function envelope(inner, xmlns = "http://www.onvif.org/ver10/device/wsdl") {
  return `<?xml version="1.0" encoding="UTF-8"?>
<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:tt="http://www.onvif.org/ver10/schema" xmlns:tds="${xmlns}">
<s:Body>${inner}</s:Body></s:Envelope>`;
}

function handler() {
  return (req, res) => {
    const port = serverPort;
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const secure = req.url.includes("/secure");
      if (secure) {
        const expected = `Basic ${Buffer.from("admin:secreto").toString("base64")}`;
        if (req.headers.authorization !== expected) {
          res.statusCode = 401;
          res.setHeader("www-authenticate", 'Basic realm="onvif"');
          res.end("unauthorized");
          return;
        }
        seen.basic++;
      }

      if (body.includes("wsse:Security")) seen.wsse++;

      res.setHeader("content-type", "application/soap+xml; charset=utf-8");
      if (body.includes("GetDeviceInformation")) {
        seen.deviceInfo++;
        res.end(
          envelope(
            `<tds:GetDeviceInformationResponse><tds:Manufacturer>AcmeVision</tds:Manufacturer><tds:Model>IPC-4K-TEST</tds:Model><tds:FirmwareVersion>5.6.8</tds:FirmwareVersion><tds:SerialNumber>SN001</tds:SerialNumber></tds:GetDeviceInformationResponse>`,
          ),
        );
      } else if (body.includes("GetCapabilities")) {
        seen.capabilities++;
        res.end(
          envelope(
            `<tds:GetCapabilitiesResponse><tds:Capabilities><tt:Device><tt:XAddr>http://127.0.0.1:${port}/onvif/device_service</tt:XAddr></tt:Device><tt:Media><tt:XAddr>http://127.0.0.1:${port}/onvif/media_service</tt:XAddr></tt:Media></tds:Capabilities></tds:GetCapabilitiesResponse>`,
          ),
        );
      } else if (body.includes("GetProfiles")) {
        seen.profiles++;
        res.end(
          envelope(
            `<trt:GetProfilesResponse xmlns:trt="http://www.onvif.org/ver10/media/wsdl"><trt:Profiles token="profile_0" fixed="true"><tt:Name>MainStream</tt:Name></trt:Profiles><trt:Profiles token="profile_1"><tt:Name>SubStream</tt:Name></trt:Profiles></trt:GetProfilesResponse>`,
          ),
        );
      } else if (body.includes("GetStreamUri")) {
        seen.streamUri++;
        res.end(
          envelope(
            `<trt:GetStreamUriResponse xmlns:trt="http://www.onvif.org/ver10/media/wsdl"><trt:MediaUri><tt:Uri>rtsp://192.168.18.99:554/Streaming/Channels/101</tt:Uri></trt:MediaUri></trt:GetStreamUriResponse>`,
          ),
        );
      } else {
        res.statusCode = 400;
        res.end("accion desconocida");
      }
    });
  };
}

let serverPort = 0;
const server = http.createServer(handler());
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
serverPort = server.address().port;
const port = serverPort;
const base = `http://127.0.0.1:${port}/onvif/device_service`;

// --- 1. flujo completo sin credenciales ------------------------------------
const device = await describeDevice(base, { timeoutMs: 3000 });
check(device.manufacturer === "AcmeVision", `marca parseada (${device.manufacturer})`);
check(device.model === "IPC-4K-TEST", `modelo parseado (${device.model})`);
check(device.firmware === "5.6.8", `firmware parseado (${device.firmware})`);
check(device.ip === "127.0.0.1", `ip del endpoint (${device.ip})`);
check(seen.deviceInfo === 1, `GetDeviceInformation enviado (${seen.deviceInfo})`);
check(seen.capabilities === 1, `GetCapabilities enviado (${seen.capabilities})`);
check(device.mediaXaddr?.includes("/onvif/media_service"), `media XAddr resuelto (${device.mediaXaddr})`);
check(seen.profiles === 1, `GetProfiles enviado al servicio de media (${seen.profiles})`);
check(device.profiles.length === 2, `2 perfiles ONVIF (${device.profiles.join(", ")})`);
check(seen.streamUri === 1, `GetStreamUri enviado (${seen.streamUri})`);
check(device.rtsp === "rtsp://192.168.18.99:554/Streaming/Channels/101", `URL RTSP extraída (${device.rtsp})`);
check(device.error === null, `sin errores (${device.error ?? "nulo"})`);

// --- 2. endpoint protegido: 401 detectado -----------------------------------
const secure = await describeDevice(`http://127.0.0.1:${port}/onvif/secure`, { timeoutMs: 3000 });
check(secure.authRequired === true, "401 → authRequired=true");
check(/credenciales/.test(secure.error ?? ""), `mensaje accionable (${secure.error})`);

// --- 3. con credenciales: WS-Security + Basic --------------------------------
const beforeWsse = seen.wsse;
const beforeBasic = seen.basic;
const authed = await describeDevice(`http://127.0.0.1:${port}/onvif/secure`, {
  credentials: { user: "admin", pass: "secreto" },
  timeoutMs: 3000,
});
check(authed.model === "IPC-4K-TEST", `con credenciales la llamada sale (${authed.model})`);
check(seen.wsse > beforeWsse, `cabecera WS-Security UsernameToken enviada (${seen.wsse - beforeWsse} peticiones)`);
check(seen.basic > beforeBasic, `Basic HTTP enviado (${seen.basic - beforeBasic} peticiones)`);

// --- 4. endpoint caído -------------------------------------------------------
const dead = await describeDevice("http://127.0.0.1:1/onvif/device_service", { timeoutMs: 1500 });
check(Boolean(dead.error) && dead.model === null, `endpoint caído reporta error (${dead.error})`);

server.close();
await sleep(50);

console.log(results.join("\n"));
console.log(failures === 0 ? "\nONVIF SELFTEST OK" : `\n${failures} FALLOS`);
process.exit(failures === 0 ? 0 : 1);
