'use strict';

const { spawnSync } = require('child_process');

// The server mints this URL in GOOGLE_SSO_REQUIRED denials; the client
// mirrors it so the flow can start before a denial is ever seen.
const GOOGLE_SSO_PORTAL = 'https://systemlocker.net/user/sso?system=';

/** Returns the Google SSO portal URL for a system. After the user signs in
 * there, the portal shows a system-specific password that is valid for 180
 * days and is then used as the account password. */
function googleSsoUrl(systemId) {
  return GOOGLE_SSO_PORTAL + encodeURIComponent(systemId);
}

/** Launches the default browser at a URL. Node has no built-in opener, so
 * this shells out to the platform's native launcher without adding a
 * dependency. Returns whether the browser launched; hosts without one
 * (servers, containers) get false and fall back to displaying the URL. */
function openUrl(url) {
  if (url === '') {
    return false;
  }
  let command;
  let args;
  if (process.platform === 'win32') {
    command = 'rundll32';
    args = ['url.dll,FileProtocolHandler', url];
  } else if (process.platform === 'darwin') {
    command = 'open';
    args = [url];
  } else {
    command = 'xdg-open';
    args = [url];
  }
  try {
    const result = spawnSync(command, args, { stdio: 'ignore', timeout: 5000 });
    return result.error === undefined && result.status === 0;
  } catch {
    return false;
  }
}

/** Opens the Google SSO portal for a system in the default browser. The URL
 * is always returned so flows without a browser can hand it to the
 * developer; `opened` reports whether the launch succeeded. */
function beginGoogleSso(systemId) {
  const url = googleSsoUrl(systemId);
  return { url, opened: openUrl(url) };
}

module.exports = { GOOGLE_SSO_PORTAL, googleSsoUrl, openUrl, beginGoogleSso };
