'use strict';

/** Returns a Config with every default filled in. */
function defaultConfig() {
  return {
    systemId: '',
    version: 'bypass',
    hwid: null,
    hwidMode: 'sl-hwid',
    slHwidStore: null,
    slHwidExtraMandatory: null,
    beatRateMs: 30_000,
    requestTimeoutMs: 15_000,
    maxServerClockSkewSeconds: 120,
    baseUrl: 'https://systemlocker.net',
    invisibleFolderBaseUrl: 'https://invisiblefolder.net',
    userAgent: 'systemlocker-bedrock-node/1.1.0',
    programDigest: null,
    signingKeyId: null,
    invisibleFolderApiKey: null,
    signingPublicKey: '',
    automaticHeartbeats: true,
  };
}

const SYSTEM_ID_PATTERN = /^[A-Za-z0-9]{20}$/;

/**
 * Validates a config, throwing a Configuration BedrockError on the first
 * violation. Mirrors the protocol specification exactly.
 * @param {ReturnType<defaultConfig>} config
 */
function validateConfig(config) {
  const { BedrockError, ErrorKind } = require('./errors');
  if (config.hwidMode !== undefined && config.hwidMode !== 'legacy' && config.hwidMode !== 'sl-hwid') {
    throw new BedrockError(ErrorKind.Configuration, 'HWID mode must be "legacy" or "sl-hwid".');
  }
  if (!SYSTEM_ID_PATTERN.test(config.systemId ?? '')) {
    throw new BedrockError(ErrorKind.Configuration, 'System ID must be exactly 20 alphanumeric characters.');
  }
  if (config.beatRateMs < 25_000 || config.beatRateMs > 3_600_000) {
    throw new BedrockError(ErrorKind.Configuration, 'Bedrock heartbeat interval must be from 25 through 3600 seconds.');
  }
  if (!String(config.baseUrl ?? '').startsWith('https://')) {
    throw new BedrockError(ErrorKind.Configuration, 'Bedrock base URL must use HTTPS.');
  }
  const skew = config.maxServerClockSkewSeconds;
  if (!(skew > 0) || skew > 3600) {
    throw new BedrockError(ErrorKind.Configuration, 'Bedrock clock-skew allowance must be greater than zero and no more than one hour.');
  }
  const decoded = Buffer.from(config.signingPublicKey ?? '', 'base64url');
  if (config.signingPublicKey === '' || decoded.length !== 32) {
    throw new BedrockError(ErrorKind.Configuration, 'The Bedrock public key must decode to exactly 32 bytes.');
  }
  return { ...config };
}

module.exports = { defaultConfig, validateConfig };
