'use strict';

const crypto = require('node:crypto');

const { BedrockError, ErrorKind, fail } = require('./errors');
const { expectedAuthenticated, expectedFailure, expectedError } = require('./response');
const { headerOf } = require('./transport');

const PROTOCOL_VERSION = 'bedrock-v1';
const SIGNATURE_BYTES = 64;
const PUBLIC_KEY_BYTES = 32;
const CHALLENGE_BYTES = 64;
const MAX_TRANSPORT_BYTES = 1024 * 1024;

// SPKI prefix for a raw Ed25519 public key: SEQUENCE { OID 1.3.101.112, BIT STRING }
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function generateChallenge() {
  return crypto.randomBytes(CHALLENGE_BYTES).toString('base64url');
}

function sha256Hex(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function base64UrlDecode(value) {
  if (typeof value !== 'string' || value === '' || value.length > MAX_TRANSPORT_BYTES || value.length % 4 === 1) {
    throw fail(ErrorKind.InvalidPayload, 'Invalid base64url length.');
  }
  if (!/^[A-Za-z0-9_-]*$/.test(value)) {
    throw fail(ErrorKind.InvalidPayload, 'Invalid base64url character.');
  }
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.toString('base64url') !== value) {
    throw fail(ErrorKind.InvalidPayload, 'Invalid base64url value.');
  }
  return decoded;
}

function ed25519KeyObject(rawPublicKey) {
  const der = Buffer.concat([ED25519_SPKI_PREFIX, rawPublicKey]);
  return crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
}

/**
 * Parses and validates the payload JSON. All type/consistency rules from
 * the specification throw InvalidPayload; freshness throws
 * FreshnessViolation.
 */
function parsePayload(config, jsonText, expectedChallenge, nowMs, httpResponse = null) {
  let json;
  try {
    json = JSON.parse(jsonText);
  } catch {
    throw fail(ErrorKind.InvalidPayload, 'Bedrock response JSON is invalid.');
  }
  if (json === null || typeof json !== 'object' || Array.isArray(json)) {
    throw fail(ErrorKind.InvalidPayload, 'Bedrock payload is not a JSON object.');
  }

  const requireString = (name) => {
    const value = json[name];
    if (typeof value !== 'string') {
      throw fail(ErrorKind.InvalidPayload, `Bedrock field '${name}' is missing or has the wrong type.`);
    }
    return value;
  };
  const requireBool = (name) => {
    const value = json[name];
    if (typeof value !== 'boolean') {
      throw fail(ErrorKind.InvalidPayload, `Bedrock field '${name}' is missing or has the wrong type.`);
    }
    return value;
  };
  const optionalString = (name) => {
    const value = json[name];
    if (value === undefined || value === null) {
      return null;
    }
    if (typeof value !== 'string') {
      throw fail(ErrorKind.InvalidPayload, `Bedrock field '${name}' has the wrong type.`);
    }
    return value;
  };

  const response = {
    code: null,
    responseCode: requireString('response_code'),
    humanResponse: requireString('human_response'),
    isError: requireBool('is_error'),
    isFailure: requireBool('is_failure'),
    authed: requireBool('authed'),
    protocolVersion: requireString('protocol_version'),
    keyId: httpResponse === null ? optionalString('kid') : requireString('kid'),
    system: requireString('system'),
    challenge: requireString('challenge'),
    serverTime: null,
    humanTime: requireString('human_time'),
    sessionToken: optionalString('session_token'),
    licenseKeyHash: optionalString('license_key_hash'),
    usernameHash: optionalString('username_hash'),
    terminationMessage: optionalString('termination_message'),
    ssoUrl: optionalString('sso_url'),
    invisibleFolderToken: optionalString('invisible_folder_token'),
    variables: {},
  };

  const serverTime = json['server_time'];
  if (!Number.isSafeInteger(serverTime)) {
    throw fail(ErrorKind.InvalidPayload, "Bedrock field 'server_time' is missing or has the wrong type.");
  }
  response.serverTime = serverTime;

  if (json['variables'] !== undefined) {
    const variables = json['variables'];
    if (variables === null || typeof variables !== 'object' || Array.isArray(variables)) {
      throw fail(ErrorKind.InvalidPayload, "Bedrock field 'variables' has the wrong type.");
    }
    for (const [name, value] of Object.entries(variables)) {
      if (typeof value === 'string') {
        response.variables[name] = { value, found: true };
      } else if (value === false) {
        response.variables[name] = { value: null, found: false };
      } else {
        throw fail(ErrorKind.InvalidPayload, 'Bedrock variable has the wrong type.');
      }
    }
  }

  response.code = responseCodeOrNull(response.responseCode);
  if (response.protocolVersion !== PROTOCOL_VERSION) {
    throw fail(ErrorKind.InvalidPayload, 'Unsupported Bedrock protocol version.');
  }
  const headerKeyId = httpResponse === null ? '' : headerOf(httpResponse, 'x-bedrock-key-id');
  if (httpResponse !== null && (response.keyId === '' || headerKeyId !== response.keyId)) {
    throw fail(ErrorKind.InvalidPayload, 'Bedrock response signing key ID is missing or inconsistent.');
  }
  if (httpResponse !== null && config.signingKeyId && response.keyId !== config.signingKeyId) {
    throw fail(ErrorKind.InvalidPayload, 'Bedrock response signing key ID does not match the configured pin.');
  }
  if (response.code === null) {
    throw fail(ErrorKind.InvalidPayload, 'Bedrock response contains an unknown response code.');
  }
  if (response.authed !== expectedAuthenticated(response.code) ||
      response.isError !== expectedError(response.code) ||
      response.isFailure !== expectedFailure(response.code)) {
    throw fail(ErrorKind.InvalidPayload, 'Bedrock response flags contradict its response code.');
  }
  if (response.system !== config.systemId) {
    throw fail(ErrorKind.InvalidPayload, 'Bedrock response is bound to a different system.');
  }
  if (response.challenge !== expectedChallenge) {
    throw fail(ErrorKind.InvalidPayload, 'Bedrock response challenge does not match the request.');
  }
  const nowSeconds = Math.floor(nowMs / 1000);
  const difference = Math.abs(response.serverTime - nowSeconds);
  if (difference > config.maxServerClockSkewSeconds) {
    throw fail(ErrorKind.FreshnessViolation, 'Bedrock response server time is outside the configured freshness window.');
  }
  return response;
}

