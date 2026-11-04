const API = (process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000/api").replace(/\/+$/, "");
export const getToken = () => (typeof window === "undefined" ? null : localStorage.getItem("uxb.token"));
/** Jeton du lien « Anyone with the link » (?share=…), gardé pour la session */
export const getShare = () => (typeof window === "undefined" ? null : sessionStorage.getItem("uxb.share"));

/** Absolute URL of an API path, e.g. the signed `/footage/<id>/proxy.mp4?t=…` paths a <video> loads directly */
export const apiUrl = (path: string) => `${API}${path.startsWith("/") ? path : `/${path}`}`;

/** raw: the body is sent as application/octet-stream; text: the response body is returned as a string (text/plain endpoints) */
export async function api<T = any>(path: string, o: { method?: string; body?: unknown; headers?: Record<string, string>; raw?: boolean; text?: boolean; signal?: AbortSignal } = {}): Promise<T> {
  const t = getToken();
  const headers: Record<string, string> = { "Content-Type": o.raw ? "application/octet-stream" : "application/json", ...o.headers };
  if (t) headers.Authorization = "Bearer " + t;
  else if (getShare()) headers["x-share-token"] = getShare()!;
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const r = await fetch(`${API}${normalizedPath}`, { method: o.method || "GET", headers, body: o.raw ? (o.body as BodyInit) : o.body ? JSON.stringify(o.body) : undefined, signal: o.signal });
  const txt = o.text ? await r.text().catch(() => "") : null;
  const j = txt != null ? (r.ok ? {} : (() => { try { return JSON.parse(txt); } catch { return {}; } })()) : await r.json().catch(() => ({}));
  if (r.status === 401 && ["Unauthorized", "Session expirée"].includes(j.message)) {
    if (!t && getShare()) { document.body.innerHTML = '<div style="display:grid;min-height:100vh;place-items:center;font-family:sans-serif">This shared link is no longer active.</div>'; throw new Error("Link inactive"); }
    localStorage.removeItem("uxb.token");
    location.href = "/login";
    throw new Error("Session expired");
  }
  if (!r.ok) throw Object.assign(new Error(Array.isArray(j.message) ? j.message.join(", ") : j.message || r.statusText), { status: r.status });
  return (txt != null ? txt : j) as T;
}
