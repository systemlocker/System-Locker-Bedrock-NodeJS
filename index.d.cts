declare namespace Bedrock {
  type ErrorKindValue =
    | 'Configuration'
    | 'Transport'
    | 'UnsignedResponse'
    | 'InvalidSignature'
    | 'InvalidPayload'
    | 'FreshnessViolation'
    | 'SessionTerminated'
    | 'LocalFailure';

  class BedrockError extends Error {
    readonly kind: ErrorKindValue;
  }

  interface BedrockConfig {
    systemId: string;
    version?: string;
    hwid?: string;
    hwidMode?: 'legacy' | 'sl-hwid';
    slHwidStore?: string | null;
    slHwidExtraMandatory?: string[] | null;
    beatRateMs?: number;
    requestTimeoutMs?: number;
    maxServerClockSkewSeconds?: number;
    baseUrl?: string;
    invisibleFolderBaseUrl?: string;
    userAgent?: string;
    programDigest?: string | null;
    signingKeyId?: string | null;
    invisibleFolderApiKey?: string | null;
    signingPublicKey: string;
    automaticHeartbeats?: boolean;
  }

  interface HttpResponse {
    status: number;
    body: Buffer | string;
    headers: Record<string, string>;
    error?: string;
  }

  interface HTTPClient {
    postForm(url: string, form: Record<string, string | string[]>, headers?: Record<string, string>): Promise<HttpResponse>;
    get(url: string, headers?: Record<string, string>): Promise<HttpResponse>;
  }

  interface Variable {
    value: string | null;
    found: boolean;
  }

  interface Response {
    code: string | null;
    responseCode: string;
    humanResponse: string;
    isError: boolean;
    isFailure: boolean;
    authed: boolean;
    protocolVersion: string;
    system: string;
    challenge: string;
    serverTime: number;
    humanTime: string;
    sessionToken: string | null;
    licenseKeyHash: string | null;
    usernameHash: string | null;
    terminationMessage: string | null;
    invisibleFolderToken: string | null;
    variables: Record<string, Variable>;
  }

  interface InitializationOptions {
    requestInvisibleFolderToken?: boolean;
    variables?: string[];
  }

  interface HeartbeatOptions {
    requestInvisibleFolderToken?: boolean;
  }

  interface AuthenticationResult {
    response: Response;
    sessionStarted: boolean;
  }

  interface HeartbeatFailure {
    error: BedrockError;
    response: Response | null;
    completedHeartbeats: number;
  }

  interface InvisibleFolderMetadataValue {
    value: string;
    createdAt: string | null;
  }

  interface InvisibleFolderMetadata {
    file: {
      id: string;
      referenceId: string;
      name: string;
      mimeType: string;
      size: number;
      downloads: number;
      uploadedAt: string;
      permissionTypeId: number;
    };
    values: Record<string, InvisibleFolderMetadataValue>;
  }

  interface DownloadIfNewResult {
    downloaded: boolean;
    revision: string;
    metadata: InvisibleFolderMetadata;
    bytes?: Buffer;
    destination?: string;
  }

  class InvisibleFolder {
    hasToken(): boolean;
    download(referenceId: string): Promise<Buffer>;
    downloadToFile(referenceId: string, destination: string): Promise<string>;
    metadata(referenceId: string, keys?: string[]): Promise<InvisibleFolderMetadata>;
    downloadIfNew(referenceId: string, knownRevision?: string, destination?: string): Promise<DownloadIfNewResult>;
  }

  class Client {
    constructor(config?: Partial<BedrockConfig>, options?: { http?: HTTPClient; now?: () => number });
    authenticateWithKey(licenseKey: string, options?: InitializationOptions): Promise<AuthenticationResult>;
    authenticateWithPassword(username: string, password: string, options?: InitializationOptions): Promise<AuthenticationResult>;
    heartbeatNow(options?: HeartbeatOptions): Promise<Response>;
    onHeartbeatFailure(hook: (failure: HeartbeatFailure) => void): void;
    isAuthenticated(): boolean;
    heartbeatCount(): number;
    getInvisibleFolder(): InvisibleFolder;
    shutdown(): Promise<void>;
  }

  function defaultConfig(): Required<BedrockConfig>;
  function verifySignedResponse(config: BedrockConfig, httpResponse: HttpResponse, expectedChallenge: string, nowMs: number): Response;
  function parseUnsignedRevocation(config: BedrockConfig, httpResponse: HttpResponse, expectedChallenge: string, nowMs: number): Response;
}

export = Bedrock;
