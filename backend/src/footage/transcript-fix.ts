/* ============================================================
   Transcript correction: Whisper hears the words, Claude reads the whole transcript and fixes what was misheard.
   Whisper on a noisy, mixed Arabic / English recording writes English terms in Arabic letters ("سبيس أكس" for SpaceX,
   "البرتفوليو" for portfolio) and mishears words the context makes obvious. Claude answers with fixes over numbered
   words, never a new transcript: each fix replaces words from..to (inclusive) with new text, and the new words share
   the old span's time in proportion to their length, so the captions stay on the speech.
   Pure helpers here (prompt, parsing, applying); the call is AiService.transcriptFixes, the step jobs.service.ts.
   ============================================================ */
import type { Word } from "./jobs.service";
import { Dialect, DIALECT_NAMES } from "./dialect";

export type Fix = { from: number; to: number; text: string };

/** Words per request: a 10-minute video is sent in a few parts, each with its neighbours' text for context */
export const FIX_CHUNK = 350;

export const FIX_SYSTEM = `You proofread speech-to-text captions of short social media videos. The captions must be VERBATIM: exactly the words the speaker said, in the dialect they said them, spelled correctly. The speaker usually talks Arabic (often a dialect) and mixes in English words, brand and product names, and numbers.
Reply with one JSON object only, no prose, no code fence: {"dialect":"levantine","fixes":[{"from":0,"to":1,"text":"..."}]}.
"dialect" is the variety the speaker uses: "levantine", "gulf", "egyptian", "maghrebi", "iraqi", "msa" (formal Arabic) or "other".
Each fix replaces the numbered words from..to (inclusive) with "text". Fixes never overlap and are in order. Return {"fixes":[]} when nothing needs fixing.
Words the recognizer was unsure of end with "?" in the list. A word that does not exist in Arabic or in the speaker's dialect was misheard even without "?": fix it. A real word that fits stays, "?" or not.
Fix only these two things:
1. English words, names and brands written in Arabic letters: write them as the speaker said them, in English ("سبيس أكس" -> "SpaceX"; keep an Arabic article as "الـ": "البرتفوليو" -> "الـ portfolio").
2. A word that was misheard: the replacement must SOUND like what was written (the recognizer confuses close sounds such as ق/ء/أ, ت/ط, د/ض, س/ص, ذ/ز/ظ, and splits or glues words), and the sentence must need it. Example: "رحت عالسوء" -> "رحت عالسوق".
Never:
- replace a word with another word that means something similar or "fits better" (if "الأشعة الشمسية" was heard, it stays; never "الطاقة الشمسية");
- turn dialect into formal Arabic or formal into dialect ("شي" stays "شي", "شيء" stays "شيء", "هيك" stays "هيك");
- add, remove, reorder, translate or summarize words, or change punctuation only.
When a word is clear and possible, leave it exactly as it is, even if it sounds informal or unusual.`;

/** The user message: the words to fix, numbered from `offset` (unsure ones marked "?"), the dialect, the text around them, and where a second listen heard otherwise */
export function fixPrompt(words: Word[], offset: number, before: string, after: string, lang: string | null, dialect: Dialect | null = null, alts: Fix[] = []): string {
  const list = words.map((w, k) => `${offset + k}:${w.t}${w.p < UNSURE ? "?" : ""}`).join(" ");
  const spoken = dialect ? `Spoken language: ${DIALECT_NAMES[dialect]}.\n` : lang ? `Spoken language: ${lang}.\n` : "";
  const mine = alts.filter((a) => a.from >= offset && a.to < offset + words.length);
  const second = mine.length ? `A second listen with another recognizer heard these words differently (when it is the right one, use its text as the fix):\n${mine.map((a) => `${a.from}-${a.to}: ${a.text}`).join("\n")}\n` : "";
  return `${spoken}${before ? `Context before (do not fix): ${before}\n` : ""}Words to check:\n${list}\n${second}${after ? `Context after (do not fix): ${after}\n` : ""}`;
}

