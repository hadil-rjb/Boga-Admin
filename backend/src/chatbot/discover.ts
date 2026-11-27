/** Retrouve l'adresse du serveur chatbot à partir du site où le widget est installé.
 *  Le widget est chargé soit par une balise <script src="https://serveur/widget/uxboga-chat.js">,
 *  soit par le composant de code Framer « UXBogaChat » (prop apiUrl). On lit le HTML puis les scripts de la page. */

const clean = (u: string) => u.trim().replace(/\/+$/, "").replace(/\/api(\/admin)?$/, "");

/** « uxboga.com », « https://www.uxboga.com/blog » → https://uxboga.com (origine seule) */
export function normalizeWebsite(input: string): { origin: string; host: string } {
  let s = input.trim();
  if (!s) throw new Error("Enter your website, e.g. uxboga.com");
  if (!/^https?:\/\//i.test(s)) s = "https://" + s;
  let u: URL;
  try { u = new URL(s); } catch { throw new Error("This doesn't look like a website address. Try uxboga.com"); }
  if (!/^https?:$/.test(u.protocol) || !u.hostname.includes(".") && u.hostname !== "localhost") throw new Error("This doesn't look like a website address. Try uxboga.com");
  return { origin: u.origin, host: u.host.replace(/^www\./, "") };
}

/** Adresses de serveur chatbot trouvées dans un texte (HTML ou JS), dans l'ordre de confiance */
export function findServers(text: string): string[] {
  const out: string[] = [];
  const add = (u?: string) => { if (u && /^https?:\/\//.test(u)) { const c = clean(u); if (!out.includes(c)) out.push(c); } };
  for (const m of text.matchAll(/(https?:\/\/[^\s"'<>`()]+?)\/widget\/uxbo(?:g|ğ|%C4%9F)a-chat\.js/gi)) add(m[1]);
  for (const m of text.matchAll(/data-api-url\s*=\s*["'](https?:\/\/[^"']+)["']/gi)) add(m[1]);
  for (const m of text.matchAll(/UXBo(?:g|ğ)aChatConfig[\s\S]{0,600}?apiUrl["']?\s*:\s*["'](https?:\/\/[^"']+)["']/gi)) add(m[1]);
  // composant de code Framer : la prop apiUrl n'est fiable que si le fichier parle bien du widget
  if (/UXBo(?:g|ğ)aChat|uxbo(?:g|ğ)a-chat/i.test(text)) for (const m of text.matchAll(/apiUrl["']?\s*:\s*["'](https?:\/\/[^"']+)["']/g)) add(m[1]);
  return out;
}

/** Scripts chargés par la page (balises <script src> et modulepreload), en adresses absolues */
export function scriptUrls(html: string, base: string, limit = 40): string[] {
  const out: string[] = [];
  const re = /<(?:script[^>]+src|link[^>]+rel=["']?modulepreload["']?[^>]+href|link[^>]+href)\s*=\s*["']([^"']+\.m?js(?:\?[^"']*)?)["']/gi;
  for (const m of html.matchAll(re)) {
    try { const u = new URL(m[1], base).href; if (/^https?:/.test(u) && !out.includes(u)) out.push(u); } catch { /* ignoré */ }
    if (out.length >= limit) break;
  }
  return out;
}

/** Modules importés par un script (chunks chargés plus tard par Framer) */
export function importUrls(js: string, base: string, limit = 40): string[] {
  const out: string[] = [];
  for (const m of js.matchAll(/["'`]((?:https?:\/\/|\.{1,2}\/)[^"'`\s]+\.m?js)["'`]/g)) {
    try { const u = new URL(m[1], base).href; if (!out.includes(u)) out.push(u); } catch { /* ignoré */ }
    if (out.length >= limit) break;
  }
  return out;
}
