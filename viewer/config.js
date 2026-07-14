// Local and same-origin deployments need no override. The GitHub Pages build
// replaces this file with a public HTTPS relay origin.
window.OPENFRONT_PARTY_CONFIG = Object.freeze({
  relayOrigin: "",
  userscriptPath: "../openfront-party-companion.user.js",
  extensionChromePath: "../extensions/openfront-party-chrome.zip",
  extensionFirefoxPath: "../extensions/openfront-party-firefox.xpi",
});
