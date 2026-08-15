'use strict';

const { performance } = require('node:perf_hooks');

const { ErrorKind, fail } = require('./errors');
const { generateChallenge } = require('./verify');
const { responseOk } = require('./transport');

const CLOCK_JUMP_TOLERANCE_MS = 2_000;

/**
 * One authenticated Bedrock session: rotating token, background heartbeat
 * loop (setTimeout-chained, one beat in flight at a time), and local clock
 * tamper detection.
 */
class BedrockSession {
  /**
   * @param {import('./client').Client} client
   * @param {string} token
   * @param {Function} hook
   */
  constructor(client, token, hook) {
    this.client = client;
    this.token = token;
    this.hook = hook;
    this.completed = 0;
    this.alive = true;
    this.stopped = false;
    this.requestChain = Promise.resolve();
    this.timer = null;
    this.loopDone = null;
  }

  start() {
    this.loopDone = this.run();
  }

  stop() {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    this.alive = false;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  async wait() {
    if (this.loopDone !== null) {
      await this.loopDone;
    }
  }

  setHook(hook) {
    this.hook = hook;
  }

  fail(error, response = null) {
    const wasAlive = this.alive;
    this.stop();
    this.alive = false;
    if (!wasAlive) {
      return;
    }
    if (typeof this.hook === 'function') {
      try {
        this.hook({ error, response, completedHeartbeats: this.completed });
      } catch {
        // a throwing user hook must not break the session machinery
      }
    }
  }

  async run() {
    let previousMonotonicMs = performance.now();
    let previousWallMs = Date.now();

    while (!this.stopped) {
      await new Promise((resolve) => {
        this.timer = setTimeout(resolve, this.client.config.beatRateMs);
      });
      this.timer = null;
      if (this.stopped) {
        return;
      }

      const monotonicMs = performance.now();
      const wallMs = Date.now();
      const monotonicElapsed = monotonicMs - previousMonotonicMs;
      const wallElapsed = wallMs - previousWallMs;
      previousMonotonicMs = monotonicMs;
      previousWallMs = wallMs;
      if (Math.abs(monotonicElapsed - wallElapsed) > CLOCK_JUMP_TOLERANCE_MS) {
        this.fail(fail(ErrorKind.LocalFailure, 'Local clock changed unexpectedly during a Bedrock session.'));
        return;
      }

      try {
        await this.heartbeat({});
      } catch {
        return; // fail() already ran through the heartbeat error paths
      }
      if (!this.alive) {
        return;
      }
    }
  }

  /**
   * One beat: challenge, POST (one transport retry), verification, token
   * rotation. Serialized against concurrent heartbeatNow() calls.
   */
  heartbeat(options) {
    const attempt = () => this._heartbeatOnce(options);
    const result = this.requestChain.then(attempt, attempt);
    // Keep the chain alive even when a beat throws.
    this.requestChain = result.then(() => undefined, () => undefined);
    return result;
  }

  async _heartbeatOnce(options) {
    if (!this.alive) {
      throw fail(ErrorKind.SessionTerminated, 'Bedrock session is not active.');
    }

    const challenge = generateChallenge();
    const form = {
      session_token: this.token,
      system: this.client.config.systemId,
      challenge,
    };
    if (options && options.requestInvisibleFolderToken) {
      form['init-if'] = 'true';
    }

    const url = this.client.endpoint(this.client.config.baseUrl, '/auth/bedrock/beat');
    let httpResponse = await this.client.transport.postForm(url, form, this.client.signedHeaders());
    // A transport failure may mean the server committed the rotation but the
    // response was lost. Repeat the exact token/challenge once so Bedrock
    // can return its cached signed response.
    if (httpResponse.error) {
      httpResponse = await this.client.transport.postForm(url, form, this.client.signedHeaders());
    }

    if (!responseOk(httpResponse)) {
      const message = httpResponse.error
        ? `Bedrock heartbeat transport failed: ${httpResponse.error}`
        : `Bedrock heartbeat returned HTTP ${httpResponse.status}.`;
      const error = fail(ErrorKind.Transport, message);
      this.fail(error);
      throw error;
    }

    let response;
    try {
      response = this.client.verifySigned(httpResponse, challenge);
    } catch (error) {
      if (error.kind === ErrorKind.UnsignedResponse) {
        try {
          response = this.client.parseUnsigned(httpResponse, challenge);
        } catch (revocationError) {
          this.fail(revocationError);
          throw revocationError;
        }
      } else {
        this.fail(error);
        throw error;
      }
    }

    if (response.code !== 'OK' || !response.authed || response.sessionToken === null) {
      const error = fail(
        ErrorKind.SessionTerminated,
        response.terminationMessage ?? response.humanResponse,
      );
      this.fail(error, response);
      return response;
    }
    if (!response.sessionToken.startsWith('BRF_')) {
      const error = fail(ErrorKind.InvalidPayload, 'Bedrock heartbeat returned an invalid rotated token format.');
      this.fail(error);
      throw error;
    }

    this.token = response.sessionToken;
    this.completed += 1;
    return response;
  }
}

module.exports = { BedrockSession };
