const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const root = path.resolve(__dirname, "..");
const output = path.join(root, "_site");
const relayInput = process.argv[2] || process.env.PARTY_RELAY_ORIGIN || "";

function relayOrigin(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Set PARTY_RELAY_ORIGIN to the public HTTPS relay origin before building GitHub Pages.");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("PARTY_RELAY_ORIGIN must be an HTTPS origin without credentials, path, query, or fragment.");
  }
  return url.origin;
}

function versionAssets(directory, assets) {
  const digest = crypto.createHash("sha256");
  for (const asset of assets) digest.update(fs.readFileSync(path.join(directory, asset)));
  const version = digest.digest("hex").slice(0, 12);
  const htmlPath = path.join(directory, "index.html");
  let html = fs.readFileSync(htmlPath, "utf8");
  for (const asset of assets) {
    html = html.replace(`href="${asset}"`, `href="${asset}?v=${version}"`)
      .replace(`src="${asset}"`, `src="${asset}?v=${version}"`);
  }
  fs.writeFileSync(htmlPath, html);
  return version;
}

const relay = relayOrigin(relayInput);
fs.rmSync(output, { recursive: true, force: true });
fs.mkdirSync(output, { recursive: true });
for (const directory of ["viewer", "history"]) {
  fs.cpSync(path.join(root, directory), path.join(output, directory), {
    recursive: true,
    filter: (source) => path.basename(source) !== ".git",
  });
}

const userscriptSource = fs.readFileSync(path.join(root, "public", "openfront-party-companion.user.js"), "utf8");
const userscript = userscriptSource.replace(
  /const DEFAULT_RELAY = "[^"]+";/,
  `const DEFAULT_RELAY = ${JSON.stringify(relay)};`,
);
fs.writeFileSync(path.join(output, "openfront-party-companion.user.js"), userscript);
fs.writeFileSync(path.join(output, ".nojekyll"), "");

fs.writeFileSync(
  path.join(output, "viewer", "config.js"),
  `window.OPENFRONT_PARTY_CONFIG = Object.freeze(${JSON.stringify({
    relayOrigin: relay,
    userscriptPath: "../openfront-party-companion.user.js",
    historyPath: "../history/",
  }, null, 2)});\n`,
);
fs.writeFileSync(
  path.join(output, "history", "config.js"),
  `window.OPENFRONT_TRACKER_CONFIG = Object.freeze(${JSON.stringify({
    relayOrigin: relay,
    userscriptPath: "../openfront-party-companion.user.js",
  }, null, 2)});\n`,
);

const viewerVersion = versionAssets(path.join(output, "viewer"), ["styles.css", "config.js", "party.js"]);
const historyVersion = versionAssets(path.join(output, "history"), ["styles.css", "config.js", "app.js"]);

fs.writeFileSync(
  path.join(output, "index.html"),
  `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <meta http-equiv="refresh" content="0; url=./history/">
    <title>OpenFront Tracker</title>
    <script>location.replace(new URL("./history/", location.href));</script>
  </head>
  <body><a href="./history/">Open the match tracker</a></body>
</html>
`,
);

console.log(`GitHub Pages artifact created in ${output}`);
console.log(`Tracker relay: ${relay}`);
console.log(`Asset versions: viewer ${viewerVersion}, history ${historyVersion}`);
