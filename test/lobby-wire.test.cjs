const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const wire = require(path.join(root, "viewer", "lobby-wire.js"));

// Golden vectors produced by OpenFront's own zbin encoder (zbin/zb.ts at the
// commit recorded in lobby-wire.js as SCHEMA_REV), driving the field
// declarations copied from src/core/Schemas.ts. Regenerating them is how you
// confirm a schema change upstream: encode with their library, decode here.
const vectors = JSON.parse(
  fs.readFileSync(path.join(__dirname, "fixtures", "lobby-wire-vectors.json"), "utf8"),
);

const bytesOf = (hex) => Uint8Array.from(Buffer.from(hex, "hex"));

test("decodes frames produced by OpenFront's own zbin encoder", () => {
  const names = Object.keys(vectors);
  assert.ok(names.length >= 4, "expected the full set of golden vectors");

  for (const name of names) {
    const { hex, value } = vectors[name];
    assert.deepStrictEqual(
      wire.decodeLobbyMessage(bytesOf(hex)),
      value,
      `vector "${name}" decoded differently`,
    );
  }
});

test("accepts ArrayBuffer as well as Uint8Array", () => {
  const bytes = bytesOf(vectors.simpleFull.hex);
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);

  assert.deepStrictEqual(
    wire.decodeLobbyMessage(buffer),
    vectors.simpleFull.value,
  );
});

test("full snapshots and count deltas keep the shapes the viewer expects", () => {
  const full = wire.decodeLobbyMessage(bytesOf(vectors.simpleFull.hex));
  assert.equal(full.type, "full");
  assert.equal(typeof full.serverTime, "number");
  assert.ok(Array.isArray(full.games.ffa));
  assert.equal(typeof full.games.ffa[0].gameID, "string");
  assert.equal(typeof full.games.ffa[0].numClients, "number");

  const counts = wire.decodeLobbyMessage(bytesOf(vectors.counts.hex));
  assert.equal(counts.type, "counts");
  assert.deepStrictEqual(Object.values(counts.counts).map((n) => typeof n), [
    "number",
    "number",
    "number",
  ]);
});

test("an unknown enum ordinal degrades instead of killing the frame", () => {
  // A newly shipped map is the common case: the ordinal lands past the end of
  // GAME_MAP, and everything else about the lobby is still worth rendering.
  const bytes = bytesOf(vectors.simpleFull.hex);
  const gameMapOffset = bytes.indexOf(38); // "Europe" ordinal in the config body
  assert.notEqual(gameMapOffset, -1);
  bytes[gameMapOffset] = 126;

  const decoded = wire.decodeLobbyMessage(bytes);
  assert.equal(decoded.games.ffa[0].gameConfig.gameMap, "unknown#126");
  assert.equal(decoded.games.ffa[0].gameConfig.difficulty, "Medium");
});

test("rejects malformed frames rather than returning half a lobby list", () => {
  const good = bytesOf(vectors.simpleFull.hex);

  assert.throws(
    () => wire.decodeLobbyMessage(good.subarray(0, good.length - 3)),
    /unexpected end of input|implausible count/,
  );

  const trailing = new Uint8Array(good.length + 1);
  trailing.set(good);
  assert.throws(() => wire.decodeLobbyMessage(trailing), /trailing byte/);

  assert.throws(() => wire.decodeLobbyMessage(Uint8Array.of(9)), /tag 9 out of range/);
  assert.throws(() => wire.decodeLobbyMessage("not bytes"), /expected ArrayBuffer/);
});

test("refuses a __proto__ key in the counts record", () => {
  // counts is a plain string-keyed record, so its keys come straight off the
  // wire; assigning "__proto__" would swap the object's prototype invisibly.
  const payload = Buffer.concat([
    Buffer.from([0x01]), // union tag: counts
    Buffer.from([0x00]), // serverTime = 0
    Buffer.from([0x01]), // one entry
    Buffer.from([0x09]), // key length
    Buffer.from("__proto__", "utf8"),
    Buffer.from([0x01]), // value = 1
  ]);

  assert.throws(
    () => wire.decodeLobbyMessage(Uint8Array.from(payload)),
    /forbidden key/,
  );
});
