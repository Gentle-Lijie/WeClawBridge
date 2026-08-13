/**
 * Outbound text helpers: chunk overlong messages so they stay readable in WeChat
 * (full headless image rendering is intentionally not pulled in — it'd add a
 * heavy browser dep for a bridge that prides itself on zero native deps).
 *
 * WeChat truncates very long messages; we split on paragraph/line boundaries
 * into chunks under the limit and let the caller send each in order.
 */

export const WECHAT_TEXT_CHUNK_LIMIT = 1800;

/** Split `text` into chunks each ≤ limit, preferring line boundaries. */
export function chunkText(text: string, limit = WECHAT_TEXT_CHUNK_LIMIT): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  const lines = text.split("\n");
  let cur = "";
  for (const line of lines) {
    if ((cur + "\n" + line).length > limit) {
      if (cur) chunks.push(cur);
      // line itself longer than limit → hard-split
      if (line.length > limit) {
        for (let i = 0; i < line.length; i += limit) chunks.push(line.slice(i, i + limit));
        cur = "";
      } else {
        cur = line;
      }
    } else {
      cur = cur ? `${cur}\n${line}` : line;
    }
  }
  if (cur) chunks.push(cur);
  return chunks;
}
