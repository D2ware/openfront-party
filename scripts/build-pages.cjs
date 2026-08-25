const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const root = path.resolve(__dirname, "..");
const output = path.join(root, "_site");

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

fs.rmSync(output, { recursive: true, force: true });
fs.mkdirSync(output, { recursive: true });
fs.copyFileSync(path.join(root, "viewer", "index.html"), path.join(output, "index.html"));
fs.copyFileSync(path.join(root, "viewer", "styles.css"), path.join(output, "styles.css"));
fs.copyFileSync(path.join(root, "viewer", "lobby-wire.js"), path.join(output, "lobby-wire.js"));

const indexPath = path.join(output, "index.html");
let indexHtml = fs.readFileSync(indexPath, "utf8");
indexHtml = indexHtml
  .replace(/\s*<div class="partySelectionBar"[\s\S]*?(?=\s*<div class="panelShell")/, "\n")
  .replace(/\s*function getPartyFilterPreference\([\s\S]*?(?=\s*function getAlertFilterKey)/, "\n      ")
  .replace(/\s*window\.dispatchEvent\(new CustomEvent\("openfront:lobbies-rendered",[\s\S]*?\n\s*\}\)\);/, "")
  .replace(/window\.OPENFRONT_PARTY_OPENFRONT_WINDOW = /g, "")
  .replace(/openfront-party-game/g, "openfront-lobby");
fs.writeFileSync(indexPath, indexHtml);

const stylesPath = path.join(output, "styles.css");
const styles = fs.readFileSync(stylesPath, "utf8")
  .replace(/\n\/\* Party coordination \*\/[\s\S]*$/, "\n");
fs.writeFileSync(stylesPath, styles);
fs.writeFileSync(path.join(output, ".nojekyll"), "");

const version = versionAssets(output, ["styles.css", "lobby-wire.js"]);

console.log(`GitHub Pages lobby artifact created in ${output}`);
console.log(`Asset version: ${version}`);
