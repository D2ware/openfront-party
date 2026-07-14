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
  const rootHtml = fs.readFileSync(path.join(output, "index.html"), "utf8");

  assert.match(config, /https:\/\/relay\.example\.com/);
  assert.match(viewerHtml, /id="partyReadyToggle"/);
  assert.match(viewerHtml, /id="partyReadyStatus"/);
  assert.match(partyClient, /send\("member\.state", \{ state: next \}\)/);
  assert.match(partyClient, /Needs companion/);
  assert.match(rootHtml, /\.\/viewer\//);
  assert.doesNotMatch(viewerHtml, /(?:href|src)="\//);
  assert.equal(fs.existsSync(path.join(output, "viewer", ".git")), false);
  assert.equal(fs.existsSync(path.join(output, "openfront-party-companion.user.js")), true);
});