function responseCodeOrNull(value) {
  const { responseCodeFromString } = require('./response');
  return responseCodeFromString(value);
}

/**
 * The Bedrock verification pipeline, in the exact order the specification
 * requires: transport headers, encoding, Ed25519 signature, then payload.
 * Exported so every official client runs the same conformance vectors.
 *
 * @param {object} config
 * @param {{ status: number, body: Buffer|string, headers: object }} httpResponse
 * @param {string} expectedChallenge
 * @param {number} nowMs current wall-clock time in milliseconds
 */
function verifySignedResponse(config, httpResponse, expectedChallenge, nowMs) {
  if (headerOf(httpResponse, 'x-bedrock-protocol') !== PROTOCOL_VERSION ||
      headerOf(httpResponse, 'x-bedrock-signed') === 'false') {
    throw fail(ErrorKind.UnsignedResponse, 'Bedrock response is missing its signed transport headers.');
  }

  const bodyText = Buffer.isBuffer(httpResponse.body) ? httpResponse.body.toString('latin1') : String(httpResponse.body);
  const signedBytes = base64UrlDecode(bodyText);
  if (signedBytes.length <= SIGNATURE_BYTES) {
    throw fail(ErrorKind.InvalidPayload, 'Bedrock signed response has an invalid encoding or length.');
  }

  let publicKey;
  try {
    publicKey = base64UrlDecode(config.signingPublicKey);
  } catch {
    throw fail(ErrorKind.Configuration, 'Pinned Bedrock public key is not a raw 32-byte Ed25519 key.');
  }
  if (publicKey.length !== PUBLIC_KEY_BYTES) {
    throw fail(ErrorKind.Configuration, 'Pinned Bedrock public key is not a raw 32-byte Ed25519 key.');
  }

  const signature = signedBytes.subarray(0, SIGNATURE_BYTES);
  const message = signedBytes.subarray(SIGNATURE_BYTES);
  if (!crypto.verify(null, message, ed25519KeyObject(publicKey), signature)) {
    throw fail(ErrorKind.InvalidSignature, 'Bedrock response signature verification failed.');
  }

  return parsePayload(config, message.toString('utf8'), expectedChallenge, nowMs, httpResponse);
}

/**
 * Handles the single permitted unsigned response: a SIGNING_KEY_REVOKED
 * termination with a termination message. Denial-only.
 */
function parseUnsignedRevocation(config, httpResponse, expectedChallenge, nowMs) {
  if (headerOf(httpResponse, 'x-bedrock-signed') !== 'false' ||
      headerOf(httpResponse, 'x-bedrock-protocol') !== PROTOCOL_VERSION) {
    throw fail(ErrorKind.UnsignedResponse, 'Bedrock returned an unauthenticated response.');
  }
  const bodyText = Buffer.isBuffer(httpResponse.body) ? httpResponse.body.toString('utf8') : String(httpResponse.body);
  const parsed = parsePayload(config, bodyText, expectedChallenge, nowMs);
  if (parsed.code !== 'SIGNING_KEY_REVOKED' || parsed.terminationMessage === null) {
    throw fail(ErrorKind.UnsignedResponse, 'Unsigned Bedrock response is diagnostic only and cannot be trusted.');
  }
  return parsed;
}

module.exports = {
  PROTOCOL_VERSION,
  generateChallenge,
  sha256Hex,
  base64UrlDecode,
  verifySignedResponse,
  parseUnsignedRevocation,
};
