# Firefox source build

This archive is the complete human-readable source needed to reproduce the
submitted Firefox extension. No code is minified or obfuscated.

## Requirements

- Node.js 22 (Node.js 20 or newer is sufficient)
- npm

## Build

From the root of this source archive, run:

```sh
npm ci
npm run build:extensions -- https://moss.nonekode.fi
```

The Firefox package is written to:

```text
dist/openfront-party-firefox-1.0.1.xpi
```

The runtime files used to produce it are:

- `public/openfront-party-companion.user.js`: human-readable companion logic;
- `extension/background.js`: restricted cross-origin relay transport;
- `extension/page-bridge.js`: minimized OpenFront event bridge;
- `extension/assets/`: extension artwork;
- `scripts/build-extensions.cjs`: deterministic transformation and packaging.

The build uses Node.js standard-library modules only. The `ws` dependency in
`package.json` belongs to the separately hosted party relay and is not bundled
into the extension.
