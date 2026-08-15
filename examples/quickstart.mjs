// ESM quickstart — the package works the same from both module systems.
import { Client } from 'systemlocker-bedrock';
import { deviceHwid } from 'systemlocker-bedrock/hwid';

const client = new Client({
  systemId: 'abcdefghijklmnopqrst',
  signingPublicKey: '…base64url Ed25519 key…',
  version: '1.0.0',
});

client.onHeartbeatFailure((failure) => {
  console.log('session ended:', failure.error.message);
  process.exit(1);
});

const result = await client.authenticateWithKey('SL-XXXX-XXXX-XXXX', {
  requestInvisibleFolderToken: true,
});
console.log('authenticated:', result.sessionStarted);
await client.shutdown();
