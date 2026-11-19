// Accuracy review in the editor: the flag type of POST /ai/review-article and how a suggested rewrite goes into the HTML.
export type Flag = { quote: string; kind: "statistic" | "source" | "absolute" | "outdated" | "doubtful" | "vague"; why: string; fix: "cite" | "soften" | "remove" | "check"; rewrite?: string; by: "rules" | "ai" };
export type Review = { flags: Flag[]; ai: boolean; note?: string; model?: string };

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const reEsc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Replaces the quoted sentence in the HTML with the rewrite, once. The quote may span spaces, &nbsp; or encoded characters, but not tags:
 *  null when it can't be found as plain text (it crosses a link or bold text), so the change is left to the author. */
export function replaceQuote(html: string, quote: string, rewrite: string): string | null {
  const parts = esc(quote).split(/\s+/).filter(Boolean).map(reEsc);
  if (!parts.length) return null;
  const re = new RegExp(parts.join("(?:\\s|&nbsp;|&#160;)+"));
  const m = re.exec(html);
  if (!m) return null;
  return html.slice(0, m.index) + esc(rewrite) + html.slice(m.index + m[0].length);
}
