# AMO reviewer notes — OpenFront Party Companion 1.0.1

## Single purpose

The extension keeps an explicitly linked OpenFront party together between
matches and records compact, finalized match summaries for that party.

## How to test

1. Install the Firefox package and open https://d2ware.github.io/openfront-party/viewer/.
2. Create or join a party.
3. Open Party settings, choose **Link OpenFront**, review the disclosure, check
   the consent box, and choose **Agree and link OpenFront**.
4. The newly opened https://openfront.io/ tab displays the companion panel.
5. The panel can be unlinked at any time. A match summary is sent only after an
   OpenFront match reaches a finalized result.

No paid account or reviewer credentials are required.

## Data and permissions

- `storage`: stores the random party credential, panel position, processed
  command IDs, and up to 20 local match summaries.
- `https://openfront.io/*`: observes the current game route and the local
  player's game events needed for party navigation and calculated summaries.
- `https://moss.nonekode.fi/*`: exchanges party state and finalized summaries
  with the project relay over HTTPS.

The extension does not read or transmit OpenFront cookies, passwords, account
tokens, Turnstile responses, chat, or raw WebSocket/worker message streams.
The page-world bridge emits only a fixed allowlist of compact gameplay fields;
the random party bearer token stays in the isolated extension world.

Privacy policy: https://d2ware.github.io/openfront-party/viewer/privacy.html
Support email: nijisafari@gmail.com
