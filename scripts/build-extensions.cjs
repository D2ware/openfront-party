const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const root = path.resolve(__dirname, "..");
const sourceDir = path.join(root, "extension");
const userscriptPath = path.join(root, "public", "openfront-party-companion.user.js");
const outputRoot = path.join(root, "dist");

function relayOrigin(value) {
  const url = new URL(value || "https://moss.nonekode.fi");
  if (!new Set(["http:", "https:"]).has(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Extension relay must be an HTTP(S) origin without credentials, path, query, or fragment.");
  }
  return url.origin;
}

function replaceFunction(source, name, replacement) {
  const start = source.indexOf(`  function ${name}(`);
  if (start === -1) throw new Error(`Unable to find ${name} in companion source.`);
  const opening = source.indexOf("{", start);
  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let index = opening; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") { quote = char; continue; }
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return `${source.slice(0, start)}${replacement}${source.slice(index + 1)}`;
    }
  }
  throw new Error(`Unable to parse ${name} in companion source.`);
}

function extensionContent(userscript) {
  const adapter = `

  const extensionApi = globalThis.browser || globalThis.chrome;
  const extensionValues = await extensionApi.storage.local.get(null);
  function GM_getValue(key, fallback) {
    return Object.hasOwn(extensionValues, key) ? extensionValues[key] : fallback;
  }
  function GM_setValue(key, value) {
    extensionValues[key] = value;
    void extensionApi.storage.local.set({ [key]: value });
  }
  function GM_deleteValue(key) {
    delete extensionValues[key];
    void extensionApi.storage.local.remove(key);
  }
  function GM_addStyle(css) {
    const style = document.createElement("style");
    style.textContent = css;
    (document.head || document.documentElement).append(style);
    return style;
  }
  function GM_xmlhttpRequest(details) {
    void extensionApi.runtime.sendMessage({
      type: "party.relayRequest",
      request: {
        method: details.method,
        url: details.url,
        timeout: details.timeout,
        headers: details.headers,
        data: details.data,
      },
    }).then((response) => {
      if (!response?.ok) throw new Error(response?.error || "Party relay is unreachable.");
      details.onload?.({ status: response.status, responseText: response.responseText });
    }).catch((error) => details.onerror?.(error));
  }`;

  const telemetryHook = `  function installTelemetryHooks() {
    const PAGE_SOURCE = "openfront-party-page-bridge-v1";
    window.addEventListener("message", (event) => {
      if (event.source !== window || event.data?.source !== PAGE_SOURCE) return;
      const message = event.data.payload;
      try {
        if (event.data.kind === "server") processServerMessage(message);
        else if (event.data.kind === "worker") processWorkerMessage(message);
        else if (event.data.kind === "winner") finalizeTelemetry(message.allPlayersStats, message.winner);
        else if (event.data.kind === "worker-outbound" && message?.type === "init") {
          const gameId = message.gameStartInfo?.gameID || gameRoute().gameId;
          beginTelemetry(gameId);
          telemetryClientId = message.clientID || telemetryClientId;
          telemetry.infiniteGold = Boolean(message.gameStartInfo?.config?.infiniteGold);
          telemetry.hostInfiniteGold = Boolean(message.gameStartInfo?.config?.hostCheats?.infiniteGold);
          saveTelemetry();
        } else if (event.data.kind === "worker-outbound" && message?.type === "turn") {
          processTurn(message.turn);
        }
      } catch {}
    });
    window.postMessage({ source: "openfront-party-extension-v1", type: "ready" }, location.origin);
  }`;

  let source = userscript
    .replace(/^\/\/ ==UserScript==[\s\S]*?\/\/ ==\/UserScript==\s*/, "")
    .replace("(() => {", "(async () => {")
    .replace('  "use strict";', `  "use strict";${adapter}`);
  source = replaceFunction(source, "installTelemetryHooks", telemetryHook);
  return source;
}

