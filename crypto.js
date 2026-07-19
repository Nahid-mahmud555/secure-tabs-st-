/**
 * crypto.js
 *
 * All cryptographic primitives for Session Vault, built entirely on the
 * native Web Crypto API (SubtleCrypto). No third-party crypto libraries
 * are used, so there is nothing here that phones home or ships an opaque
 * dependency.
 *
 * Design:
 *   - Master password -> PBKDF2-HMAC-SHA256 (high iteration count) -> AES-256-GCM key
 *   - Every encrypted blob gets a fresh random 96-bit IV (required for GCM safety)
 *   - A random "verifier" is encrypted at vault-creation time and re-decrypted
 *     on unlock to confirm the password is correct, without ever storing the
 *     password itself.
 */

export const PBKDF2_ITERATIONS = 250_000;
const SALT_BYTES = 16;
const IV_BYTES = 12; // 96-bit IV, recommended size for AES-GCM
const KEY_LENGTH = 256;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

// ---------- encoding helpers ----------

export function bufToBase64(buf) {
  const bytes = buf instanceof ArrayBuffer ? new Uint8Array(buf) : buf;
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

export function base64ToBuf(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function randomBytes(len) {
  return crypto.getRandomValues(new Uint8Array(len));
}

export function generateSaltBase64() {
  return bufToBase64(randomBytes(SALT_BYTES));
}

// ---------- key derivation ----------

/**
 * Derives an AES-GCM CryptoKey from a password + salt using PBKDF2.
 * The key is marked extractable so it can be cached (raw bytes) in
 * chrome.storage.session for the duration of an unlocked session —
 * never written to disk.
 */
export async function deriveKey(password, saltBase64, iterations = PBKDF2_ITERATIONS) {
  const salt = base64ToBuf(saltBase64);
  const baseKey = await crypto.subtle.importKey(
    "raw",
    textEncoder.encode(password),
    "PBKDF2",
    false,
    ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    baseKey,
    { name: "AES-GCM", length: KEY_LENGTH },
    true,
    ["encrypt", "decrypt"]
  );
}

export async function exportKeyRaw(cryptoKey) {
  const raw = await crypto.subtle.exportKey("raw", cryptoKey);
  return bufToBase64(raw);
}

export async function importKeyRaw(rawBase64) {
  const raw = base64ToBuf(rawBase64);
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM", length: KEY_LENGTH }, false, [
    "encrypt",
    "decrypt",
  ]);
}

// ---------- encrypt / decrypt ----------

/** Encrypts a JSON-serializable value. Returns { iv, data } as base64 strings. */
export async function encryptJSON(cryptoKey, value) {
  const iv = randomBytes(IV_BYTES);
  const plaintext = textEncoder.encode(JSON.stringify(value));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, cryptoKey, plaintext);
  return { iv: bufToBase64(iv), data: bufToBase64(ciphertext) };
}

/** Decrypts a payload produced by encryptJSON. Throws if the key/password is wrong. */
export async function decryptJSON(cryptoKey, payload) {
  const iv = base64ToBuf(payload.iv);
  const data = base64ToBuf(payload.data);
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, cryptoKey, data);
  return JSON.parse(textDecoder.decode(plaintext));
}

export function generateVerifierSecret() {
  return bufToBase64(randomBytes(32));
}
