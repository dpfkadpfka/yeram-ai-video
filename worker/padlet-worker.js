// Cloudflare Worker: 패들렛 읽기 / 올리기 / 숨기기(삭제)
// 비밀값 PADLET_KEY·GEMINI_KEY·VERTEX_SA(선택, 서비스 계정 JSON), KV 바인딩 HIDE (숨긴 글 목록), AI(act=ai)
const ALLOW = "https://dpfkadpfka.github.io";
const FB_KEY = "AIzaSyCZ-UaL2zBCzYYkjwzrdEUAA9dEVLg5uKM";
const OWNER = ["dpfkadpfka@gmail.com"];
const strip = s => String(s || "").replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>/gi, "\n").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').trim();
const H = k => ({ "X-Api-Key": k, accept: "application/vnd.api+json", "content-type": "application/vnd.api+json" });
async function sign(secret, msg) {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const s = await crypto.subtle.sign("HMAC", k, new TextEncoder().encode("del:" + msg));
  return [...new Uint8Array(s)].slice(0, 16).map(b => b.toString(16).padStart(2, "0")).join("");
}
async function isAdmin(idToken) {
  if (!idToken) return false;
  const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${FB_KEY}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ idToken }) });
  if (!r.ok) return false;
  const email = ((await r.json()).users || [{}])[0].email || "";
  if (OWNER.includes(email.toLowerCase())) return true;
  const c = await fetch("https://firestore.googleapis.com/v1/projects/yeram-ai-video/databases/(default)/documents/config/site").then(x => x.ok ? x.json() : {}).catch(() => ({}));
  const L = ((c.fields || {}).admins?.arrayValue?.values || []).map(v => String(v.stringValue || "").toLowerCase());
  return L.includes(email.toLowerCase());
}
export default {
  async fetch(req, env, ctx) {
    const cors = { "Access-Control-Allow-Origin": ALLOW, "Vary": "Origin", "Content-Type": "application/json; charset=utf-8" };
    const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: cors });
    if (req.method === "OPTIONS") return new Response(null, { headers: { ...cors, "Access-Control-Allow-Methods": "GET,POST", "Access-Control-Allow-Headers": "content-type" } });
    const u = new URL(req.url), id = u.searchParams.get("id") || "", act = u.searchParams.get("act") || "";
    if (req.method === "POST" && act === "ai") {
      if (!env.GEMINI_KEY && !env.VERTEX_SA) return J({ error: "nokey" }, 503);
      const b = await req.json().catch(() => ({}));
      const body = { systemInstruction: { parts: [{ text: String(b.system || "").slice(0, 8000) }] }, contents: [{ role: "user", parts: [{ text: String(b.prompt || "").slice(0, 12000) }] }], generationConfig: { temperature: 0.2, responseMimeType: b.json ? "application/json" : "text/plain" } };
      const tries = [];
      // 1순위: Vertex AI (구글 클라우드 크레딧, 서비스 계정 VERTEX_SA), 2순위: AI Studio 무료 키
      let vtok = "", sa = null; const errs = [];
      if (env.VERTEX_SA) { try { sa = JSON.parse(env.VERTEX_SA); vtok = await vertexToken(sa); } catch (e) { vtok = ""; errs.push("vtok " + String(e && e.message || e).slice(0, 200)); } }
      if (vtok) for (const m of ["gemini-3.1-flash-lite-preview", "gemini-3-flash-preview", "gemini-2.5-flash-lite", "gemini-2.0-flash-lite-001"]) tries.push([m, `https://aiplatform.googleapis.com/v1/projects/${sa.project_id}/locations/global/publishers/google/models/${m}:generateContent`, vtok]);
      if (env.GEMINI_KEY) for (const m of ["gemini-flash-lite-latest", "gemini-flash-latest"]) tries.push([m, `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${env.GEMINI_KEY}`, ""]);
      let lastErr = "";
      for (const [m, url, tok] of tries) {
        const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...(tok ? { authorization: "Bearer " + tok } : {}) }, body: JSON.stringify(body) });
        if (!r.ok) { lastErr = r.status + " " + (await r.text()).slice(0, 200); errs.push(m + " " + lastErr); continue; }
        const d = await r.json();
        return J({ text: d?.candidates?.[0]?.content?.parts?.map(p => p.text).join("") || "", model: m, via: url.includes("aiplatform") ? "vertex" : "studio", ...(u.searchParams.get("dbg") === "1" ? { errs } : {}) });
      }
      if (u.searchParams.get("dbg") === "1") return J({ error: "ai", lastErr }, 502);
      return J({ error: "ai" }, 502);
    }
    if (!/^[a-z0-9]{10,}$/i.test(id)) return J({ error: "id" }, 400);
    const key = new Request("https://cache.local/padlet/" + id), cache = caches.default;
    if (req.method === "POST" && act === "edit") {
      const b = await req.json().catch(() => ({}));
      const post = String(b.post || "");
      if (!post) return J({ error: "post" }, 400);
      const ok = (b.token && b.token === await sign(env.PADLET_KEY, post)) || await isAdmin(b.idToken);
      if (!ok) return J({ error: "forbidden" }, 403);
      let old = {}; try { old = JSON.parse(await env.HIDE.get("m:" + post) || "{}") } catch (e) {}
      const m = { ...old, subject: String(b.subject || "").slice(0, 120), intro: String(b.intro || "").slice(0, 300), by: String(b.by || "").slice(0, 30) };
      if (["t2v", "i2v", ""].includes(b.kind)) m.kind = b.kind;
      await env.HIDE.put("m:" + post, JSON.stringify(m));
      ctx.waitUntil(cache.delete(key));
      return J({ ok: true });
    }
    if (req.method === "POST" && act === "del") {
      const b = await req.json().catch(() => ({}));
      const post = String(b.post || "");
      if (!post) return J({ error: "post" }, 400);
      const ok = (b.token && b.token === await sign(env.PADLET_KEY, post)) || await isAdmin(b.idToken);
      if (!ok) return J({ error: "forbidden" }, 403);
      await env.HIDE.put("h:" + post, "1");
      ctx.waitUntil(cache.delete(key));
      return J({ ok: true });
    }
    if (req.method === "POST") {
      const b = await req.json().catch(() => ({}));
      const subject = String(b.subject || "").slice(0, 120), body = String(b.body || "").slice(0, 2000), url = String(b.url || ""), by = String(b.by || "").slice(0, 30), intro = String(b.intro || "").slice(0, 300), kind = ["t2v", "i2v"].includes(b.kind) ? b.kind : "";
      if (!subject || !/^https:\/\/res\.cloudinary\.com\//.test(url)) return J({ error: "bad" }, 400);
      const send = att => fetch(`https://api.padlet.dev/v1/boards/${id}/posts`, { method: "POST", headers: H(env.PADLET_KEY), body: JSON.stringify({ data: { type: "post", attributes: { content: { subject, body, attachment: att } } } }) });
      let r = await send({ url, caption: "" });
      if (!r.ok) r = await send({ attachment_url: url, attachment_caption: "" });
      ctx.waitUntil(cache.delete(key));
      if (!r.ok) return J({ ok: false, status: r.status, detail: (await r.text()).slice(0, 300) }, 502);
      const d = await r.json().catch(() => ({}));
      const pid = String(d?.data?.id || "");
      if (pid && env.HIDE) await env.HIDE.put("m:" + pid, JSON.stringify({ by, intro, kind }));
      return J({ ok: true, id: pid, token: pid ? await sign(env.PADLET_KEY, pid) : "" });
    }
    const hit = await cache.match(key);
    if (hit) return new Response(hit.body, { headers: cors });
    const r = await fetch(`https://api.padlet.dev/v1/boards/${id}?include=posts,sections`, { headers: H(env.PADLET_KEY) });
    if (!r.ok) return J({ error: r.status }, 502);
    const hidden = new Set(env.HIDE ? (await env.HIDE.list({ prefix: "h:" })).keys.map(k => k.name.slice(2)) : []);
    const meta = {};
    if (env.HIDE) { const ks = (await env.HIDE.list({ prefix: "m:" })).keys; await Promise.all(ks.map(async k => { try { meta[k.name.slice(2)] = JSON.parse(await env.HIDE.get(k.name)) } catch (e) {} })); }
    const j = await r.json(), inc = j.included || [];
    const sections = Object.fromEntries(inc.filter(x => x.type === "section").map(x => [x.id, x.attributes?.title || ""]));
    const posts = inc.filter(x => x.type === "post" && !hidden.has(String(x.id))).map(x => {
      const a = x.attributes || {}, c = a.content || {}, at = c.attachment || {};
      return { id: x.id, subject: meta[x.id]?.subject || strip(c.subject), body: strip(c.body), url: at.url || "", caption: at.caption || "", color: a.color || "",
        section: sections[x.relationships?.section?.data?.id] || "", at: a.createdAt || a.created_at || "", by: meta[x.id]?.by || a.author?.name || a.authorName || "", intro: meta[x.id]?.intro || "", kind: meta[x.id]?.kind || "" };
    }).sort((p, q) => String(q.at).localeCompare(String(p.at)));
    const out = JSON.stringify({ board: { id, title: j.data?.attributes?.title || "" }, posts });
    ctx.waitUntil(cache.put(key, new Response(out, { headers: { "Cache-Control": "max-age=10" } })));
    return new Response(out, { headers: cors });
  }
};

// Vertex AI 접근 토큰 (서비스 계정 JWT → OAuth), 50분 캐시
let VTOK = { t: "", exp: 0 };
async function vertexToken(sa) {
  const now = Math.floor(Date.now() / 1000);
  if (VTOK.t && VTOK.exp > now + 60) return VTOK.t;
  const b64u = x => btoa(typeof x === "string" ? x : String.fromCharCode(...new Uint8Array(x))).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
  const head = b64u(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = b64u(unescape(encodeURIComponent(JSON.stringify({ iss: sa.client_email, scope: "https://www.googleapis.com/auth/cloud-platform", aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 }))));
  const pem = sa.private_key.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const der = Uint8Array.from(atob(pem), c => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(head + "." + claim));
  const jwt = head + "." + claim + "." + b64u(sig);
  const r = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "grant_type=" + encodeURIComponent("urn:ietf:params:oauth:grant-type:jwt-bearer") + "&assertion=" + jwt });
  const d = await r.json();
  if (!d.access_token) throw new Error("token " + JSON.stringify(d).slice(0, 150));
  VTOK = { t: d.access_token, exp: now + (d.expires_in || 3600) };
  return VTOK.t;
}
