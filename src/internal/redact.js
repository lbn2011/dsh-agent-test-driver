/**
 * Bounded, redacted renderings shared by every model-facing string this plugin
 * produces.
 *
 * Why this module exists: a tool result is durable model context. Anything this
 * plugin echoes — an argument, an error message, a loader entry name — is data
 * the model may quote back, and a same-process plugin has no way to know what a
 * stranger's string contains. So every echo goes through two independent gates:
 * pattern redaction first (secrets), then a hard length bound.
 *
 * Nothing here is a security boundary on its own. It reduces accidental
 * disclosure; it does not sandbox the process and cannot detect a secret that
 * matches none of the patterns below.
 *
 * @module dsh-agent-test-driver/internal/redact
 */

/** Marker substituted for a value removed by pattern redaction. */
export const REDACTED = '[redacted]';

/**
 * Secret-shaped substrings removed from any text this plugin echoes.
 *
 * Deliberately broad: a false positive costs one obscured word in a status
 * line, a false negative puts a credential in the durable transcript.
 */
const SECRET_PATTERNS = Object.freeze([
  // eslint-disable-next-line no-control-regex
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{8,}/g, // vendor-style API keys
  /\bgh[pousr]_[A-Za-z0-9]{16,}/g, // GitHub tokens
  /\bxox[abpr]-[A-Za-z0-9-]{8,}/g, // Slack tokens
  /\bAKIA[0-9A-Z]{12,}/g, // AWS access key ids
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, // JWTs
  /\bBearer\s+[A-Za-z0-9._~+/-]{8,}=*/gi, // bearer credentials
  /\b(?:api[_-]?key|secret|token|password|passwd|pwd|credential|authorization)\b\s*[:=]\s*\S+/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@]+:[^\s/@]+@/gi, // credentials inside a URL authority
]);

/** Control characters (including NUL, ESC and newline) collapsed to one space. */
const CONTROL = /[\u0000-\u001f\u007f-\u009f]+/g;

/**
 * Apply secret-pattern redaction only. Does not bound the length.
 * @param {string} text
 * @returns {string}
 */
export function redactSecrets(text) {
  let out = String(text);
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, REDACTED);
  return out;
}

/**
 * Collapse control characters and bound one line of text.
 *
 * @param {unknown} value Anything; non-strings are coerced through `String()`.
 * @param {number} maxLength Positive integer cap, applied after truncation of `value`.
 * @returns {string} A single-line, secret-redacted, length-bounded string.
 */
export function boundedText(value, maxLength) {
  const limit = positiveInteger(maxLength, 'maxLength');
  const raw = typeof value === 'string' ? value : String(value ?? '');
  const oneLine = redactSecrets(raw).replace(CONTROL, ' ').trim();
  // Slice by code point so a surrogate pair is never split into a lone half.
  const points = Array.from(oneLine);
  if (points.length <= limit) return oneLine;
  return `${points.slice(0, Math.max(0, limit - 1)).join('')}…`;
}

/**
 * Render one count with its noun, without a plural library.
 * @param {number} count
 * @param {string} singular
 * @param {string} [plural]
 * @returns {string}
 */
export function countLabel(count, singular, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

/**
 * Assert a positive safe integer, returning it.
 *
 * Refusing here rather than clamping matters: a caller that passes a zero or
 * negative cap has a bug, and silently substituting a default would hide the
 * misconfiguration behind output that looks bounded.
 *
 * @param {unknown} value
 * @param {string} label
 * @returns {number}
 */
export function positiveInteger(value, label) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  return value;
}