/**
 * Where a second transcription of the same audio heard other words: the spans of `main` (from..to) whose words differ
 * from `other`'s at the same place, with `other`'s text. Words are matched by their letters (an LCS over the words
 * without diacritics or punctuation); a span only one side has (a word missed) is left out.
 */
export function alternatives(main: Word[], other: Word[]): Fix[] {
  const key = (w: Word) => w.t.normalize("NFKC").replace(/[\u064B-\u065F\u0670\u0640]/g, "").replace(/[\p{P}\p{S}]/gu, "").toLowerCase();
  const a = main.map(key), b = other.map(key), n = a.length, m = b.length;
  const L = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out: Fix[] = [];
  let i = 0, j = 0, i0 = 0, j0 = 0;
  const gap = () => { if (i > i0 && j > j0 && i - i0 <= 6) out.push({ from: i0, to: i - 1, text: other.slice(j0, j).map((w) => w.t).join(" ") }); };
  while (i < n && j < m) {
    if (a[i] === b[j]) { gap(); i++; j++; i0 = i; j0 = j; }
    else if (L[i + 1][j] >= L[i][j + 1]) i++;
    else j++;
  }
  i = n; j = m; gap();
  return out;
}

/** Whisper's word confidence under which a word counts as unsure */
export const UNSURE = 0.6;

/* ---- the verbatim guard: a fix must sound like what was heard ---- */
/** Arabic sound classes the recognizer confuses (Levantine and Egyptian say ق as ء, and so on) */
const SOUND: Record<string, string> = {};
([["اأإآءئؤق", "A"], ["ىي", "y"], ["ةه", "h"], ["تط", "t"], ["دض", "d"], ["ذزظ", "z"], ["سصث", "s"], ["كگ", "k"], ["جچ", "j"]] as const)
  .forEach(([letters, c]) => [...letters].forEach((l) => (SOUND[l] = c)));
/** The sounds of Arabic text: letters only (no diacritics, tatweel, spaces or punctuation), confusable letters as one */
export function soundOf(text: string): string {
  return [...String(text).normalize("NFKC").replace(/[ً-ٰٟـ]/g, "")]
    .filter((ch) => /[ء-يٱ-ۓچگ]/.test(ch)).map((ch) => SOUND[ch] ?? ch).join("");
}
function distance(a: string, b: string): number {
  const d = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = d[0]; d[0] = i;
    for (let j = 1; j <= b.length; j++) { const t = d[j]; d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = t; }
  }
  return d[b.length];
}
/**
 * Whether a fix keeps the captions verbatim: an English term for Arabic letters (at most 3 words), or a word that sounds
 * like what was heard: a confident word (Whisper ≥ UNSURE) may only change by one sound (a spelling fix), an unsure
 * one by up to a third of its sounds. A synonym ("الأشعة" -> "الطاقة") never passes.
 */
