/** Page d'aperçu du widget, servie par l'API (origine différente de l'admin : le script du widget n'a pas accès au jeton).
 *  Le script n'est chargé que depuis l'URL du serveur chatbot enregistrée ; l'apparence arrive par le hash (#…), en données JSON uniquement. */
export function previewPage(apiUrl: string) {
  const base = JSON.stringify(apiUrl).replace(/</g, "\\u003c");
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Widget preview</title>
<style>
*{box-sizing:border-box}body{margin:0;min-height:100vh;background:var(--bg);font-family:Inter,system-ui,sans-serif;color:var(--ink)}
.nav{display:flex;align-items:center;gap:10px;padding:16px 22px}.logo{width:26px;height:26px;border-radius:8px;background:var(--accent)}
.nav b{font-size:14px}.links{margin-left:auto;display:flex;gap:14px}.links i,.bar{display:block;height:8px;border-radius:9px;background:var(--card)}
.links i{width:44px}.hero{padding:42px 22px 0;max-width:640px}.hero h1{font-size:30px;line-height:1.15;margin:0 0 14px;letter-spacing:-.02em}
.bar{margin:10px 0}.btn{display:inline-block;margin-top:18px;padding:10px 16px;border-radius:10px;background:var(--accent);color:#fff;font-size:13px;font-weight:600}
.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;padding:34px 22px}.grid div{height:110px;border-radius:14px;background:var(--card)}
.msg{position:fixed;left:16px;right:16px;bottom:16px;padding:12px 14px;border-radius:12px;background:#fee2e2;color:#991b1b;font-size:13px}
@media(max-width:520px){.links{display:none}.grid{grid-template-columns:1fr}.hero h1{font-size:24px}}
</style></head><body>
<div class="nav"><span class="logo"></span><b>Your website</b><span class="links"><i></i><i></i><i></i></span></div>
<div class="hero"><h1>Design that grows fintech products</h1><span class="bar" style="width:92%"></span><span class="bar" style="width:70%"></span><span class="btn">Book a call</span></div>
<div class="grid"><div></div><div></div><div></div></div>
<script>
(function () {
  var base = ${base}, p = {};
  try { p = JSON.parse(decodeURIComponent(location.hash.slice(1))) || {}; } catch (e) {}
  var c = p.c && typeof p.c === "object" ? p.c : {}, dark = !!p.dark;
  var hex = /^#[0-9a-fA-F]{6}$/.test(c.accentColor) ? c.accentColor : "#fd0e35";
  var r = document.documentElement.style;
  r.setProperty("--bg", dark ? "#0b1220" : "#f8fafc"); r.setProperty("--card", dark ? "#1e293b" : "#e2e8f0"); r.setProperty("--ink", dark ? "#f8fafc" : "#0f172a"); r.setProperty("--accent", hex);
  var say = function (s) { try { parent.postMessage({ uxbPreview: s }, "*"); } catch (e) {} };
  var fail = function (t) { var d = document.createElement("div"); d.className = "msg"; d.textContent = t; document.body.appendChild(d); say("error"); };
  if (!base) return fail("Connect the chatbot server to preview the widget.");
  window.UXBogaChatConfig = Object.assign({}, c, { apiUrl: base });
  var s = document.createElement("script");
  s.src = base + "/widget/uxboga-chat.js"; s.defer = true;
  s.onload = function () { say("ready"); }; s.onerror = function () { fail("The widget script could not be loaded from " + base + "/widget/uxboga-chat.js"); };
  document.body.appendChild(s);
})();
</script>
</body></html>`;
}
