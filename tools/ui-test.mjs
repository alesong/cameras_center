#!/usr/bin/env node
/**
 * npm run test:ui — pruebas de la INTERFAZ con Chrome headless (Playwright).
 *
 * Lo que los tests de API no pueden ver:
 *   1. pantalla de login y carga del panel de cámaras con JWT
 *   2. tarjeta de cámara: miniatura/poster y el conmutador 📡 LAN / 🌐 Servidor
 *   3. 📸 Capturar abre la imagen (Cloudinary o snapshot del agent)
 *   4. panel 🔑 API keys: crear → la clave se ve UNA vez → aparece en la
 *      lista → revocar (confirm) → queda como "revocada"
 *   5. panel Estado: API keys, límites y enlace a /api/docs
 *   6. /api/docs carga a través del proxy de Vite
 *   7. sin errores sin capturar en la consola
 *
 * Requiere: `npm run dev` (server + agent + web) y Chrome instalado.
 * Capturas: artifacts/ui/*.png (gitignored).
 */
import { chromium } from "playwright-core";
import { readFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const envText = readFileSync(resolve(root, ".env"), "utf8");
const val = (n) => (envText.match(new RegExp(`^${n}=(.*)$`, "m")) ?? [])[1]?.trim() ?? "";
const email = process.env.TEST_EMAIL || val("TEST_EMAIL");
const password = process.env.TEST_PASSWORD || val("TEST_PASSWORD");
const WEB = process.env.WEB_URL || "http://localhost:5173";
const OUT = resolve(root, "artifacts/ui");
mkdirSync(OUT, { recursive: true });

const results = [];
let failures = 0;
const check = (ok, label, extra = "") => {
  results.push(`${ok ? "OK  " : "FAIL"} ${label}${extra ? ` — ${extra}` : ""}`);
  if (!ok) failures++;
};
const info = (label) => results.push(`INFO  ${label}`);
const shot = (page, name) => page.screenshot({ path: join(OUT, name), fullPage: true });

if (!email || !password) {
  console.error("Faltan TEST_EMAIL y TEST_PASSWORD en .env");
  process.exit(2);
}

/** Chrome del sistema; si no, el chromium descargado por Playwright/Puppeteer. */
async function launchBrowser() {
  try {
    return await chromium.launch({ channel: "chrome", headless: true });
  } catch (error) {
    info(`Chrome del sistema no disponible (${String(error).split("\n")[0]}): usando chromium local`);
  }
  const candidates = [
    ...globDirs(resolve(process.env.LOCALAPPDATA ?? "", "ms-playwright"), /^chromium-/).map((d) => join(d, "chrome-win", "chrome.exe")),
    ...globDirs(resolve(process.env.USERPROFILE ?? "", ".cache", "puppeteer", "chrome"), /^win/).map((d) => join(d, "chrome-win64", "chrome.exe")),
  ];
  for (const executablePath of candidates) {
    if (!existsSync(executablePath)) continue;
    return chromium.launch({ executablePath, headless: true });
  }
  throw new Error("No se encontró ningún navegador (Chrome ni chromium de Playwright)");
}

function globDirs(base, match) {
  if (!existsSync(base)) return [];
  return readdirSync(base, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && match.test(entry.name))
    .map((entry) => join(base, entry.name));
}

const browser = await launchBrowser();
info(`navegador ${browser.version()}`);

const context = await browser.newContext({
  viewport: { width: 1400, height: 1000 },
  permissions: ["clipboard-read", "clipboard-write"],
});
const page = await context.newPage();

const pageErrors = [];
const consoleErrors = [];
const failedResponses = [];
page.on("pageerror", (error) => pageErrors.push(String(error)));
page.on("console", (message) => {
  if (message.type() === "error") consoleErrors.push(message.text());
});
page.on("response", (response) => {
  if (response.status() >= 400) failedResponses.push(`${response.status()} ${response.url()}`);
});
page.on("dialog", (dialog) => dialog.accept());

try {
  // --- 1. login ---------------------------------------------------------------
  await page.goto(WEB, { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: /Iniciar sesión|Crear usuario/ }).waitFor({ timeout: 15000 });
  check(true, "pantalla de login");

  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Contraseña").fill(password);
  await page.getByRole("button", { name: "Entrar" }).click();
  await page.getByText("Añadir cámara").waitFor({ timeout: 20000 });
  check(true, "login → panel de cámaras");

  // el health se refresca cada 15 s: darle tiempo a pintar
  await page
    .waitForFunction(() => /server v\d+/.test(document.querySelector(".server-pill")?.textContent ?? ""), null, {
      timeout: 20000,
    })
    .catch(() => {});
  const pill = await page.locator(".server-pill").first().innerText().catch(() => "");
  check(/server v\d+/.test(pill), "cabecera con estado del server", pill.replace(/\s+/g, " ").trim());

  // --- 2. tarjeta de cámara ---------------------------------------------------
  const cards = page.locator("article");
  await cards.first().waitFor({ timeout: 15000 });
  const cardCount = await cards.count();
  check(cardCount >= 1, `tarjetas de cámara en la rejilla (${cardCount})`);

  const img = page.locator("article img").first();
  const imgVisible = await img.isVisible().catch(() => false);
  const imgSrc = imgVisible ? await img.getAttribute("src", { timeout: 5000 }).catch(() => "") : "";
  check(imgVisible, "la tarjeta muestra una imagen", (imgSrc ?? "").slice(0, 90));
  info(`poster = ${(imgSrc ?? "(sin imagen)").slice(0, 120)}`);

  const sourceBtn = page.getByRole("button", { name: /📡 LAN|🌐 Servidor/ }).first();
  const sourceBefore = (await sourceBtn.innerText().catch(() => "")).trim();
  check(sourceBefore.length > 0, "conmutador de origen visible", sourceBefore);

  if (sourceBefore.includes("LAN")) {
    await sourceBtn.click();
    const sourceAfter = (await sourceBtn.innerText().catch(() => "")).trim();
    check(sourceAfter.includes("Servidor"), "📡 LAN → 🌐 Servidor (relay por WS)", sourceAfter);
    await page.waitForTimeout(2500);
    const relaySrc = await page.locator("article img").first().getAttribute("src").catch(() => "");
    info(`poster en relay = ${(relaySrc ?? "").slice(0, 140)}`);
    await sourceBtn.click();
    const restored = (await sourceBtn.innerText().catch(() => "")).trim();
    check(restored.includes("LAN"), "vuelta a 📡 LAN", restored);
  } else {
    info("la tarjeta arranca en relay: se omite el conmutador LAN");
  }

  await shot(page, "01-dashboard.png");

  // --- 3. 📸 Capturar ----------------------------------------------------------
  const captureBtn = page.getByRole("button", { name: "📸 Capturar" }).first();
  check(await captureBtn.isVisible().catch(() => false), "botón 📸 Capturar presente");

  // Se instrumenta window.open: con `noopener` algunos navegadores abren la
  // ventana sin que el evento `popup` se atribuya a esta página.
  await page.evaluate(() => {
    window.__opened = [];
    const original = window.open;
    window.open = (...args) => {
      window.__opened.push(String(args[0]));
      return original(...args);
    };
  });
  const captureResponses = [];
  const onResponse = (response) => {
    if (response.url().includes("/thumbnail")) captureResponses.push(`${response.status()} ${response.url()}`);
  };
  page.on("response", onResponse);

  await captureBtn.click();
  await page.waitForTimeout(8000);
  page.off("response", onResponse);

  const opened = await page.evaluate(() => window.__opened ?? []);
  info(`POST /thumbnail → ${captureResponses.join(" | ") || "(sin respuesta registrada)"}`);
  check(
    captureResponses.some((entry) => entry.startsWith("200 ")),
    "el botón pide la miniatura al server y recibe 200",
    captureResponses.join(" | "),
  );
  const captureUrl = opened[0] ?? "";
  check(captureUrl.length > 0, "📸 Capturar abre una ventana", captureUrl.slice(0, 130));
  check(
    /res\.cloudinary\.com|localhost:4100\/snapshot/.test(captureUrl),
    "…y la imagen es de Cloudinary o del snapshot del agent",
    captureUrl.slice(0, 130),
  );
  const banner = await page.locator(".error-banner").first().innerText().catch(() => "");
  if (banner) info(`aviso mostrado: ${banner.slice(0, 140)}`);

  // --- 4. panel de API keys ----------------------------------------------------
  const panel = page.locator("details.keys-panel");
  check(await panel.count() === 1, "panel «API keys para terceros» presente");
  await panel.locator("summary").click();
  await page.getByPlaceholder("mi-app / domótica / …").waitFor({ timeout: 10000 });
  check(true, "el panel se despliega y muestra el formulario");

  const label = `ui-${Date.now().toString(36)}`;
  await page.getByPlaceholder("mi-app / domótica / …").fill(label);
  const scopes = await page.locator("fieldset.scopes input:checked").count();
  check(scopes === 2, `scopes marcados por defecto (${scopes}/2)`);

  await page.getByRole("button", { name: "Crear API key" }).click();
  const freshCode = page.locator(".fresh-key code");
  await freshCode.waitFor({ timeout: 15000 });
  const freshKey = (await freshCode.innerText()).trim();
  check(/^cc_live_[0-9a-f]{40}$/.test(freshKey), "la clave recién creada se muestra", `${freshKey.slice(0, 15)}…`);
  check(
    (await page.locator(".fresh-key").innerText()).includes("una sola vez"),
    "avisa de que se muestra una sola vez",
  );
  await shot(page, "02-apikey-creada.png");

  const row = page.locator(".keys-table tbody tr", { hasText: label });
  check((await row.count()) === 1, "la clave aparece en la tabla", `${await page.locator(".keys-table tbody tr").count()} filas`);
  check(!(await page.locator(".keys-table").innerText()).includes(freshKey), "la tabla NO repite la clave en claro");

  // copiar al portapapeles
  let clipboard = "";
  try {
    await page.getByRole("button", { name: "Copiar" }).click();
    clipboard = await page.evaluate(() => navigator.clipboard.readText());
  } catch (error) {
    clipboard = `(no disponible) ${String(error).split("\n")[0]}`;
  }
  check(clipboard === freshKey, "el botón Copiar lleva la clave al portapapeles", clipboard.slice(0, 40));
  await page.getByRole("button", { name: "Entendido" }).click();

  await row.getByRole("button", { name: "Revocar" }).click();
  await page.getByText("revocada").first().waitFor({ timeout: 15000 });
  check(true, "revocada tras confirmar → queda como «revocada»");
  await shot(page, "03-apikey-revocada.png");

  // --- 5. panel Estado ---------------------------------------------------------
  const estado = page.locator(".card-panel.hint").last();
  const estadoText = await estado.innerText();
  check(/API keys:/.test(estadoText), "Estado muestra las API keys");
  check(/Límites:/.test(estadoText), "Estado muestra los límites de peticiones");
  check(/\/api\/docs/.test(estadoText), "Estado enlaza a la documentación");
  info(`Estado → ${estadoText.replace(/\s+/g, " ").slice(0, 260)}`);

  // --- 6. /api/docs en una pestaña nueva ---------------------------------------
  const docsLink = page.locator('a[href="/api/docs"]').last();
  const [docsPage] = await Promise.all([context.waitForEvent("page", { timeout: 20000 }), docsLink.click()]);
  await docsPage.waitForLoadState("domcontentloaded", { timeout: 20000 });
  await docsPage.getByRole("heading", { name: "Cameras Center · API" }).waitFor({ timeout: 15000 }).catch(() => {});
  const docsTitle = await docsPage.title();
  const docsBody = await docsPage.locator("body").innerText();
  check(docsTitle.includes("Cameras Center"), "la pestaña de docs carga desde la UI", docsTitle);
  check(/Endpoints|stream\.mjpg/.test(docsBody), "la página de docs lista los endpoints");
  check(/viewer:subscribe/.test(docsBody), "documenta el WebSocket");
  check((await docsPage.locator('a[href="/api/openapi.json"]').count()) >= 1, "enlaza el openapi.json");
  const openapiOk = await docsPage
    .request.get(`${WEB}/api/openapi.json`)
    .then((r) => r.ok())
    .catch(() => false);
  check(openapiOk, "el openapi.json enlazado responde 200");
  await docsPage.screenshot({ path: join(OUT, "04-docs.png"), fullPage: false });
  await docsPage.close();

  // --- 7. consola ---------------------------------------------------------------
  check(pageErrors.length === 0, `sin errores sin capturar (${pageErrors.length})`, pageErrors[0] ?? "");
  const realFailures = failedResponses.filter((entry) => !/favicon/.test(entry));
  if (realFailures.length > 0) info(`peticiones fallidas: ${realFailures.slice(0, 5).join(" | ")}`);
  if (consoleErrors.length > 0) info(`errores de consola: ${consoleErrors.slice(0, 3).map((e) => e.slice(0, 120)).join(" | ")}`);
} catch (error) {
  check(false, "el flujo de UI se interrumpió", String(error).split("\n")[0]);
  await shot(page, "99-error.png").catch(() => {});
}

await browser.close();

console.log(results.join("\n"));
console.log(`\ncapturas en ${OUT}`);
console.log(failures === 0 ? "\nUI OK" : `\n${failures} FALLOS`);
process.exit(failures === 0 ? 0 : 1);