export function verbatim(span: Word[], text: string): boolean {
  const heard = span.map((w) => w.t).join(" ");
  if (/[A-Za-z]/.test(text)) {
    if (/[A-Za-z]/.test(heard)) return distance(heard.toLowerCase(), text.toLowerCase()) <= 2; // an English word respelled
    // Arabic letters -> English: the consonants must match ("سبيس أكس" ~ "SpaceX"), so it can't be a translation
    if (span.length > 3) return false;
    const a = consonantsAr(heard), b = consonantsEn(text);
    return !!a && !!b && distance(a, b) <= Math.max(1, Math.round(Math.max(a.length, b.length) * 0.4));
  }
  const a = soundOf(heard), b = soundOf(text);
  if (!a || !b) return false;
  const dist = distance(a, b), sure = span.every((w) => w.p >= UNSURE);
  return sure ? dist <= 1 : dist <= Math.max(1, Math.round(Math.max(a.length, b.length) / 3));
}
/** Consonants of an English term as an Arabic speaker writes them (p as b, v as f, c as s or k, x as ks; vowels dropped) */
export function consonantsEn(text: string): string {
  const t = String(text).toLowerCase().replace(/[^a-z]/g, "");
  let out = "";
  for (let i = 0; i < t.length; i++) {
    const c = t[i], n = t[i + 1] ?? "";
    if ("aeiouy".includes(c) || (c === "h" && "cstpg".includes(t[i - 1] ?? ""))) continue;
    if (c === t[i - 1]) continue; // doubled letters
    out += c === "c" ? ("eiy".includes(n) ? "s" : "k") : c === "x" ? "ks" : c === "q" ? "k" : ({ p: "b", v: "f", g: "j" } as Record<string, string>)[c] ?? c;
  }
  return out;
}
/** Consonants of Arabic letters written for an English term: the article (الـ / ال) and long vowels dropped */
export function consonantsAr(text: string): string {
  const MAP: Record<string, string> = { "ب": "b", "پ": "b", "ت": "t", "ط": "t", "ث": "s", "س": "s", "ص": "s", "ج": "j", "چ": "j", "ك": "k", "ق": "k", "گ": "j", "د": "d", "ض": "d", "ذ": "z", "ز": "z", "ظ": "z", "ر": "r", "ش": "sh", "ف": "f", "ڤ": "f", "ل": "l", "م": "m", "ن": "n", "ه": "h", "ة": "", "ح": "h", "خ": "k", "غ": "j", "ع": "" };
  return String(text).split(/\s+/).map((w) => w.normalize("NFKC").replace(/[\u064B-\u065F\u0670\u0640]/g, "").replace(/^(ال|وال|بال)/, ""))
    .join("").split("").map((ch) => MAP[ch] ?? "").join("");
}
/**
 * The fixes that pass the verbatim guard. A fix that takes the second listen's text for that span (`alts`) passes too:
 * those words were heard, by the other recognizer.
 */
export const guardFixes = (words: Word[], fixes: Fix[], alts: Fix[] = []) => {
  const plain = (t: string) => t.replace(/[\p{P}\p{S}\s]/gu, "");
  return fixes.filter((f) => verbatim(words.slice(f.from, f.to + 1), f.text) || alts.some((a) => a.from === f.from && a.to === f.to && plain(a.text) === plain(f.text)));
};

/** Claude's fixes, kept only when well formed, inside [lo, hi], in order and apart, with some text */
export function parseFixes(raw: any, lo: number, hi: number): Fix[] {
  const list = Array.isArray(raw?.fixes) ? raw.fixes : [];
  const out: Fix[] = [];
  let next = lo;
  for (const f of list) {
    const from = Number(f?.from), to = Number(f?.to), text = String(f?.text ?? "").replace(/\s+/g, " ").trim();
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < next || to < from || to > hi || !text || text.length > 200) continue;
    if (to - from > 8) continue; // a fix rewrites a phrase, never a sentence
    out.push({ from, to, text });
    next = to + 1;
  }
  return out;
}

/**
 * The words with the fixes applied. The new words of a fix split the old span's time by their length (at least 1 ms
 * each); their confidence is the lowest of the words they replace.
 */
export function applyFixes(words: Word[], fixes: Fix[]): Word[] {
  if (!fixes.length) return words;
  const out: Word[] = [];
  let i = 0;
  for (const f of fixes) {
    if (f.from < i || f.to >= words.length) continue;
    out.push(...words.slice(i, f.from));
    const span = words.slice(f.from, f.to + 1), s = span[0].s, e = Math.max(s + 1, span[span.length - 1].e);
    const toks = f.text.split(" ").filter(Boolean), len = toks.reduce((n, t) => n + t.length, 0) || 1;
    const p = Math.min(...span.map((w) => w.p));
    let t = s, acc = 0;
    toks.forEach((tok, k) => {
      acc += tok.length;
      const end = k === toks.length - 1 ? e : Math.max(t + 1, Math.round(s + ((e - s) * acc) / len));
      out.push({ t: tok, s: t, e: end, p });
      t = end;
    });
    i = f.to + 1;
  }
  out.push(...words.slice(i));
  return out;
}
