'use strict';

/** Error kinds, identical across all official System Locker clients. */
const ErrorKind = Object.freeze({
  Configuration: 'Configuration',
  Transport: 'Transport',
  UnsignedResponse: 'UnsignedResponse',
  InvalidSignature: 'InvalidSignature',
  InvalidPayload: 'InvalidPayload',
  FreshnessViolation: 'FreshnessViolation',
  SessionTerminated: 'SessionTerminated',
  LocalFailure: 'LocalFailure',
});

/** Every client operation throws a BedrockError; kind categorizes it. */
class BedrockError extends Error {
  /**
   * @param {string} kind one of ErrorKind
   * @param {string} message
   */
  constructor(kind, message) {
    super(message);
    this.name = 'BedrockError';
    this.kind = kind;
  }
}

function fail(kind, message) {
  return new BedrockError(kind, message);
}

module.exports = { BedrockError, ErrorKind, fail };
