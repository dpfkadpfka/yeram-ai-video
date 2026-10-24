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
// 숨김·메타를 KV 키 하나("idx")에 모아 둠 (KV list 하루 한도 초과 방지)
async function getIdx(env) {
  let x = null; try { x = JSON.parse(await env.HIDE.get("idx") || "null"); } catch (e) {}
  if (x && x.hidden && x.meta) return x;
  x = { hidden: [], meta: {} };
  try { // 처음 한 번만 옛 키에서 옮기기
    for (const k of (await env.HIDE.list({ prefix: "h:" })).keys) x.hidden.push(k.name.slice(2));
    for (const k of (await env.HIDE.list({ prefix: "m:" })).keys) { try { x.meta[k.name.slice(2)] = JSON.parse(await env.HIDE.get(k.name)); } catch (e) {} }
    await env.HIDE.put("idx", JSON.stringify(x)).catch(() => {});
  } catch (e) { x.tmp = 1; } // 옮기기 실패(한도 초과 등): 저장하지 않고 다음에 다시
  return x;
}
async function lookupUser(idToken) {
  if (!idToken) return null;
  const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${FB_KEY}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ idToken }) });
  if (!r.ok) return null;
  const x = ((await r.json()).users || [])[0];
  if (!x) return null;
  return { uid: x.localId, email: x.email || "", name: x.displayName || "", google: (x.providerUserInfo || []).some(p => p.providerId === "google.com") };
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
    try { return await this.handle(req, env, ctx); } catch (e) {
      return new Response(JSON.stringify({ error: "worker", msg: String(e && e.message || e).slice(0, 300) }), { status: 500, headers: { "Access-Control-Allow-Origin": ALLOW, "Vary": "Origin", "Content-Type": "application/json; charset=utf-8" } });
    }
  },
  async handle(req, env, ctx) {
    const cors = { "Access-Control-Allow-Origin": ALLOW, "Vary": "Origin", "Content-Type": "application/json; charset=utf-8" };
    const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: cors });
    if (req.method === "OPTIONS") return new Response(null, { headers: { ...cors, "Access-Control-Allow-Methods": "GET,POST", "Access-Control-Allow-Headers": "content-type" } });
    const u = new URL(req.url), id = u.searchParams.get("id") || "", act = u.searchParams.get("act") || "";
    if (act === "vmodels") {
      let sa; try { sa = JSON.parse(env.VERTEX_SA); } catch (e) { return J({ error: "nosa" }, 503); }
      const tok = await vertexToken(sa); const out = [];
      let pt = "";
      for (let i = 0; i < 8; i++) {
        const r = await fetch(`https://aiplatform.googleapis.com/v1beta1/publishers/google/models?pageSize=100${pt ? "&pageToken=" + pt : ""}`, { headers: { authorization: "Bearer " + tok, "x-goog-user-project": sa.project_id } });
        const d = await r.json(); (d.publisherModels || []).forEach(m => { if (/gemini|imagen/i.test(m.name)) out.push(m.name.split("/").pop() + ":" + (m.launchStage || "")); });
        if (!d.nextPageToken) { if (!r.ok) out.push("ERR " + JSON.stringify(d).slice(0, 200)); break; } pt = d.nextPageToken;
      }
      return J({ out });
    }
    if (req.method === "POST" && act === "img") {
      // 나노바나나(Vertex AI) 이미지 생성: 구글 로그인 사용자만, 하루 기본 이미지 5장·캐릭터 시트 5장, 기록은 Firestore imglog
      const b = await req.json().catch(() => ({}));
      const who = await lookupUser(b.idToken);
      if (!who || !who.google) return J({ error: "login" }, 401);
      const admin = await isAdmin(b.idToken);
      const kind = b.kind === "sheet" ? "sheet" : "base";
      const day = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
      const FS = "https://firestore.googleapis.com/v1/projects/yeram-ai-video/databases/(default)/documents";
      const ah = { authorization: "Bearer " + b.idToken, "content-type": "application/json" };
      const sv = v => ({ stringValue: String(v || "") });
      const q = await fetch(FS + ":runAggregationQuery", { method: "POST", headers: ah, body: JSON.stringify({ structuredAggregationQuery: { structuredQuery: { from: [{ collectionId: "imglog" }], where: { compositeFilter: { op: "AND", filters: [{ fieldFilter: { field: { fieldPath: "uid" }, op: "EQUAL", value: sv(who.uid) } }, { fieldFilter: { field: { fieldPath: "day" }, op: "EQUAL", value: sv(day) } }, { fieldFilter: { field: { fieldPath: "kind" }, op: "EQUAL", value: sv(kind) } }] } } }, aggregations: [{ alias: "n", count: {} }] } }) }).then(r => r.json()).catch(() => null);
      const used = +((Array.isArray(q) && q[0]?.result?.aggregateFields?.n?.integerValue) || 0);
      const LIMIT = 5;
      if (!admin && used >= LIMIT) return J({ error: "limit", used, limit: LIMIT, kind }, 429);
      const prompt = String(b.prompt || "").slice(0, 6000);
      if (!prompt) return J({ error: "prompt" }, 400);
      let sa; try { sa = JSON.parse(env.VERTEX_SA); } catch (e) { return J({ error: "nosa" }, 503); }
      const tok = await vertexToken(sa);
      const parts = [{ text: prompt }];
      const ref = String(b.ref || "").match(/^data:(image\/[\w.+-]+);base64,(.+)$/);
      if (ref) parts.push({ inlineData: { mimeType: ref[1], data: ref[2] } });
      const ratio = ["1:1", "16:9", "9:16", "4:3", "3:4"].includes(b.ratio) ? b.ratio : "1:1";
      const body = { contents: [{ role: "user", parts }], generationConfig: { responseModalities: ["TEXT", "IMAGE"], imageConfig: { aspectRatio: ratio } } };
      const errs = [];
      const IMGM = ["gemini-nano-banana-2.1", "gemini-3-pro-image", "gemini-3.1-flash-image", "gemini-2.5-flash-image"];
      for (const m of (admin && IMGM.includes(b.model) ? [b.model] : ["gemini-nano-banana-2.1", "gemini-3.1-flash-image", "gemini-2.5-flash-image"])) {
        const r = await fetch(`https://aiplatform.googleapis.com/v1/projects/${sa.project_id}/locations/global/publishers/google/models/${m}:generateContent`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + tok }, body: JSON.stringify(body) });
        if (!r.ok) { errs.push(m + " " + r.status + " " + (await r.text()).slice(0, 200)); continue; }
        const d = await r.json();
        const im = (d?.candidates?.[0]?.content?.parts || []).find(x => x.inlineData || x.inline_data);
        if (!im) { errs.push(m + " noimage " + JSON.stringify(d).slice(0, 200)); continue; }
        const idt = im.inlineData || im.inline_data;
        const fields = { uid: sv(who.uid), email: sv(who.email), name: sv(who.name), day: sv(day), at: { timestampValue: new Date().toISOString() }, kind: sv(kind), prompt: sv(prompt.slice(0, 1500)), model: sv(m), ref: { booleanValue: !!ref } };
        ctx.waitUntil(fetch(FS + "/imglog", { method: "POST", headers: ah, body: JSON.stringify({ fields }) }).catch(() => {}));
        return J({ image: `data:${idt.mimeType || idt.mime_type || "image/png"};base64,${idt.data}`, used: used + 1, limit: admin ? null : LIMIT, model: m, ...(u.searchParams.get("dbg") === "1" ? { errs } : {}) });
      }
      return J({ error: "img", ...(u.searchParams.get("dbg") === "1" ? { errs } : {}) }, 502);
    }
    if (req.method === "POST" && act === "ai") {
      if (!env.GEMINI_KEY && !env.VERTEX_SA) return J({ error: "nokey" }, 503);
      const b = await req.json().catch(() => ({}));
      const body = { systemInstruction: { parts: [{ text: String(b.system || "").slice(0, 8000) }] }, contents: [{ role: "user", parts: [{ text: String(b.prompt || "").slice(0, 12000) }] }], generationConfig: { temperature: Math.max(0, Math.min(1.2, Number(b.temp) || 0.2)), responseMimeType: b.json ? "application/json" : "text/plain" } };
      const tries = [];
      // 1순위: Vertex AI (구글 클라우드 크레딧, 서비스 계정 VERTEX_SA), 2순위: AI Studio 무료 키
      let vtok = "", sa = null; const errs = [];
      if (env.VERTEX_SA) { try { sa = JSON.parse(env.VERTEX_SA); vtok = await vertexToken(sa); } catch (e) { vtok = ""; errs.push("vtok " + String(e && e.message || e).slice(0, 200)); } }
      if (vtok) for (const m of (b.q === "hi" ? ["gemini-3.8-flash", "gemini-3-flash-preview", "gemini-3.5-flash-lite"] : ["gemini-3.5-flash-lite", "gemini-3.8-flash", "gemini-3-flash-preview"])) tries.push([m, `https://aiplatform.googleapis.com/v1/projects/${sa.project_id}/locations/global/publishers/google/models/${m}:generateContent`, vtok]);
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
      const X = await getIdx(env); const old = X.meta[post] || {};
      const m = { ...old, subject: String(b.subject || "").slice(0, 120), intro: String(b.intro || "").slice(0, 300), by: String(b.by || "").slice(0, 30) };
      if (["t2v", "i2v", ""].includes(b.kind)) m.kind = b.kind;
      X.meta[post] = m; if (X.tmp) await env.HIDE.put("m:" + post, JSON.stringify(m)); else await env.HIDE.put("idx", JSON.stringify(X));
      ctx.waitUntil(cache.delete(key));
      return J({ ok: true });
    }
    if (req.method === "POST" && act === "del") {
      const b = await req.json().catch(() => ({}));
      const post = String(b.post || "");
      if (!post) return J({ error: "post" }, 400);
      const ok = (b.token && b.token === await sign(env.PADLET_KEY, post)) || await isAdmin(b.idToken);
      if (!ok) return J({ error: "forbidden" }, 403);
      const X = await getIdx(env); if (!X.hidden.includes(post)) X.hidden.push(post); if (X.tmp) await env.HIDE.put("h:" + post, "1"); else await env.HIDE.put("idx", JSON.stringify(X));
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
      if (pid && env.HIDE) { const X = await getIdx(env); X.meta[pid] = { by, intro, kind }; if (X.tmp) await env.HIDE.put("m:" + pid, JSON.stringify(X.meta[pid])); else await env.HIDE.put("idx", JSON.stringify(X)); }
      return J({ ok: true, id: pid, token: pid ? await sign(env.PADLET_KEY, pid) : "" });
    }
    const hit = await cache.match(key);
    if (hit) return new Response(hit.body, { headers: cors });
    const r = await fetch(`https://api.padlet.dev/v1/boards/${id}?include=posts,sections`, { headers: H(env.PADLET_KEY) });
    if (!r.ok) return J({ error: r.status }, 502);
    let X = { hidden: [], meta: {} }; try { if (env.HIDE) X = await getIdx(env); } catch (e) {}
    const j = await r.json(), inc = j.included || [];
    if (X.tmp && env.HIDE) { // 목록(list) 없이 글 ID로 옛 키를 직접 읽어 idx 만들기
      const ids = inc.filter(x => x.type === "post").map(x => String(x.id)); const NX = { hidden: [], meta: {} };
      await Promise.all(ids.map(async pid => { const [h, m] = await Promise.all([env.HIDE.get("h:" + pid), env.HIDE.get("m:" + pid)]); if (h) NX.hidden.push(pid); if (m) { try { NX.meta[pid] = JSON.parse(m); } catch (e) {} } }));
      X = NX; ctx.waitUntil(env.HIDE.put("idx", JSON.stringify(NX)).catch(() => {}));
    }
    const hidden = new Set(X.hidden), meta = X.meta;
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
