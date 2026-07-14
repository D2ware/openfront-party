"use strict";

const extensionApi = globalThis.browser || globalThis.chrome;
const configuredRelay = "__RELAY_ORIGIN__";
const allowedOrigins = new Set([
  configuredRelay,
  "http://localhost:3030",
  "http://127.0.0.1:3030",
]);

async function relayRequest(request) {
  const url = new URL(request?.url || "");
  if (!allowedOrigins.has(url.origin) || !url.pathname.startsWith("/api/")) {
    throw new Error(`Relay origin is not allowed by this extension build: ${url.origin}`);
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.min(Math.max(Number(request.timeout) || 25_000, 1_000), 60_000));
  try {
    const response = await fetch(url.href, {
      method: request.method || "GET",
      headers: request.headers || {},
      body: request.data,
      signal: controller.signal,
      credentials: "omit",
      redirect: "error",
      cache: "no-store",
    });
    return { ok: true, status: response.status, responseText: await response.text() };
  } finally {
    clearTimeout(timeout);
  }
}

extensionApi.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "party.relayRequest") return false;
  const senderUrl = sender.url || sender.tab?.url || "";
  if (!senderUrl.startsWith("https://openfront.io/")) {
    sendResponse({ ok: false, error: "Relay requests are accepted only from openfront.io." });
    return false;
  }
  relayRequest(message.request)
    .then(sendResponse)
    .catch((error) => sendResponse({
      ok: false,
      error: error?.name === "AbortError" ? "Party relay request timed out." : (error?.message || "Party relay is unreachable."),
    }));
  return true;
});
