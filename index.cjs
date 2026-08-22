'use strict';

const { BedrockError, ErrorKind } = require('./src/errors');
const { ResponseCode, responseCodeFromString } = require('./src/response');
const { Config, defaultConfig, validateConfig } = require('./src/config');
const { Client, InitializationOptions, HeartbeatOptions } = require('./src/client');
const { verifySignedResponse, parseUnsignedRevocation } = require('./src/verify');
const { FetchHttpClient } = require('./src/transport');
const { GOOGLE_SSO_PORTAL, googleSsoUrl, openUrl, beginGoogleSso } = require('./src/sso');

module.exports = {
  BedrockError,
  ErrorKind,
  ResponseCode,
  responseCodeFromString,
  Config,
  defaultConfig,
  validateConfig,
  Client,
  InitializationOptions,
  HeartbeatOptions,
  verifySignedResponse,
  parseUnsignedRevocation,
  FetchHttpClient,
  GOOGLE_SSO_PORTAL,
  googleSsoUrl,
  openUrl,
  beginGoogleSso,
};
