const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const root = path.resolve(__dirname, "..");

test("GitHub Pages publishes the standalone OpenFront lobby board", () => {
  const result = spawnSync(process.execPath, ["scripts/build-pages.cjs"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);

  const output = path.join(root, "_site");
  const indexHtml = fs.readFileSync(path.join(output, "index.html"), "utf8");
  const styles = fs.readFileSync(path.join(output, "styles.css"), "utf8");

  assert.match(indexHtml, /id="cardGrid"/);
  assert.match(indexHtml, /\{ key: "custom", label: "Custom Lobby" \}/);
  assert.match(indexHtml, /publicType === "hosted"/);
  assert.match(indexHtml, /isCustomLobby\(g\) \? "custom"/);
  assert.match(indexHtml, /class="cardBadge \$\{escapeHtml\(detail\.tone\)\}"/);
  assert.doesNotMatch(indexHtml, /class="gameCardSettings"/);
  assert.match(indexHtml, /Disabled Units:/);
  assert.match(indexHtml, /Host: Infinite Gold/);
  assert.match(indexHtml, /href="styles\.css\?v=[a-f0-9]{12}"/);
  assert.match(styles, /data-cat="custom"/);
  assert.match(styles, /max-height: 602px/);
  assert.match(styles, /grid-auto-rows: max-content/);
  assert.match(styles, /\.cardBadge\.danger/);
  assert.doesNotMatch(indexHtml, /party|companion/i);
  assert.doesNotMatch(styles, /party|companion/i);
  assert.equal(fs.existsSync(path.join(output, "party.js")), false);
  assert.equal(fs.existsSync(path.join(output, "config.js")), false);
  assert.equal(fs.existsSync(path.join(output, "privacy.html")), false);
  assert.equal(fs.existsSync(path.join(output, "history")), false);
  assert.equal(fs.existsSync(path.join(output, "openfront-party-companion.user.js")), false);
});
