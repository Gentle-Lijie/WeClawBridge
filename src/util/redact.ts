/**
 * Outbound redaction — scrub secrets before text leaves the bridge.
 *
 * WeChat is an external channel: anything pushed to it lands in a chat history
 * the bridge can't recall. This module rewrites common credential shapes out of
 * outbound text so a careless `cat .env` or a token-bearing stack trace doesn't
 * leak. It is deliberately conservative: match high-signal patterns, mark with
 * the detected kind, and never mutate content it isn't sure about.
 */

export interface RedactionResult {
  text: string;
  /** number of redactions applied */
  count: number;
  /** kinds命中, for logging */
  kinds: string[];
}

export interface RedactionOptions {
  /** disable redaction entirely (e.g. trusted local caller) */
  enabled?: boolean;
  /** custom additional patterns; each is a regex, replaced with its label */
  extra?: { pattern: RegExp; label: string }[];
}

interface Rule {
  name: string;
  pattern: RegExp;
}

const DEFAULT_RULES: Rule[] = [
  // PEM private key blocks (multi-line) — highest priority.
  {
    name: "private_key",
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  },
  // AWS access key id
  { name: "aws_key", pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  // AWS secret (40-char base64-ish after an = or "secret")
  { name: "aws_secret", pattern: /\b(?:aws_secret_access_key|secret_access_key)["'\s:=]+([A-Za-z0-9/+=]{40})\b/g },
  // GitHub tokens
  { name: "github_token", pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/g },
  // OpenAI / common "sk-" style keys
  { name: "openai_key", pattern: /\bsk-[A-Za-z0-9]{20,}\b/g },
  // Generic Bearer tokens in headers
  { name: "bearer", pattern: /\bBearer\s+[A-Za-z0-9._\-]{20,}/gi },
  // Slack tokens
  { name: "slack", pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  // Google API keys
  { name: "google_api", pattern: /\bAIza[0-9A-Za-z_\-]{35}\b/g },
  // Generic password/secret/token assignment: (password|secret|token|passwd|apikey)["': =]+<value>
  {
    name: "secret_assign",
    pattern:
      /\b(?:password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret)["'\s]*[:=]["'\s]*([^\s"'`,;]{8,})/gi,
  },
];

const MASK = "***REDACTED";

function applyRule(text: string, rule: Rule): { text: string; hits: number } {
  let hits = 0;
  const out = text.replace(rule.pattern, (...args) => {
    hits += 1;
    // For capture-group rules (aws_secret, secret_assign), only the captured secret
    // is masked; the key name is preserved. Detected by a non-undefined group 1.
    const full = args[0] as string;
    const group1 = args[1] as string | undefined;
    if (group1) {
      return full.replace(group1, MASK);
    }
    return `[${rule.name}:${MASK}]`;
  });
  return { text: out, hits };
}

/** Redact secrets from `text`. Returns the scrubbed text + a count. */
export function redact(text: string, opts: RedactionOptions = {}): RedactionResult {
  if (opts.enabled === false) return { text, count: 0, kinds: [] };
  let out = text;
  let count = 0;
  const kinds: string[] = [];
  for (const rule of DEFAULT_RULES) {
    const r = applyRule(out, rule);
    if (r.hits > 0) {
      out = r.text;
      count += r.hits;
      kinds.push(`${rule.name}×${r.hits}`);
    }
  }
  for (const extra of opts.extra ?? []) {
    const before = out;
    out = out.replace(extra.pattern, extra.label);
    if (out !== before) {
      count += 1;
      kinds.push(extra.label);
    }
  }
  return { text: out, count, kinds };
}

/** True if the text contains at least one recognizable secret pattern. */
export function looksSensitive(text: string): boolean {
  return redact(text).count > 0;
}
