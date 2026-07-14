# AMO listing copy — OpenFront Party Companion 1.0.2

## Name

OpenFront Party Companion

## Summary

Keeps opt-in OpenFront parties together between matches and records finalized match summaries.

## Description

OpenFront Party Companion links an OpenFront browser tab to a party created on
the OpenFront Party lobby board.

When you explicitly link it, the companion can:

- keep your party presence active while the lobby board is closed;
- follow the lobby selected by the party leader;
- show party movement and Ready-state controls inside OpenFront;
- calculate a compact summary after a match finishes; and
- send that finalized summary to the party's Match history.

Linking is optional and requires a clear data disclosure and affirmative
consent. The extension does not read or transmit OpenFront passwords, cookies,
account tokens, Turnstile responses, chat, or raw game streams.

This is a community companion and is not affiliated with the OpenFront project.

## Category

Games & Entertainment

## Homepage

https://d2ware.github.io/openfront-party/viewer/

## Support email

nijisafari@gmail.com

## Privacy policy

https://d2ware.github.io/openfront-party/viewer/privacy.html

## Release notes

Initial Firefox release. Adds persistent opt-in party linking, coordinated lobby
navigation, Ready-state controls, and finalized match summaries.

## Data collection answers

- Authentication information: **Yes, required for core functionality.** A
  random party credential identifies the linked companion to the party relay.
- Website activity: **Yes, required for core functionality.** The extension
  observes only OpenFront routes and allowlisted local match events needed for
  party navigation and finalized summaries.
- Sold, licensed, or used for advertising: **No.**
- Shared with third parties: **No**, apart from infrastructure providers needed
  to operate and secure the party relay.
- User control: linking is optional, requires affirmative consent, and the user
  can unlink at any time.

## Reviewer notes

Paste the contents of `extension/AMO_REVIEW.md` into the reviewer-notes field.
If AMO requests source code, upload
`dist/openfront-party-firefox-source-1.0.2.zip`.
