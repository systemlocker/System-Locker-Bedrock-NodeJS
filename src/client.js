'use strict';

const { ErrorKind, fail } = require('./errors');
const { defaultConfig, validateConfig } = require('./config');
const { FetchHttpClient, responseOk } = require('./transport');
const { generateChallenge, sha256Hex, verifySignedResponse, parseUnsignedRevocation } = require('./verify');
const { BedrockSession } = require('./session');
const { InvisibleFolder } = require('./invisible-folder');

/**
 * Bedrock client for one system. Construct, call authenticateWithKey or
 * authenticateWithPassword once, and let the background heartbeat keep the
 * session alive (or drive heartbeatNow() with automaticHeartbeats: false).
 *
 * Failing operations throw a BedrockError with a `kind`.
 */
class Client {
  /**
   * @param {object} [config] start from defaultConfig() and override
   * @param {object} [options] { http: custom transport, now: () => ms }
   */
  constructor(config = {}, options = {}) {
    this.config = validateConfig({ ...defaultConfig(), ...config });
    this.http = options.http ?? new FetchHttpClient({
      requestTimeoutMs: this.config.requestTimeoutMs,
      userAgent: this.config.userAgent,
    });
    this.now = options.now ?? Date.now;
    this.session = null;
    this.failureHook = null;
    this.invisibleFolder = new InvisibleFolder(this);
  }

  endpoint(base, path) {
    return base.endsWith('/') ? base.slice(0, -1) + path : base + path;
  }

  signedHeaders() {
    return this.config.signingKeyId ? { 'X-Bedrock-Key-Id': this.config.signingKeyId } : {};
  }

  verifySigned(httpResponse, challenge) {
    return verifySignedResponse(this.config, httpResponse, challenge, this.now());
  }

  parseUnsigned(httpResponse, challenge) {
    return parseUnsignedRevocation(this.config, httpResponse, challenge, this.now());
  }

  get transport() {
    return this.http;
  }

  /**
   * Authenticates a license key and starts a session.
   * @param {string} licenseKey
   * @param {{ requestInvisibleFolderToken?: boolean, variables?: string[] }} [options]
   * @returns {Promise<{ response: object, sessionStarted: boolean }>}
   */
  authenticateWithKey(licenseKey, options = {}) {
    return this._authenticate({ key: licenseKey }, licenseKey, true, options);
  }

  /**
   * Authenticates an account and starts a session.
   * @param {string} username
   * @param {string} password
   * @param {{ requestInvisibleFolderToken?: boolean, variables?: string[] }} [options]
   */
  authenticateWithPassword(username, password, options = {}) {
    return this._authenticate({ username, password }, username, false, options);
  }

  async _authenticate(extraFields, identity, keyAuthentication, options) {
    if (this.config.hwid === null || this.config.hwid === '') {
      try {
        this.config.hwid = await require('../hwid/collect.cjs').deviceHwid();
      } catch (error) {
        throw fail(ErrorKind.Configuration, `Could not derive the default hardware ID: ${error.message}. Supply a custom HWID or use "1" to disable device checks.`);
      }
    }
    const challenge = generateChallenge();
    const form = {
      ...extraFields,
      system: this.config.systemId,
      hwid: this.config.hwid,
      version: this.config.version,
      beatrate: String(Math.floor(this.config.beatRateMs / 1000)),
      challenge,
    };
    if (this.config.programDigest) {
      form.digest = this.config.programDigest;
    }
    if (options.requestInvisibleFolderToken) {
      form['init-if'] = 'true';
    }
    if (Array.isArray(options.variables) && options.variables.length > 0) {
      form['variables[]'] = options.variables;
    }

    const httpResponse = await this.http.postForm(
      this.endpoint(this.config.baseUrl, '/auth/bedrock/init'),
      form,
      this.signedHeaders(),
    );
    if (!responseOk(httpResponse)) {
      const message = httpResponse.error
        ? `Bedrock initialization transport failed: ${httpResponse.error}`
        : `Bedrock initialization returned HTTP ${httpResponse.status}.`;
      throw fail(ErrorKind.Transport, message);
    }

    const response = this.verifySigned(httpResponse, challenge);

    const authenticatedCode = response.code === 'OK' || response.code === 'OUTDATED';
    if (response.authed !== authenticatedCode) {
      throw fail(ErrorKind.InvalidPayload, 'Bedrock authentication flags contradict the response code.');
    }

    const result = { response, sessionStarted: false };
    if (!response.authed) {
      if (Object.keys(response.variables).length > 0 || response.invisibleFolderToken !== null) {
        throw fail(ErrorKind.InvalidPayload, 'A rejected Bedrock initialization returned successful-only data.');
      }
      return result;
    }
    if (response.sessionToken === null) {
      throw fail(ErrorKind.InvalidPayload, 'Authenticated Bedrock response did not contain a session token.');
    }
    if (!response.sessionToken.startsWith('BRK_')) {
      throw fail(ErrorKind.InvalidPayload, 'Bedrock initialization returned an invalid session token format.');
    }

    const identityHash = sha256Hex(identity);
    const responseHash = keyAuthentication ? response.licenseKeyHash : response.usernameHash;
    if (responseHash !== identityHash) {
      throw fail(ErrorKind.InvalidPayload, 'Bedrock response identity hash does not match the authentication request.');
    }

    if (this.session !== null) {
      this.session.stop();
      await this.session.wait();
    }
    this.session = new BedrockSession(this, response.sessionToken, this.failureHook);
    if (this.config.automaticHeartbeats) {
      this.session.start();
    }

    if (response.invisibleFolderToken !== null) {
      this.invisibleFolder.setToken(response.invisibleFolderToken);
    }
    result.sessionStarted = true;
    return result;
  }

  /**
   * Performs one manual heartbeat. Requires a live session.
   * @param {{ requestInvisibleFolderToken?: boolean }} [options]
   */
  async heartbeatNow(options = {}) {
    if (this.session === null) {
      throw fail(ErrorKind.SessionTerminated, 'No Bedrock session is active.');
    }
    const response = await this.session.heartbeat(options);
    if (response.authed && response.invisibleFolderToken !== null) {
      this.invisibleFolder.setToken(response.invisibleFolderToken);
    }
    return response;
  }

  /**
   * Installs a hook fired once when the session first fails.
   * @param {(failure: { error: object, response: object|null, completedHeartbeats: number }) => void} hook
   */
  onHeartbeatFailure(hook) {
    this.failureHook = hook;
    if (this.session !== null) {
      this.session.setHook(hook);
    }
  }

  isAuthenticated() {
    return this.session !== null && this.session.alive;
  }

  heartbeatCount() {
    return this.session !== null ? this.session.completed : 0;
  }

  getInvisibleFolder() {
    return this.invisibleFolder;
  }

  /** Tears down any live session and clears held tokens. Idempotent. */
  async shutdown() {
    const previous = this.session;
    this.session = null;
    if (previous !== null) {
      previous.stop();
      await previous.wait();
    }
    this.invisibleFolder.clearToken();
  }
}

module.exports = { Client };
