// Decoder for OpenFront's /wN/lobbies WebSocket.
//
// As of OpenFrontIO commit d70e4865 ("feat(net): binary protocol for every
// websocket frame") the lobby socket no longer speaks JSON. Every frame is a
// "zbin" payload — the game's own binary serialization (OpenFrontIO/zbin).
//
// A zbin payload is a bare positional byte stream: no version byte, no field
// tags, no negotiation. The schema IS the format, so this file mirrors the
// exact wire layout of PublicLobbyMessageSchema in
// OpenFrontIO/src/core/Schemas.ts:
//
//   frame   = varint union tag (0 = "full", 1 = "counts") + object body
//   object  = ceil(bits/8) presence-header bytes, then field bodies in
//             declaration order. Bits are allocated per field, in declaration
//             order, as (presence, null, bool-value), packed LSB-first.
//             Booleans and single-value literals write no body bytes.
//   varint  = unsigned LEB128
//   string  = varint byte length + UTF-8
//   float   = float64 little-endian
//   enum    = varint ordinal in declaration order
//   array   = varint count + elements
//   record  = varint count + (key, value) pairs; keys are enum ordinals for
//             partialRecord(enum, …) and plain strings otherwise
//   union   = varint variant tag + variant body
//
// Because the game pins its client and server to a single build, adding or
// reordering any schema field — or any enum member — silently changes the
// layout. SCHEMA_REV records the upstream commit these tables were derived
// from; when the game updates, re-derive them from Schemas.ts, Game.ts and
// Maps.gen.ts. Unknown enum ordinals (a newly shipped map, say) decode to
// "unknown#<n>" rather than throwing, so a map addition alone does not take
// the lobby list down.
(function (global) {
  "use strict";

  // Upstream commit the tables below were verified against.
  const SCHEMA_REV = "ce949845";

  // --- Enum tables (declaration order = wire ordinal) ----------------------

  // src/core/game/Maps.gen.ts — GameMapType
  const GAME_MAP = [
    "Achiran", "Aegean", "Africa", "Alps", "Amazon River", "Antarctica",
    "ArchipelagoSea", "Arctic", "Asia", "Australia", "Baikal",
    "Baikal Nuke Wars", "Baja California", "Balkans", "Balkhash", "Baltics",
    "Bering Sea", "Bering Strait", "Between Two Seas", "Black Sea",
    "Bosphorus Straits", "Branching Paths", "Britannia",
    "Britannia Classic", "Caribbean", "Caspian Sea", "Caucasus", "China",
    "Chopping Block", "Clearwater Lakes", "Conakry", "Crimea",
    "Danish Straits", "Deglaciated Antarctica", "Didier", "Didier France",
    "Dyslexdria", "East Asia", "Europe", "Europe Classic",
    "Falkland Islands", "Faroe Islands", "Finger Lakes", "Four Islands",
    "France", "Gateway to the Atlantic", "Germany", "Giant World Map",
    "Great Lakes", "Gulf Of Guinea", "Gulf of St. Lawrence", "Halkidiki",
    "Hawaii", "Hecate Strait", "Hong Kong", "Iceland",
    "Indian Subcontinent", "Irish Sea", "Italia", "Japan",
    "Juan De Fuca Strait", "Korea", "Labyrinth", "Las Vegas Strip",
    "Lemnos", "Levant", "Lisbon", "Los Angeles", "Luna", "Manicouagan",
    "Mare Nostrum", "Mars", "Mena", "Middle East", "MilkyWay",
    "Mississippi River", "Montreal", "More Than Luck", "New York City",
    "Nile Delta", "North America", "Northwest Passage", "Oceania", "Onion",
    "Pangaea", "Passage", "Pluto", "Russia", "San Francisco", "Scandinavia",
    "Sierpinski", "Sol", "South America", "SoutheastAsia",
    "Strait of Gibraltar", "Strait of Hormuz", "Strait Of Malacca",
    "Surrounded", "Svalmel", "Taiwan Strait", "The Box", "Tierra Del Fuego",
    "Titan", "Tourney 2 Teams", "Tourney 3 Teams", "Tourney 4 Teams",
    "Tourney 8 Teams", "Traders Dream", "Two Lakes", "United States",
    "Venice", "Vietnam", "Warship Warship", "World", "World Inverted",
    "Yangtze River", "Yellow Sea", "Yenisei",
  ];

  // src/core/game/Game.ts
  const DIFFICULTY = ["Easy", "Medium", "Hard", "Impossible"];
  const GAME_TYPE = ["Singleplayer", "Public", "Private"];
  const GAME_MODE = ["Free For All", "Team"];
  const RANKED_TYPE = ["1v1", "2v2"];
  const GAME_MAP_SIZE = ["Compact", "Normal"];
  const UNIT_TYPE = [
    "Transport", "Warship", "Shell", "SAMMissile", "Port", "Atom Bomb",
    "Hydrogen Bomb", "Trade Ship", "Missile Silo", "Defense Post",
    "SAM Launcher", "City", "MIRV", "MIRV Warhead", "Train", "Factory",
  ];

  // src/core/Schemas.ts
  const PUBLIC_GAME_TYPE = ["ffa", "team", "special", "hosted"];
  const LOBBY_ACCENT = ["gold", "blue", "green", "red"];
  const DOOMSDAY_SPEED = ["slow", "normal", "fast", "veryfast"];
  const NATIONS_PRESET = ["default", "disabled"];

  // --- Byte reader ---------------------------------------------------------

  const textDecoder = new TextDecoder("utf-8", { fatal: true });
  const MAX_SAFE = Number.MAX_SAFE_INTEGER;

  class LobbyWireError extends Error {
    constructor(message) {
      super(message);
      this.name = "LobbyWireError";
    }
  }

  class Reader {
    constructor(bytes) {
      this.buf = bytes;
      this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      this.pos = 0;
    }

    get remaining() {
      return this.buf.length - this.pos;
    }

    need(n) {
      if (this.pos + n > this.buf.length) {
        throw new LobbyWireError("unexpected end of input");
      }
    }

    u8() {
      this.need(1);
      return this.buf[this.pos++];
    }

    // Unsigned LEB128. Multiplication rather than shifting, because `<<` wraps
    // at 32 bits and zbin varints span the full 2^53 range.
    uint() {
      let result = 0;
      let mult = 1;
      for (;;) {
        const b = this.u8();
        result += (b & 0x7f) * mult;
        if ((b & 0x80) === 0) break;
        mult *= 0x80;
        if (mult > MAX_SAFE) throw new LobbyWireError("varint too large");
      }
      if (result > MAX_SAFE) throw new LobbyWireError("varint too large");
      return result;
    }

    f64() {
      this.need(8);
      const value = this.view.getFloat64(this.pos, true);
      this.pos += 8;
      return value;
    }

    str() {
      const len = this.uint();
      this.need(len);
      try {
        return textDecoder.decode(this.buf.subarray(this.pos, this.pos + len));
      } finally {
        this.pos += len;
      }
    }

    // Every array element and record pair costs at least one byte, so a count
    // larger than the remaining input is corrupt. Refuse before allocating.
    count(path) {
      const n = this.uint();
      if (n > this.remaining) {
        throw new LobbyWireError(path + ": implausible count " + n);
      }
      return n;
    }

    expectEnd() {
      if (this.remaining !== 0) {
        throw new LobbyWireError(this.remaining + " trailing byte(s)");
      }
    }
  }

  // --- Schema interpreter --------------------------------------------------

  // A field is { key, type, opt, nul }. Types are:
  //   "uint" | "f64" | "str" | "bool"
  //   { enum: [...] } | { const: value } | { obj: { fields } }
  //   { arr: type } | { recordEnum: [keys], val: type } | { recordStr: type }
  //   { union: [types] }
  function f(key, type, mods) {
    return {
      key,
      type,
      opt: Boolean(mods && mods.opt),
      nul: Boolean(mods && mods.nul),
    };
  }

  const obj = (fields) => ({ obj: { fields } });

  function decodeEnum(reader, values) {
    const index = reader.uint();
    // Deliberately more forgiving than the game client: a newly shipped map or
    // unit only makes this ordinal unknown, and the rest of the lobby is still
    // worth rendering.
    return index < values.length ? values[index] : "unknown#" + index;
  }

  // Mirrors zbin's objectCodec: bits are allocated per field in declaration
  // order as (presence, null, bool-value); the header is ceil(bits/8) bytes,
  // packed LSB-first.
  function planObject(fields) {
    let bits = 0;
    const plans = fields.map((field) => {
      const isBool = field.type === "bool";
      const isConst = typeof field.type === "object" && "const" in field.type;
      return {
        field,
        isBool,
        isConst,
        presenceBit: field.opt ? bits++ : -1,
        nullBit: field.nul ? bits++ : -1,
        valueBit: isBool ? bits++ : -1,
      };
    });
    return { plans, headerBytes: Math.ceil(bits / 8) };
  }

  function decodeObject(reader, spec, path) {
    const plan = spec._plan || (spec._plan = planObject(spec.fields));
    const { plans, headerBytes } = plan;

    reader.need(headerBytes);
    const header = reader.buf.subarray(reader.pos, reader.pos + headerBytes);
    reader.pos += headerBytes;
    const bit = (i) => (header[i >> 3] & (1 << (i & 7))) !== 0;

    const out = {};
    for (const p of plans) {
      if (p.presenceBit >= 0 && !bit(p.presenceBit)) continue;

      if (p.nullBit >= 0 && bit(p.nullBit)) {
        out[p.field.key] = null;
      } else if (p.isBool) {
        out[p.field.key] = bit(p.valueBit);
      } else if (p.isConst) {
        out[p.field.key] = p.field.type.const;
      } else {
        out[p.field.key] = decodeValue(
          reader,
          p.field.type,
          path + "." + p.field.key,
        );
      }
    }
    return out;
  }

  function decodeValue(reader, type, path) {
    if (type === "uint") return reader.uint();
    if (type === "f64") return reader.f64();
    if (type === "str") return reader.str();

    if (type === "bool") {
      const b = reader.u8();
      if (b > 1) throw new LobbyWireError(path + ": invalid boolean " + b);
      return b === 1;
    }

    if (type.enum) return decodeEnum(reader, type.enum);
    if ("const" in type) return type.const;
    if (type.obj) return decodeObject(reader, type.obj, path);

    if (type.arr) {
      const n = reader.count(path);
      const out = [];
      for (let i = 0; i < n; i++) {
        out.push(decodeValue(reader, type.arr, path + "[]"));
      }
      return out;
    }

    if (type.recordEnum) {
      const n = reader.count(path);
      const out = {};
      for (let i = 0; i < n; i++) {
        const key = decodeEnum(reader, type.recordEnum);
        out[key] = decodeValue(reader, type.val, path + "{}");
      }
      return out;
    }

    if (type.recordStr) {
      const n = reader.count(path);
      const out = {};
      for (let i = 0; i < n; i++) {
        const key = reader.str();
        // Plain assignment of "__proto__" runs the prototype setter, swapping
        // the decoded object's prototype for server-chosen data while staying
        // invisible to Object.keys.
        if (key === "__proto__") {
          throw new LobbyWireError(path + ': forbidden key "__proto__"');
        }
        out[key] = decodeValue(reader, type.recordStr, path + "{}");
      }
      return out;
    }

    if (type.union) {
      const tag = reader.uint();
      if (tag >= type.union.length) {
        throw new LobbyWireError(path + ": union tag " + tag + " out of range");
      }
      return decodeValue(reader, type.union[tag], path + "|" + tag);
    }

    throw new LobbyWireError(path + ": bad type descriptor");
  }

  // --- Schemas (field order = Schemas.ts declaration order) ----------------

  const DoomsdayClockConfig = obj([
    f("enabled", "bool", { opt: true }),
    f("speed", { enum: DOOMSDAY_SPEED }, { opt: true }),
  ]);

  const OvertimeConfig = obj([
    f("enabled", "bool", { opt: true }),
    f("startMinutes", "uint", { opt: true }),
  ]);

  const PublicGameModifiers = obj([
    f("isCompact", "bool", { opt: true }),
    f("isRandomSpawn", "bool", { opt: true }),
    f("isCrowded", "bool", { opt: true }),
    f("isHardNations", "bool", { opt: true }),
    f("startingGold", "uint", { opt: true }),
    f("goldMultiplier", "f64", { opt: true }),
    f("isAlliancesDisabled", "bool", { opt: true }),
    f("isPortsDisabled", "bool", { opt: true }),
    f("isNukesDisabled", "bool", { opt: true }),
    f("isSAMsDisabled", "bool", { opt: true }),
    f("isPeaceTime", "bool", { opt: true }),
    f("isWaterNukes", "bool", { opt: true }),
    f("isDoomsdayClock", "bool", { opt: true }),
    f("isOvertime", "bool", { opt: true }),
  ]);

  const HostCheats = obj([
    f("infiniteGold", "bool", { opt: true }),
    f("infiniteTroops", "bool", { opt: true }),
    f("goldMultiplier", "f64", { opt: true, nul: true }),
    f("startingGold", "uint", { opt: true, nul: true }),
  ]);

  const GameConfig = obj([
    f("gameMap", { enum: GAME_MAP }),
    f("difficulty", { enum: DIFFICULTY }),
    f("donateGold", "bool"),
    f("donateTroops", "bool"),
    f("gameType", { enum: GAME_TYPE }),
    f("gameMode", { enum: GAME_MODE }),
    f("rankedType", { enum: RANKED_TYPE }, { opt: true }),
    f("gameMapSize", { enum: GAME_MAP_SIZE }),
    f("doomsdayClock", DoomsdayClockConfig, { opt: true }),
    f("overtime", OvertimeConfig, { opt: true }),
    f("publicGameModifiers", PublicGameModifiers, { opt: true }),
    f("nations", { union: ["uint", { enum: NATIONS_PRESET }] }),
    f("bots", "uint"),
    f("infiniteGold", "bool"),
    f("infiniteTroops", "bool"),
    f("instantBuild", "bool"),
    f("disableNavMesh", "bool", { opt: true }),
    f("disableAlliances", "bool", { opt: true, nul: true }),
    f("disableClanTags", "bool", { opt: true }),
    f("liveStatsEnabled", "bool", { opt: true }),
    f("anonymizeNames", "bool", { opt: true }),
    f("nameReveals", { arr: "str" }, { opt: true }),
    f("nameRevealPublicIds", { arr: "str" }, { opt: true }),
    f("waterNukes", "bool", { opt: true, nul: true }),
    f("randomSpawn", "bool"),
    f("maxPlayers", "uint", { opt: true }),
    f("allowedPublicIds", { arr: "str" }, { opt: true }),
    f("maxTimerValue", "uint", { opt: true, nul: true }),
    f("customAllianceDuration", "uint", { opt: true, nul: true }),
    f("startDelay", "uint", { opt: true, nul: true }),
    f("spawnImmunityDuration", "uint", { opt: true, nul: true }),
    f("disabledUnits", { arr: { enum: UNIT_TYPE } }, { opt: true }),
    // TeamCountConfigSchema: uint | "Duos" | "Trios" | "Quads" |
    // "Humans Vs Nations"
    f(
      "playerTeams",
      {
        union: [
          "uint",
          { const: "Duos" },
          { const: "Trios" },
          { const: "Quads" },
          { const: "Humans Vs Nations" },
        ],
      },
      { opt: true },
    ),
    f("goldMultiplier", "f64", { opt: true, nul: true }),
    f("startingGold", "uint", { opt: true, nul: true }),
    f("hostCheats", HostCheats, { opt: true }),
  ]);

  const PublicGameInfo = obj([
    f("gameID", "str"),
    f("numClients", "uint"),
    f("startsAt", "uint", { opt: true }),
    f("gameConfig", GameConfig, { opt: true }),
    f("publicGameType", { enum: PUBLIC_GAME_TYPE }),
    f("label", "str", { opt: true }),
    f("accent", { enum: LOBBY_ACCENT }, { opt: true }),
    f("featured", "bool", { opt: true }),
  ]);

  const PublicLobbyFull = obj([
    f("type", { const: "full" }),
    f("serverTime", "uint"),
    f("games", { recordEnum: PUBLIC_GAME_TYPE, val: { arr: PublicGameInfo } }),
  ]);

  const PublicLobbyCounts = obj([
    f("type", { const: "counts" }),
    f("serverTime", "uint"),
    f("counts", { recordStr: "uint" }),
  ]);

  const LOBBY_VARIANTS = [PublicLobbyFull, PublicLobbyCounts];

  function decodeLobbyMessage(input) {
    let bytes;
    if (input instanceof Uint8Array) {
      bytes = input;
    } else if (input instanceof ArrayBuffer) {
      bytes = new Uint8Array(input);
    } else if (ArrayBuffer.isView(input)) {
      bytes = new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    } else {
      throw new LobbyWireError("expected ArrayBuffer or typed array");
    }

    const reader = new Reader(bytes);
    const tag = reader.uint();
    if (tag >= LOBBY_VARIANTS.length) {
      throw new LobbyWireError("lobby message tag " + tag + " out of range");
    }

    const message = decodeValue(reader, LOBBY_VARIANTS[tag], "$");
    reader.expectEnd();
    return message;
  }

  const api = { decodeLobbyMessage, LobbyWireError, SCHEMA_REV };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  global.OpenFrontLobbyWire = api;
})(typeof window !== "undefined" ? window : globalThis);
