'use strict';

const CODE_NAMES = Object.freeze([
  'OK', 'OUTDATED', 'MISSING_FIELD', 'INVALID_REQUEST', 'INVALID_SYSTEM',
  'INVALID_CREDENTIALS', 'GOOGLE_SSO_REQUIRED', 'USER_NOT_VERIFIED',
  'INVALID_KEY', 'KEY_FROZEN',
  'HWID_BANNED', 'HWID_MISMATCH', 'SPOOF_SUSPECTED', 'SYSTEM_PAUSED',
  'PLAN_INACTIVE', 'PRODUCTION_AUTH_UNAVAILABLE', 'USER_LIMIT_REACHED',
  'EXPIRED_KEY', 'PROGRAM_DIGEST_MISMATCH', 'INVALID_BEATRATE',
  'NO_ACTIVE_SIGNING_KEY', 'INVALID_SESSION', 'SESSION_TERMINATED',
  'STALE_SESSION', 'HEARTBEAT_TOO_EARLY', 'HEARTBEAT_VARIANCE_EXCEEDED',
  'SIGNING_KEY_REVOKED', 'CONCURRENT_HEARTBEAT', 'INTERNAL_ERROR',
]);

/** Maps a wire response code to its name, or null when unrecognized. */
function responseCodeFromString(value) {
  return CODE_NAMES.includes(value) ? value : null;
}

const FAILURE_CODES = new Set([
  'MISSING_FIELD', 'INVALID_REQUEST', 'INVALID_SYSTEM', 'SYSTEM_PAUSED',
  'PLAN_INACTIVE', 'PRODUCTION_AUTH_UNAVAILABLE', 'PROGRAM_DIGEST_MISMATCH',
  'INVALID_BEATRATE', 'NO_ACTIVE_SIGNING_KEY', 'INTERNAL_ERROR',
]);

function expectedAuthenticated(code) {
  return code === 'OK' || code === 'OUTDATED';
}

function expectedFailure(code) {
  return FAILURE_CODES.has(code);
}

function expectedError(code) {
  return code !== 'OK' && !FAILURE_CODES.has(code);
}

module.exports = { CODE_NAMES, responseCodeFromString, expectedAuthenticated, expectedFailure, expectedError };