const crcTable = Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : (crc >>> 1);
  return crc >>> 0;
});

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date = new Date()) {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

function zipDirectory(directory, output) {
  const files = [];
  const walk = (current, prefix = "") => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path.join(current, entry.name), relative);
      else files.push({ name: relative, data: fs.readFileSync(path.join(current, entry.name)) });
    }
  };
  walk(directory);
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  const stamp = dosDateTime();
  for (const file of files) {
    const name = Buffer.from(file.name.replace(/\\/g, "/"));
    const compressed = zlib.deflateRawSync(file.data, { level: 9 });
    const crc = crc32(file.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(stamp.time, 10);
    local.writeUInt16LE(stamp.date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(file.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(stamp.time, 12);
    central.writeUInt16LE(stamp.date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(file.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    localParts.push(local, name, compressed);
    centralParts.push(central, name);
    offset += local.length + name.length + compressed.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  fs.writeFileSync(output, Buffer.concat([...localParts, centralDirectory, end]));
}

function manifest(version, relay, browser) {
  const common = {
    manifest_version: 3,
    name: "OpenFront Party Companion",
    version,
    description: "Keeps opt-in OpenFront parties together and records finalized match summaries.",
    permissions: ["storage"],
    host_permissions: ["https://openfront.io/*", `${relay}/*`, "http://localhost:3030/*", "http://127.0.0.1:3030/*"],
    content_scripts: [
      { matches: ["https://openfront.io/*"], js: ["page-bridge.js"], run_at: "document_start", all_frames: false, world: "MAIN" },
      { matches: ["https://openfront.io/*"], js: ["content.js"], run_at: "document_start", all_frames: false, world: "ISOLATED" },
    ],
  };
  if (browser === "chrome") {
    return { ...common, version_name: `${version} Chrome`, minimum_chrome_version: "111", background: { service_worker: "background.js" } };
  }
  return {
    ...common,
    background: { scripts: ["background.js"] },
    browser_specific_settings: {
      gecko: {
        id: "openfront-party@nonekode.fi",
        strict_min_version: "128.0",
        data_collection_permissions: { required: ["authenticationInfo", "websiteActivity"] },
      },
    },
  };
}

function buildExtensions(relayInput) {
  const relay = relayOrigin(relayInput || process.env.PARTY_RELAY_ORIGIN);
  const userscript = fs.readFileSync(userscriptPath, "utf8");
  const version = JSON.parse(fs.readFileSync(path.join(sourceDir, "version.json"), "utf8")).version;
  if (!/^\d+\.\d+\.\d+$/.test(version || "")) throw new Error("Extension version must use major.minor.patch format.");
  fs.rmSync(outputRoot, { recursive: true, force: true });
  fs.mkdirSync(outputRoot, { recursive: true });
  const content = extensionContent(userscript);
  const background = fs.readFileSync(path.join(sourceDir, "background.js"), "utf8").replace('"__RELAY_ORIGIN__"', JSON.stringify(relay));
  const bridge = fs.readFileSync(path.join(sourceDir, "page-bridge.js"));
  for (const browser of ["chrome", "firefox"]) {
    const output = path.join(outputRoot, browser);
    fs.mkdirSync(output, { recursive: true });
    fs.writeFileSync(path.join(output, "manifest.json"), `${JSON.stringify(manifest(version, relay, browser), null, 2)}\n`);
    fs.writeFileSync(path.join(output, "content.js"), content);
    fs.writeFileSync(path.join(output, "background.js"), background);
    fs.writeFileSync(path.join(output, "page-bridge.js"), bridge);
  }
  const chromePackage = path.join(outputRoot, `openfront-party-chrome-${version}.zip`);
  const firefoxPackage = path.join(outputRoot, `openfront-party-firefox-${version}.xpi`);
  zipDirectory(path.join(outputRoot, "chrome"), chromePackage);
  zipDirectory(path.join(outputRoot, "firefox"), firefoxPackage);
  fs.copyFileSync(chromePackage, path.join(outputRoot, "openfront-party-chrome.zip"));
  fs.copyFileSync(firefoxPackage, path.join(outputRoot, "openfront-party-firefox.xpi"));
  console.log(`Chrome extension: ${chromePackage}`);
  console.log(`Firefox extension: ${firefoxPackage}`);
  return { version, relay, chromePackage, firefoxPackage };
}

if (require.main === module) buildExtensions(process.argv[2]);

module.exports = { buildExtensions };
