// Smallest working Bedrock integration.
const { Client } = require('systemlocker-bedrock');
const { deviceHwid } = require('systemlocker-bedrock/hwid');

async function main() {
  let hwid = 'my-own-stable-identifier';
  try {
    hwid = await deviceHwid();
  } catch {
    // unsupported platform — the developer-supplied fallback is fine
  }

  const client = new Client({
    systemId: 'abcdefghijklmnopqrst',               // from the dashboard
    signingPublicKey: '…base64url Ed25519 key…',    // from the dashboard
    hwid,
    version: '1.0.0',
  });
  client.onHeartbeatFailure((failure) => {
    console.log('session ended:', failure.error.message);
    process.exit(1);
  });

  const result = await client.authenticateWithKey('SL-XXXX-XXXX-XXXX', {
    requestInvisibleFolderToken: true,
    variables: ['tier'],
  });
  if (!result.sessionStarted) {
    console.log('rejected:', result.response.humanResponse);
    return;
  }

  console.log('authenticated; heartbeating automatically');
  // …your protected application logic…
  await client.shutdown();
}

main();
