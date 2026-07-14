const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const root = path.resolve(__dirname, "..");

test("GitHub Pages build is subpath-safe and excludes nested repository metadata", () => {
  const result = spawnSync(process.execPath, ["scripts/build-pages.cjs", "https://relay.example.com"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);

  const output = path.join(root, "_site");
  const viewerHtml = fs.readFileSync(path.join(output, "viewer", "index.html"), "utf8");
  const config = fs.readFileSync(path.join(output, "viewer", "config.js"), "utf8");
  const partyClient = fs.readFileSync(path.join(output, "viewer", "party.js"), "utf8");
  const companion = fs.readFileSync(path.join(output, "openfront-party-companion.user.js"), "utf8");
  const rootHtml = fs.readFileSync(path.join(output, "index.html"), "utf8");

  assert.match(config, /https:\/\/relay\.example\.com/);
  assert.match(viewerHtml, /id="partyReadyToggle"/);
  assert.match(viewerHtml, /id="partyReadyStatus"/);
  assert.match(viewerHtml, /id="partyLaunchNotice"/);
  assert.match(viewerHtml, /id="partyOpenLaunch"/);
  assert.match(viewerHtml, /href="styles\.css\?v=[a-f0-9]{12}"/);
  assert.match(viewerHtml, /src="config\.js\?v=[a-f0-9]{12}"/);
  assert.match(viewerHtml, /src="party\.js\?v=[a-f0-9]{12}"/);
  assert.match(partyClient, /send\("member\.state", \{ state: next \}\)/);
  assert.match(partyClient, /You will be included in the next launch/);
  assert.doesNotMatch(partyClient, /tabReady.*prepareOpenFrontWindow/);
  assert.match(partyClient, /windowState\.tone !== "stable"/);
  assert.match(partyClient, /You were not Ready and were left behind/);
  assert.match(partyClient, /viewerConnected \|\| member\.companionConnected/);
  assert.doesNotMatch(partyClient, /Needs companion/);
  assert.match(partyClient, /openfront\.io\/\$\{encodeURIComponent\(workerPath\)\}\/game\/\$\{encodeURIComponent\(lobby\?\.id/);
  assert.match(partyClient, /openFrontWindowName = "openfront-party-game"/);
  assert.match(partyClient, /prepareOpenFrontWindow\(\)/);
  assert.match(partyClient, /openFrontWindow\.location\.href = url/);
  assert.match(partyClient, /openFrontWindow = window\.OPENFRONT_PARTY_OPENFRONT_WINDOW \|\| null/);
  assert.doesNotMatch(partyClient, /openFrontWindow = window\.open\(url, openFrontWindowName\)/);
  assert.doesNotMatch(partyClient, /mark yourself not ready/);
  assert.match(partyClient, /Open Party and choose Open lobby to join/);
  assert.doesNotMatch(partyClient, /window\.open\("", openFrontWindowName\)/);
  assert.doesNotMatch(partyClient, /location\.assign\(officialGameUrl\(launch\.lobby\)\)/);
  assert.match(partyClient, /current\.companionConnected/);
  assert.match(viewerHtml, /OPENFRONT_PARTY_OPENFRONT_WINDOW = window\.open\(card\.dataset\.joinUrl, "openfront-party-game"\)/);
  assert.match(companion, /openfront\.io\/\$\{encodeURIComponent\(workerPath\)\}\/game\/\$\{encodeURIComponent\(event\.gameId\)\}/);
  assert.match(rootHtml, /\.\/viewer\//);
  assert.doesNotMatch(viewerHtml, /(?:href|src)="\//);
  assert.equal(fs.existsSync(path.join(output, "viewer", ".git")), false);
  assert.equal(fs.existsSync(path.join(output, "openfront-party-companion.user.js")), true);
});
