# System Locker Bedrock — Node.js

Official Node.js client for **System Locker Bedrock**, the license-verification
protocol for software distributed to **untrusted machines**. Every server
response is Ed25519-signed and verified against a pinned public key before
parsing, sessions rotate tokens on every heartbeat, and each request carries
a fresh cryptographic challenge — replay attacks and forged responses are
infeasible even for an attacker who fully controls the network.

If your code runs on a machine you control, look at the System Locker Simple
client instead.

## Install

```sh
npm install systemlocker-bedrock
```

Zero runtime dependencies — `node:crypto` only, Node.js 20+. Works from both
ESM and CommonJS.

## Quickstart

```js
import { Client } from "systemlocker-bedrock";

const client = new Client({
	systemId: "abcdefghijklmnopqrst", // from the dashboard
	signingPublicKey: "…base64url Ed25519 key…", // from the dashboard
	version: "1.0.0",
});

client.onHeartbeatFailure((failure) => {
	console.log("session ended:", failure.error.message);
	process.exit(1); // save state and exit — the license is no longer live
});

const result = await client.authenticateWithKey("SL-XXXX-XXXX-XXXX", {
	requestInvisibleFolderToken: true,
	variables: ["tier"],
});
if (!result.sessionStarted) process.exit(1);

// …your protected application logic; heartbeats run automatically…
await client.shutdown();
```

## What the client enforces for you

- **Signed responses only.** The Ed25519 signature is verified against the
  pinned key _before_ any parsing; tampered payloads never reach your code.
- **Challenge echoes.** Every init/beat carries a fresh 86-character CSPRNG
  challenge that the server must echo exactly.
- **Freshness.** `server_time` must be within `maxServerClockSkewSeconds`
  (default 120) of the local clock.
- **Identity binding.** The response's `license_key_hash`/`username_hash`
  must equal the locally computed SHA-256 of the submitted credential.
- **Token rotation.** Init tokens start with `BRK_`, every heartbeat rotates
  to a `BRF_` token; a lost heartbeat response is retried once, idempotently.
- **Denial-only unsigned responses.** Exactly one unsigned response is ever
  accepted: a `SIGNING_KEY_REVOKED` termination, which only ends the session.

Failures throw a `BedrockError` whose `kind` distinguishes infrastructure
problems (`Transport`) from attacks (`InvalidSignature`,
`UnsignedResponse`) from legitimate denials (`SessionTerminated`).

## Heartbeats

With `automaticHeartbeats: true` (the default) a background timer beats
every `beatRateMs` (25 000–3 600 000 ms), one beat in flight at a time. When
it fails, your `onHeartbeatFailure` hook fires once and the session is dead.
Disable it and `await client.heartbeatNow()` yourself for full manual
control.

## Invisible Folder file delivery

```js
const folder = client.getInvisibleFolder();
const result = await folder.downloadIfNew("app-assets-v1", lastRevision, "assets.zip");
if (result.downloaded) lastRevision = result.revision; // persist this
```

`download` (Buffer), `downloadToFile` (disk, unencrypted), `metadata`, and
`downloadIfNew` (revision-checked) are available. Tokens live in memory only
and clear on `shutdown()`.

## Google SSO (account authentication)

Accounts created through Google sign-in have no local password on the
server. A `username`/`password` authentication for such an account is
answered with a signed `GOOGLE_SSO_REQUIRED` denial whose payload carries
`sso_url` — the portal where the user completes Google sign-in and receives
a system-specific password (valid 180 days) to use as their account
password. There is no callback; the user transcribes the generated password
into your login form and you simply retry.

```js
const result = await client.authenticateWithPassword(username, password);
if (result.response.responseCode === "GOOGLE_SSO_REQUIRED") {
	// The denial's URL is authoritative; open it in the default browser.
	const portal = result.response.ssoUrl ?? client.googleSsoUrl();
	if (!bedrock.openUrl(portal)) {
		console.log(`Finish Google sign-in at: ${portal}`); // headless fallback
	}
}
```

You can also start the flow before any denial: `client.beginGoogleSso()`
(or `bedrock.beginGoogleSso(systemId)`) opens the portal and returns
`{ url, opened }`.

## Device identifiers (HWID)

The library derives a hardware ID by default; set `config.hwid = "1"` only to
explicitly disable device locking.

```js
import { deviceHwid } from "systemlocker-bedrock/hwid";

config.hwid = await deviceHwid();
```

Derives a stable identifier from the machine GUID, hardware UUID, CPU id,
and MAC (Windows and Linux). Passing your own stable value works just as
well — and avoids hardware-enumeration quirks entirely.

### Fault-tolerant HWID (SL-HWID)

SL-HWID is the default device identifier since 1.0.0 — a change from
pre-1.0 versions. It is fault tolerant, cross platform (Windows, macOS,
Linux), and combines **14 hardware factors** by default: any two can fail
or change without changing the HWID, and drifted factors are quietly
re-absorbed after each successful authentication. The point is to prevent
over-fitting to any single machine detail while avoiding over-dependence
on the exact hardware configuration.

Existing pre-v2 HWIDs remain recoverable with their stored schema and
threshold; they migrate to the current schema after a successful commit.

Keep the pre-1.0 behavior with `hwidMode: 'legacy'`. A custom `hwid` value (or "1" to
disable device locking entirely) still wins over both modes.

Default storage is shared by all Bedrock applications for the current user,
so they report the same HWID on the same device. A short-lived interprocess
lock serializes enrollment and refresh; a crashed process's marker is
recovered automatically. Configure a different `slHwidStore` only when you
deliberately need separate device state. Re-enrolling changes the HWID for
every application sharing that storage.

The HWID determination is deliberately best-effort, but it is expected to
match runs of the same application, and, in most cases, across any
application run on the same device and operating system.

A hard lock chosen when the shared device state is enrolled cannot be
weakened by another application.

## Security

See [SECURITY.md](SECURITY.md). Report vulnerabilities privately through the
System Locker support channels, not via public issues.
