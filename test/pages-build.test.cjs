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
  assert.match(indexHtml, /href="https:\/\/discord\.com\/users\/1397288335290138734"/);
  assert.match(indexHtml, /<span class="discord-name">D_D<\/span>/);
  assert.match(indexHtml, /<span class="discordRoleLabel">Original Gangsters<\/span>/);
  assert.match(indexHtml, /<span class="discordRoleLabel">Site Host<\/span>/);
  assert.match(indexHtml, /aria-label="Original Gangsters"[\s\S]*Kale[\s\S]*Wonder[\s\S]*aria-label="Site Host"[\s\S]*D_D/);
  assert.match(indexHtml, /\{ key: "custom", label: "Custom Lobby" \}/);
  assert.match(indexHtml, /return publicType === "hosted";/);
  assert.doesNotMatch(indexHtml, /publicType === "hosted" \|\|/);
  assert.doesNotMatch(indexHtml, /startsAt === null/);
  assert.match(indexHtml, /isCustomLobby\(g\) \? "custom"/);
  assert.match(indexHtml, /function standardGameModifierDetails\(g\)/);
  assert.match(indexHtml, /function customGameModifierDetails\(g\)/);
  assert.match(indexHtml, /isCustomLobby\(g\)[\s\S]*customGameModifierDetails\(g\)[\s\S]*standardGameModifierDetails\(g\)/);
  assert.match(indexHtml, /class="cardBadge \$\{escapeHtml\(detail\.tone\)\}"/);
  assert.doesNotMatch(indexHtml, /class="gameCardSettings"/);
  assert.match(indexHtml, /Disabled Units:/);
  assert.match(indexHtml, /Host: Infinite Gold/);
  assert.match(indexHtml, /href="styles\.css\?v=[a-f0-9]{12}"/);
  assert.match(styles, /data-cat="custom"/);
  assert.match(styles, /grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/);
  assert.match(styles, /grid-column: 1 \/ -1/);
  assert.match(styles, /grid-auto-flow: column/);
  assert.match(styles, /overflow-x: auto/);
  assert.match(styles, /\.discordRoleLabel/);
  assert.match(styles, /\.discordRoleButtons/);
  assert.doesNotMatch(styles, /max-height: 602px/);
  assert.match(indexHtml, /col\.key === "custom" \? 0 : COLUMN_MIN_SLOTS/);
  assert.match(indexHtml, /function handleCustomLobbyWheel\(event\)/);
  assert.match(indexHtml, /addEventListener\("wheel", handleCustomLobbyWheel, \{ passive: false \}\)/);
  assert.match(indexHtml, /host\.scrollLeft = Math\.max\(0, Math\.min\(maxScroll, host\.scrollLeft \+ delta\)\)/);
  assert.match(styles, /\.cardBadge\.danger/);
  assert.doesNotMatch(indexHtml, /party|companion/i);
  assert.doesNotMatch(styles, /party|companion/i);
  assert.equal(fs.existsSync(path.join(output, "party.js")), false);
  assert.equal(fs.existsSync(path.join(output, "config.js")), false);
  assert.equal(fs.existsSync(path.join(output, "privacy.html")), false);
  assert.equal(fs.existsSync(path.join(output, "history")), false);
  assert.equal(fs.existsSync(path.join(output, "openfront-party-companion.user.js")), false);
});

test("only hosted games are routed to Custom Lobby", () => {
  const source = fs.readFileSync(path.join(root, "viewer", "index.html"), "utf8");
  const match = source.match(/function isCustomLobby\(g\) \{[\s\S]*?\n      \}/);
  assert.ok(match, "isCustomLobby should be present in the standalone viewer");

  const isCustomLobby = Function(`"use strict"; return (${match[0]});`)();
  const games = [
    { id: "ffa-open", startsAt: null, raw: { __rawType: "ffa" } },
    { id: "team-open", startsAt: null, raw: { __rawType: "team" } },
    { id: "special-open", startsAt: null, raw: { __rawType: "special" } },
    { id: "hosted-open", startsAt: null, raw: { __rawType: "hosted" } },
    { id: "hosted-timed", startsAt: Date.now() + 60_000, raw: { publicGameType: "hosted" } },
  ];
  const buckets = { ffa: [], team: [], special: [], custom: [] };

  for (const game of games) {
    const category = isCustomLobby(game)
      ? "custom"
      : (game.raw.__rawType || game.raw.publicGameType);
    buckets[category].push(game.id);
  }

  assert.deepEqual(buckets, {
    ffa: ["ffa-open"],
    team: ["team-open"],
    special: ["special-open"],
    custom: ["hosted-open", "hosted-timed"],
  });
  assert.equal(Object.values(buckets).flat().length, games.length);
});

test("mouse wheel scrolls the Custom Lobby row horizontally", () => {
  const source = fs.readFileSync(path.join(root, "viewer", "index.html"), "utf8");
  const match = source.match(/function customLobbyWheelDelta\(event, pageSize\) \{[\s\S]*?\n      \}\n\n      \/\/ Build/);
  assert.ok(match, "Custom Lobby wheel handler should be present");

  const functions = match[0].replace(/\n\n      \/\/ Build$/, "");
  const { handleCustomLobbyWheel } = Function(
    "WheelEvent",
    `"use strict"; ${functions}; return { handleCustomLobbyWheel };`
  )({ DOM_DELTA_LINE: 1, DOM_DELTA_PAGE: 2 });

  const host = { clientWidth: 380, scrollWidth: 1000, scrollLeft: 0 };
  let prevented = false;
  handleCustomLobbyWheel({
    ctrlKey: false,
    deltaMode: 0,
    deltaY: 120,
    currentTarget: host,
    preventDefault() { prevented = true; },
  });

  assert.equal(host.scrollLeft, 120);
  assert.equal(prevented, true);

  host.scrollLeft = 620;
  prevented = false;
  handleCustomLobbyWheel({
    ctrlKey: false,
    deltaMode: 0,
    deltaY: 120,
    currentTarget: host,
    preventDefault() { prevented = true; },
  });

  assert.equal(host.scrollLeft, 620);
  assert.equal(prevented, false, "page scrolling should resume at the row edge");
});
