'use strict';

const fs = require('node:fs/promises');

const { ErrorKind, fail } = require('./errors');
const { responseOk, headerOf } = require('./transport');

const DOWNLOAD_PREFIX = '/a/';
const METADATA_PREFIX = '/api/v1/files/';
const METADATA_SUFFIX = '/metadata';
const REVISIONS_KEY = '__revisions';

function validReferenceId(referenceId) {
  return typeof referenceId === 'string' &&
    referenceId.length >= 4 && referenceId.length <= 128 &&
    /^[A-Za-z0-9_-]+$/.test(referenceId);
}

function percentEncode(value) {
  return encodeURIComponent(value)
    .replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

function errorMessage(httpResponse) {
  try {
    const json = JSON.parse(httpResponse.body.toString('utf8'));
    if (typeof json.message === 'string') {
      return json.message;
    }
    if (typeof json.error === 'string') {
      return json.error;
    }
  } catch {
    // not JSON
  }
  return '';
}

function transportError(action, httpResponse) {
  if (httpResponse.error) {
    return fail(ErrorKind.Transport, `Invisible Folder ${action} failed: ${httpResponse.error}`);
  }
  return fail(ErrorKind.Transport, `Invisible Folder ${action} returned HTTP ${httpResponse.status}.`);
}

/**
 * Accesses Invisible Folder through the authenticated Bedrock session.
 * Obtain a token with requestInvisibleFolderToken during authentication or
 * a heartbeat.
 */
class InvisibleFolder {
  /** @param {import('./client').Client} client */
  constructor(client) {
    this.client = client;
    this.token = '';
  }

  setToken(token) {
    this.token = token;
  }

  clearToken() {
    this.token = '';
  }

  hasToken() {
    return this.token !== '';
  }

  checkPrerequisites(referenceId) {
    if (!this.client.config.invisibleFolderBaseUrl.startsWith('https://')) {
      throw fail(ErrorKind.Configuration, 'Invisible Folder base URL must use HTTPS.');
    }
    if (!validReferenceId(referenceId)) {
      throw fail(ErrorKind.Configuration, 'Invisible Folder reference ID must be 4 through 128 URL-safe characters.');
    }
  }

  /** Downloads a file into memory (a Buffer). */
  async download(referenceId) {
    this.checkPrerequisites(referenceId);
    if (this.token === '') {
      throw fail(ErrorKind.SessionTerminated, 'No Invisible Folder token is available. Request one during initialization or a heartbeat.');
    }

    const url = this.client.endpoint(this.client.config.invisibleFolderBaseUrl, DOWNLOAD_PREFIX) + referenceId;
    const httpResponse = await this.client.transport.postForm(url, { invisiblefolder_token: this.token }, {});
    if (!responseOk(httpResponse)) {
      const message = errorMessage(httpResponse);
      throw message !== ''
        ? fail(ErrorKind.Transport, `Invisible Folder download failed: ${message}`)
        : transportError('download', httpResponse);
    }
    return Buffer.from(httpResponse.body);
  }

  /** Downloads a file and writes it to destination (unencrypted). */
  async downloadToFile(referenceId, destination) {
    if (!destination) {
      throw fail(ErrorKind.Configuration, 'Invisible Folder download destination cannot be empty.');
    }
    const bytes = await this.download(referenceId);
    try {
      await fs.writeFile(destination, bytes, { mode: 0o600 });
    } catch {
      throw fail(ErrorKind.LocalFailure, 'Could not write Invisible Folder download destination.');
    }
    return destination;
  }

  /**
   * Fetches a file's description and metadata entries. keys selects specific
   * entries; omit for all.
   */
  async metadata(referenceId, keys = []) {
    this.checkPrerequisites(referenceId);

    const headers = {};
    if (this.client.config.invisibleFolderApiKey) {
      headers['X-Api-Key'] = this.client.config.invisibleFolderApiKey;
    }
    if (this.token !== '') {
      headers['X-Invisiblefolder-Token'] = this.token;
    }

    let url = this.client.endpoint(this.client.config.invisibleFolderBaseUrl, METADATA_PREFIX) +
      referenceId + METADATA_SUFFIX;
    if (keys.length > 0) {
      url += '?keys[]=' + keys.map(percentEncode).join('&keys[]=');
    }

    const httpResponse = await this.client.transport.get(url, headers);
    if (!responseOk(httpResponse)) {
      const message = errorMessage(httpResponse);
      throw message !== ''
        ? fail(ErrorKind.Transport, `Invisible Folder metadata request failed: ${message}`)
        : transportError('metadata request', httpResponse);
    }
    return parseMetadata(httpResponse.body.toString('utf8'));
  }

  /**
   * Downloads only when the __revisions metadata differs from
   * knownRevision. With a destination the file is written to disk; without
   * one it is returned in memory.
   */
  async downloadIfNew(referenceId, knownRevision = '', destination = '') {
    const currentMetadata = await this.metadata(referenceId, [REVISIONS_KEY]);
    const revisionEntry = currentMetadata.values[REVISIONS_KEY];
    if (revisionEntry === undefined) {
      throw fail(ErrorKind.InvalidPayload, 'Invisible Folder metadata did not contain __revisions.');
    }

    const result = { downloaded: false, revision: revisionEntry.value, metadata: currentMetadata };
    if (knownRevision !== '' && knownRevision === result.revision) {
      return result;
    }

    result.downloaded = true;
    if (destination) {
      await this.downloadToFile(referenceId, destination);
      result.destination = destination;
      return result;
    }
    result.bytes = await this.download(referenceId);
    return result;
  }
}

function parseMetadata(bodyText) {
  let json;
  try {
    json = JSON.parse(bodyText);
  } catch {
    throw fail(ErrorKind.InvalidPayload, 'Invisible Folder metadata JSON is invalid.');
  }
  const data = json?.data;
  if (data === null || typeof data !== 'object' ||
      data.file === null || typeof data.file !== 'object' ||
      data.metadata === null || typeof data.metadata !== 'object') {
    throw fail(ErrorKind.InvalidPayload, 'Invisible Folder metadata response has the wrong shape.');
  }

  const file = data.file;
  for (const name of ['id', 'reference_id', 'name', 'mime_type', 'size', 'downloads', 'uploaded_at', 'permission_type_id']) {
    if (!(name in file)) {
      throw fail(ErrorKind.InvalidPayload, `Invisible Folder file field '${name}' is missing.`);
    }
  }
  for (const name of ['id', 'reference_id', 'name', 'mime_type', 'uploaded_at']) {
    if (typeof file[name] !== 'string') {
      throw fail(ErrorKind.InvalidPayload, `Invisible Folder file field '${name}' has the wrong type.`);
    }
  }
  if (!Number.isSafeInteger(file.size) || file.size < 0 || !Number.isSafeInteger(file.downloads) ||
      !Number.isSafeInteger(file.permission_type_id)) {
    throw fail(ErrorKind.InvalidPayload, 'Invisible Folder file numeric fields have the wrong type.');
  }

  const values = {};
  for (const [key, entry] of Object.entries(data.metadata)) {
    if (entry === null || typeof entry !== 'object' || typeof entry.value !== 'string') {
      throw fail(ErrorKind.InvalidPayload, 'Invisible Folder metadata entry has the wrong type.');
    }
    const createdAt = entry.created_at ?? null;
    if (createdAt !== null && typeof createdAt !== 'string') {
      throw fail(ErrorKind.InvalidPayload, 'Invisible Folder metadata creation time has the wrong type.');
    }
    values[key] = { value: entry.value, createdAt };
  }

  return {
    file: {
      id: file.id,
      referenceId: file.reference_id,
      name: file.name,
      mimeType: file.mime_type,
      size: file.size,
      downloads: file.downloads,
      uploadedAt: file.uploaded_at,
      permissionTypeId: file.permission_type_id,
    },
    values,
  };
}

module.exports = { InvisibleFolder, validReferenceId };
