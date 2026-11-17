/* ============================================================
   Arabic dialect of a talking video, read from the words of a first transcription.
   Whisper only knows "Arabic": left alone it spells the speech the formal way ("شيء", "أن تغير") whatever was said.
   Words only one dialect uses ("هيك", "عم", "مشان" are Levantine; "وايد", "شلون" Gulf; "ازاي", "كده" Egyptian…)
   tell which one it is; a second pass then gets a short sample written in that dialect (DIALECT_HINT), so Whisper
   spells the speaker's own words ("شي", "إنه بتغير", "هلق") the way they are said.
   ============================================================ */

export type Dialect = "levantine" | "gulf" | "egyptian" | "maghrebi" | "iraqi";

export const DIALECT_NAMES: Record<Dialect, string> = {
  levantine: "Levantine Arabic (Syria, Lebanon, Jordan, Palestine)",
  gulf: "Gulf Arabic",
  egyptian: "Egyptian Arabic",
  maghrebi: "Maghrebi Arabic (Morocco, Algeria, Tunisia, Libya)",
  iraqi: "Iraqi Arabic",
};

/** Marker words, written without diacritics, prefixes stripped by `bare` (و، ف، ب) */
const MARKERS: Record<Dialect, string[]> = {
  levantine: ["هيك", "هيدا", "هيدي", "هاد", "هادا", "هاي", "شو", "ليش", "مشان", "منشان", "عشان", "بدي", "بدك", "بده", "بدنا", "هلق", "هلأ", "هلا", "كتير", "منيح", "عم", "لهيك", "قديش", "هون", "هونيك", "شي", "مو", "تبعه", "تبعي", "تبعك", "تبع", "عنا", "عندكن", "رح", "لح", "ما في", "منشان", "هيدول", "كرمال"],
  gulf: ["وايد", "شلون", "ابي", "ابغى", "ابغي", "زين", "حيل", "هني", "شنو", "جذي", "الحين", "ترى", "مب", "واجد", "ودي", "مالي", "شفيك"],
  egyptian: ["ازاي", "إزاي", "عايز", "عاوز", "كده", "كدا", "اوي", "أوي", "دلوقتي", "بتاع", "بتاعة", "بتاعي", "مش", "ايه", "إيه", "فين", "امتى", "إمتى", "خالص", "برضه", "بقى", "علشان", "ده", "دي", "دول"],
  maghrebi: ["بزاف", "واش", "كيفاش", "دابا", "نتا", "نتي", "ديال", "ديالي", "بغيت", "مزيان", "شحال", "علاش", "فين", "غادي", "راني", "راك", "برشا", "باهي", "توا", "يسر"],
  iraqi: ["شكو", "ماكو", "اكو", "أكو", "هواية", "شلونك", "هسه", "هسة", "چا", "گاع", "شبيك", "كلش", "اريد", "وياك"],
};
const ALL = new Set(Object.values(MARKERS).flat());
/** Markers several dialects share count less */
const WEIGHT = (() => {
  const n = new Map<string, number>();
  Object.values(MARKERS).forEach((l) => new Set(l).forEach((w) => n.set(w, (n.get(w) ?? 0) + 1)));
  return (w: string) => 1 / (n.get(w) ?? 1);
})();

/** A word without diacritics, tatweel and punctuation: Arabic letters only */
export function bare(t: string): string {
  return String(t || "").normalize("NFKC")
    .replace(/[ً-ٰٟـ]/g, "")
    .replace(/[^ء-غف-يٱ-ۓچڤگ]/g, "");
}
/** A marker counts as is or after one attached و / ف / ب ("وهيك", "فشو"), never by cutting a word that starts with it */
const asMarker = (t: string) => (/^[وفب]/.test(t) && !ALL.has(t) && ALL.has(t.slice(1)) ? t.slice(1) : t);

/**
 * The dialect the words are in, or null: at least 3 marker hits, and twice as many as the runner-up (a mostly formal
 * speech, or too few words, is left to Whisper's own spelling).
 */
export function detectDialect(words: { t: string }[]): { dialect: Dialect; score: number } | null {
  const toks = words.map((w) => asMarker(bare(w.t))).filter(Boolean);
  const all = new Set([...toks, ...toks.slice(1).map((t, i) => `${toks[i]} ${t}`)]); // two-word markers ("ما في")
  const count = new Map<string, number>(toks.map((t) => [t, 0]));
  toks.forEach((t) => count.set(t, (count.get(t) ?? 0) + 1));
  const scores = (Object.keys(MARKERS) as Dialect[]).map((d) => ({
    d, s: MARKERS[d].reduce((n, m) => n + (all.has(m) ? (count.get(m) ?? 1) * WEIGHT(m) : 0), 0),
  })).sort((a, b) => b.s - a.s);
  const [a, b] = scores;
  if (a.s < 3 || a.s < 2 * b.s) return null;
  return { dialect: a.d, score: Math.round(a.s * 10) / 10 };
}

/**
 * The second pass's prompt per dialect: everyday sentences in its own spelling, English terms in Latin letters
 * (Whisper copies the style of the prompt, not its words).
 */
export const DIALECT_HINT: Record<Dialect, string> = {
  levantine: "صباح الخير، شو الأخبار؟ هلق بدي احكيلكن عن شغلة كتير مهمة. مشان هيك عم قلكن، كل يوم في شي جديد بالـ marketing والـ AI، وهيدا الـ portfolio تبعي.",
  gulf: "صباح الخير، شلونكم؟ الحين أبي أكلمكم عن شي وايد مهم. ترى كل يوم فيه شي جديد بالـ marketing والـ AI، وهذا الـ portfolio مالي.",
  egyptian: "صباح الخير، عاملين إيه؟ دلوقتي عايز أكلمكم عن حاجة مهمة أوي. علشان كده كل يوم فيه حاجة جديدة في الـ marketing والـ AI، وده الـ portfolio بتاعي.",
  maghrebi: "صباح الخير، كيفاش راكم؟ دابا بغيت نهضر معاكم على حاجة مهمة بزاف. كل نهار كاين شي جديد فالـ marketing والـ AI، وهادا الـ portfolio ديالي.",
  iraqi: "صباح الخير، شلونكم؟ هسه أريد أحچي وياكم على شغلة كلش مهمة. كل يوم اكو شي جديد بالـ marketing والـ AI، وهذا الـ portfolio مالتي.",
};
