import crypto from "node:crypto";

/**
 * Generate a prefixed unique ID: `{prefix}:{timestamp}-{8-hex}`.
 * Used for `client_id` on outbound messages.
 */
export function generateId(prefix: string): string {
  return `${prefix}:${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
}

/** Generate an outbound message client_id. */
export function generateClientId(): string {
  return generateId("weclaw-bridge");
}

export interface Sleeper {
  (ms: number): Promise<void>;
}

/** Promise-based sleep that resolves early when the abort signal fires. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(new Error("aborted"));
      },
      { once: true },
    );
  });
}
