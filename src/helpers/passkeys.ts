// Passkeys between the service and the browser (S3): the service speaks
// webauthn-rs's JSON, with every buffer as base64url; `navigator.credentials`
// wants ArrayBuffers, and answers with them. As intergate's
// `ui/lib/passkeys.js`. See RECORD/2026-08-11.musikmatch-rust-migration.WIP.md
// (2026-11-09, 11:20).

/** base64url (with or without padding) to bytes. */
export function fromBase64Url(text: string): ArrayBuffer {
  const base64 = text.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let at = 0; at < binary.length; at += 1) {
    bytes[at] = binary.charCodeAt(at);
  }
  return bytes.buffer;
}

/** Bytes to base64url, unpadded. */
export function toBase64Url(buffer: ArrayBuffer | ArrayBufferView): string {
  const bytes = buffer instanceof ArrayBuffer ? new Uint8Array(buffer) : new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

type Descriptor = { id: string; type: string; transports?: string[] };
type JsonOptions = { publicKey: Record<string, unknown> & { challenge: string } };

const descriptors = (list: unknown): { id: ArrayBuffer; type: string; transports?: string[] }[] =>
  ((list as Descriptor[] | undefined) ?? []).map((descriptor) => ({ ...descriptor, id: fromBase64Url(descriptor.id) }));

/** The service's registration options, for `navigator.credentials.create({ publicKey })`. */
export function creationOptions(options: JsonOptions): Record<string, unknown> {
  const publicKey = options.publicKey as JsonOptions["publicKey"] & { user: { id: string } };
  return {
    ...publicKey,
    challenge: fromBase64Url(publicKey.challenge),
    user: { ...publicKey.user, id: fromBase64Url(publicKey.user.id) },
    excludeCredentials: descriptors(publicKey.excludeCredentials)
  };
}

/** The service's sign-in options, for `navigator.credentials.get({ publicKey })`. */
export function requestOptions(options: JsonOptions): Record<string, unknown> {
  const publicKey = options.publicKey;
  return {
    ...publicKey,
    challenge: fromBase64Url(publicKey.challenge),
    allowCredentials: descriptors(publicKey.allowCredentials)
  };
}

/** What a credential carries, as the browser gives it. */
export type BrowserCredential = {
  id: string;
  rawId: ArrayBuffer;
  type: string;
  response: {
    clientDataJSON: ArrayBuffer;
    attestationObject?: ArrayBuffer;
    getTransports?: () => string[];
    authenticatorData?: ArrayBuffer;
    signature?: ArrayBuffer;
    userHandle?: ArrayBuffer | null;
  };
  getClientExtensionResults?: () => Record<string, unknown>;
};

/** A credential the browser made or used, as the service reads it. */
export function credentialJson(credential: BrowserCredential): Record<string, unknown> {
  const answer = credential.response;
  const response: Record<string, unknown> = { clientDataJSON: toBase64Url(answer.clientDataJSON) };
  if (answer.attestationObject) {
    response.attestationObject = toBase64Url(answer.attestationObject);
    if (answer.getTransports) response.transports = answer.getTransports();
  } else {
    if (answer.authenticatorData) response.authenticatorData = toBase64Url(answer.authenticatorData);
    if (answer.signature) response.signature = toBase64Url(answer.signature);
    if (answer.userHandle) response.userHandle = toBase64Url(answer.userHandle);
  }
  return {
    id: credential.id,
    rawId: toBase64Url(credential.rawId),
    type: credential.type,
    response,
    extensions: credential.getClientExtensionResults?.() ?? {}
  };
}

/** Why a passkey ceremony failed, as a message key; "" when the person cancelled it. */
export function passkeyProblem(error: unknown): "" | "account.passkeyClosed" | "account.passkeyHere" | "account.passkeySecure" | "account.passkeyFailed" {
  const name = (error as { name?: string } | null)?.name;
  if (!error || name === "AbortError") return "";
  if (name === "NotAllowedError") return "account.passkeyClosed";
  if (name === "InvalidStateError") return "account.passkeyHere";
  if (name === "SecurityError") return "account.passkeySecure";
  return "account.passkeyFailed";
}
