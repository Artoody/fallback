import crypto from "crypto";
import zlib from "zlib";

const VERSION = "v1";
const TOKEN_PREFIX = `gemini-state.${VERSION}.`;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const DEFAULT_MAX_PLAINTEXT_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_ENVELOPE_BYTES = 4 * 1024 * 1024;

export class StateEnvelopeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "StateEnvelopeError";
    this.code = code;
    this.status = 400;
  }
}

function decodeSecret(secret) {
  if (Buffer.isBuffer(secret)) {
    if (secret.length !== 32) throw new Error("RESPONSES_STATE_SECRET must contain exactly 32 bytes.");
    return Buffer.from(secret);
  }

  const value = String(secret || "").trim();
  if (!value) throw new Error("RESPONSES_STATE_SECRET is required to enable /v1/responses.");

  let decoded;
  if (/^[a-f0-9]{64}$/i.test(value)) {
    decoded = Buffer.from(value, "hex");
  } else {
    try {
      decoded = Buffer.from(value, "base64");
    } catch {
      decoded = Buffer.alloc(0);
    }
  }

  if (decoded.length !== 32) {
    throw new Error(
      "RESPONSES_STATE_SECRET must be 64 hexadecimal characters or base64 encoding exactly 32 bytes."
    );
  }
  return decoded;
}

function aad(clientId) {
  return Buffer.from(`artoody-fallback:responses-state:${VERSION}:${String(clientId)}`, "utf8");
}

function invalidEnvelope(code = "invalid_state_envelope") {
  return new StateEnvelopeError(code, "The encrypted reasoning state is invalid or cannot be used.");
}

export function createStateEnvelope({
  secret,
  maxPlaintextBytes = DEFAULT_MAX_PLAINTEXT_BYTES,
  maxEnvelopeBytes = DEFAULT_MAX_ENVELOPE_BYTES,
  randomBytes = crypto.randomBytes,
} = {}) {
  const key = decodeSecret(secret);

  function seal(payload, clientId) {
    if (!clientId) throw new Error("A client ID is required when sealing response state.");
    const plaintext = Buffer.from(JSON.stringify(payload), "utf8");
    if (plaintext.length > maxPlaintextBytes) {
      throw new StateEnvelopeError(
        "state_envelope_too_large",
        "The response state is too large to preserve safely."
      );
    }

    const compressed = zlib.deflateRawSync(plaintext, { level: 9 });
    const iv = randomBytes(IV_BYTES);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(aad(clientId));
    const ciphertext = Buffer.concat([cipher.update(compressed), cipher.final()]);
    const tag = cipher.getAuthTag();
    const packed = Buffer.concat([iv, tag, ciphertext]);

    if (packed.length > maxEnvelopeBytes) {
      throw new StateEnvelopeError(
        "state_envelope_too_large",
        "The response state is too large to preserve safely."
      );
    }
    return TOKEN_PREFIX + packed.toString("base64url");
  }

  function open(token, clientId) {
    if (!clientId) throw invalidEnvelope();
    const value = String(token || "");
    if (!value.startsWith("gemini-state.")) throw invalidEnvelope();
    if (!value.startsWith(TOKEN_PREFIX)) throw invalidEnvelope("unsupported_state_envelope_version");

    let packed;
    try {
      packed = Buffer.from(value.slice(TOKEN_PREFIX.length), "base64url");
    } catch {
      throw invalidEnvelope();
    }
    if (
      packed.length <= IV_BYTES + TAG_BYTES ||
      packed.length > maxEnvelopeBytes ||
      value.length > Math.ceil((maxEnvelopeBytes * 4) / 3) + TOKEN_PREFIX.length + 8
    ) {
      throw invalidEnvelope(packed.length > maxEnvelopeBytes ? "state_envelope_too_large" : undefined);
    }

    try {
      const iv = packed.subarray(0, IV_BYTES);
      const tag = packed.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
      const ciphertext = packed.subarray(IV_BYTES + TAG_BYTES);
      const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
      decipher.setAAD(aad(clientId));
      decipher.setAuthTag(tag);
      const compressed = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      const plaintext = zlib.inflateRawSync(compressed, { maxOutputLength: maxPlaintextBytes });
      const parsed = JSON.parse(plaintext.toString("utf8"));
      if (!parsed || typeof parsed !== "object" || parsed.version !== 1 || !Array.isArray(parsed.steps)) {
        throw invalidEnvelope();
      }
      return parsed;
    } catch (error) {
      if (error instanceof StateEnvelopeError) throw error;
      if (error?.code === "ERR_BUFFER_TOO_LARGE") {
        throw invalidEnvelope("state_envelope_too_large");
      }
      throw invalidEnvelope();
    }
  }

  return Object.freeze({ seal, open, version: VERSION });
}

export const stateEnvelopeConstants = Object.freeze({
  version: VERSION,
  prefix: TOKEN_PREFIX,
  maxPlaintextBytes: DEFAULT_MAX_PLAINTEXT_BYTES,
  maxEnvelopeBytes: DEFAULT_MAX_ENVELOPE_BYTES,
});
