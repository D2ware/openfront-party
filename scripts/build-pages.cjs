const fs = require("node:fs");
const path = require("node:path");

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

const relay = relayOrigin(relayInput);
fs.rmSync(output, { recursive: true, force: true });
fs.mkdirSync(output, { recursive: true });
fs.cpSync(path.join(root, "viewer"), path.join(output, "viewer"), {
  recursive: true,
  filter: (source) => path.basename(source) !== ".git",
});
fs.copyFileSync(
  path.join(root, "public", "openfront-party-companion.user.js"),
  path.join(output, "openfront-party-companion.user.js"),
);

fs.writeFileSync(path.join(output, ".nojekyll"), "");
fs.writeFileSync(
  path.join(output, "viewer", "config.js"),
  `window.OPENFRONT_PARTY_CONFIG = Object.freeze(${JSON.stringify({
    relayOrigin: relay,
    userscriptPath: "../openfront-party-companion.user.js",
  }, null, 2)});\n`,
);
fs.writeFileSync(
  path.join(output, "index.html"),
  `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <meta http-equiv="refresh" content="0; url=./viewer/">
    <title>OpenFront Party Coordinator</title>
    <script>location.replace(new URL("./viewer/", location.href));</script>
  </head>
  <body><a href="./viewer/">Open the lobby board</a></body>
</html>
`,
);

console.log(`GitHub Pages artifact created in ${output}`);
console.log(`Party relay: ${relay}`);
