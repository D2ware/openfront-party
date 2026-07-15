const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const root = path.resolve(__dirname, "..");

test("GitHub Pages publishes the standalone tracker and universal userscript", () => {
  const result = spawnSync(process.execPath, ["scripts/build-pages.cjs", "https://relay.example.com"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);

  const output = path.join(root, "_site");
  const rootHtml = fs.readFileSync(path.join(output, "index.html"), "utf8");
  const viewerHtml = fs.readFileSync(path.join(output, "viewer", "index.html"), "utf8");
  const viewerConfig = fs.readFileSync(path.join(output, "viewer", "config.js"), "utf8");
  const partyClient = fs.readFileSync(path.join(output, "viewer", "party.js"), "utf8");
  const trackerHtml = fs.readFileSync(path.join(output, "history", "index.html"), "utf8");
  const trackerConfig = fs.readFileSync(path.join(output, "history", "config.js"), "utf8");
  const trackerClient = fs.readFileSync(path.join(output, "history", "app.js"), "utf8");
  const companion = fs.readFileSync(path.join(output, "openfront-party-companion.user.js"), "utf8");

  assert.match(rootHtml, /\.\/history\//);
  assert.match(viewerConfig, /https:\/\/relay\.example\.com/);
  assert.match(viewerConfig, /userscriptPath/);
  assert.match(viewerConfig, /historyPath/);
  assert.match(trackerConfig, /https:\/\/relay\.example\.com/);
  assert.match(viewerHtml, /id="partyReadyToggle"/);
  assert.match(viewerHtml, /id="partyInstallScript"/);
  assert.match(viewerHtml, /id="matchHistoryLink"[^>]+href="\.\.\/history\//);
  assert.doesNotMatch(viewerHtml, /matchHistoryBackdrop|history\.js|Chrome build|Firefox build/);
  assert.match(viewerHtml, /href="styles\.css\?v=[a-f0-9]{12}"/);
  assert.match(viewerHtml, /src="config\.js\?v=[a-f0-9]{12}"/);
  assert.match(viewerHtml, /src="party\.js\?v=[a-f0-9]{12}"/);
  assert.match(trackerHtml, /id="profileStats"/);
  assert.match(trackerHtml, /id="matchFeed"/);
  assert.match(trackerHtml, /FFA win index/);
  assert.match(trackerHtml, /href="styles\.css\?v=[a-f0-9]{12}"/);
  assert.match(trackerHtml, /src="app\.js\?v=[a-f0-9]{12}"/);
  assert.match(trackerClient, /\/api\/tracker\/overview/);
  assert.match(trackerClient, /\/api\/tracker\/profiles/);
  assert.match(trackerClient, /placementTrack/);
  assert.match(partyClient, /Install the userscript to follow launches and report every match/);
  assert.match(partyClient, /send\("member\.state", \{ state: next \}\)/);
  assert.match(partyClient, /You will be included in the next launch/);
  assert.match(companion, /@version\s+0\.5\.0/);
  assert.match(companion, /const DEFAULT_RELAY = "https:\/\/relay\.example\.com"/);
  assert.match(companion, /\/api\/tracker\/register/);
  assert.match(companion, /\/api\/tracker\/matches/);
  assert.match(companion, /function markEliminated/);
  assert.match(companion, /function markRouteExit/);
  assert.match(companion, /resultSource\s*=\s*"returned_to_home"/);
  assert.match(companion, /@grant\s+unsafeWindow/);
  assert.equal(fs.existsSync(path.join(output, "extensions")), false);
  assert.equal(fs.existsSync(path.join(output, "viewer", "history.js")), false);
  assert.equal(fs.existsSync(path.join(output, "viewer", ".git")), false);
  assert.equal(fs.existsSync(path.join(output, "openfront-party-companion.user.js")), true);
  assert.equal(fs.existsSync(path.join(output, "viewer", "privacy.html")), true);
});
