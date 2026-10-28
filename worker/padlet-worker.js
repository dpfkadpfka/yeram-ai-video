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
    // R2 영상 저장소: 올리기(POST act=vup, 본문=파일) / 보기(GET act=vf&k=키, Range 지원)
    if (u.pathname.startsWith("/v/")) {
      if (!env.VIDS) return new Response("no store", { status: 503 });
      const k = decodeURIComponent(u.pathname.slice(1)); if (!/^v\/[\w.-]+$/.test(k)) return new Response("bad", { status: 400 });
      const range = req.headers.get("range"); let opt = {};
      if (range) { const m = range.match(/bytes=(\d*)-(\d*)/); if (m) { const st = m[1] ? +m[1] : undefined, en = m[2] ? +m[2] : undefined; opt.range = st !== undefined ? (en !== undefined ? { offset: st, length: en - st + 1 } : { offset: st }) : { suffix: en }; } }
      const o = await env.VIDS.get(k, opt); if (!o) return new Response("not found", { status: 404 });
      const h = new Headers({ "Access-Control-Allow-Origin": "*", "Accept-Ranges": "bytes", "Cache-Control": "public, max-age=31536000, immutable", "Content-Type": o.httpMetadata?.contentType || "video/mp4", "ETag": o.httpEtag });
      if (opt.range && o.range) { const off = o.range.offset ?? (o.size - o.range.suffix), len = o.range.length ?? (o.size - off); h.set("Content-Range", `bytes ${off}-${off + len - 1}/${o.size}`); h.set("Content-Length", String(len)); return new Response(o.body, { status: 206, headers: h }); }
      h.set("Content-Length", String(o.size)); return new Response(o.body, { headers: h });
    }
    if (req.method === "POST" && act === "vup") {
      if (!env.VIDS) return J({ error: "nostore" }, 503);
      const ct = req.headers.get("content-type") || "", len = +(req.headers.get("content-length") || 0);
      if (!/^video\//.test(ct)) return J({ error: "type" }, 400);
      if (!len || len > 100 * 1024 * 1024) return J({ error: "size" }, 413);
      const ext = (ct.split("/")[1] || "mp4").replace(/[^a-z0-9]/g, "").slice(0, 5) || "mp4";
      const k = "v/" + Date.now().toString(36) + crypto.randomUUID().slice(0, 8) + "." + (ext === "quicktime" ? "mov" : ext);
      await env.VIDS.put(k, req.body, { httpMetadata: { contentType: ct } });
      return J({ ok: true, url: u.origin + "/" + k, key: k, size: len });
    }
    // 커뮤니티 새 글 → 예람쌤 지메일 알림 (Google Apps Script 웹앱 MAIL_HOOK 경유, 같은 글은 한 번만)
    if (req.method === "POST" && act === "cnotify") {
      const b = await req.json().catch(() => ({}));
      const col = b.col === "cpriv" ? "cpriv" : "community", pid = String(b.id || "");
      if (!env.MAIL_HOOK || !b.idToken || !/^[\w-]{10,40}$/.test(pid)) return J({ ok: false });
      const dk = "cn:" + pid; if (env.HIDE && await env.HIDE.get(dk)) return J({ ok: true, dup: true });
      const r = await fetch(`https://firestore.googleapis.com/v1/projects/yeram-ai-video/databases/(default)/documents/${col}/${pid}`, { headers: { authorization: "Bearer " + b.idToken } });
      if (!r.ok) return J({ ok: false }, 400);
      const f = (await r.json()).fields || {}, g = k => (f[k] && (f[k].stringValue ?? f[k].booleanValue)) || "";
      const CAT = { review: "수강 후기", qna: "질문 게시판", free: "자유 게시판" };
      const txt = String(g("body") || g("html")).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 1500);
      if (env.HIDE) await env.HIDE.put(dk, "1", { expirationTtl: 86400 * 3 });
      ctx.waitUntil(fetch(env.MAIL_HOOK, { method: "POST", headers: { "content-type": "text/plain" }, body: JSON.stringify({ key: env.MAIL_KEY || "", subject: `[AI 영상 제작소] ${CAT[g("cat")] || "커뮤니티"}${col === "cpriv" ? "(비공개)" : ""} 새 글: ${g("title")}`.slice(0, 200), text: `${g("nick") || "익명"} 님이 글을 올렸어요.\n\n제목: ${g("title")}\n\n${txt}\n\n바로 보기: https://dpfkadpfka.github.io/yeram-ai-video/#community` }) }).catch(() => {}));
      return J({ ok: true });
    }
    if (req.method === "POST" && act === "seturl") {
      const b = await req.json().catch(() => ({}));
      if (!(await isAdmin(b.idToken))) return J({ error: "forbidden" }, 403);
      const post = String(b.post || ""), nu = String(b.url || "");
      if (!post || !nu.startsWith(u.origin + "/v/")) return J({ error: "bad" }, 400);
      const X = await getIdx(env); const m = { ...(X.meta[post] || {}), url: nu, orig: b.orig ? String(b.orig).slice(0, 300) : undefined };
      X.meta[post] = m; if (X.tmp) await env.HIDE.put("m:" + post, JSON.stringify(m)); else await env.HIDE.put("idx", JSON.stringify(X));
      ctx.waitUntil(caches.default.delete(new Request("https://cache.local/padlet/" + id)));
      return J({ ok: true });
    }
    if (req.method === "POST" && act === "usage") {
      const b = await req.json().catch(() => ({}));
      if (!(await isAdmin(b.idToken))) return J({ error: "forbidden" }, 403);
      const out = { at: new Date().toISOString() };
      if (env.CLD_KEY && env.CLD_SECRET) {
        const r = await fetch("https://api.cloudinary.com/v1_1/mcilphba/usage", { headers: { Authorization: "Basic " + btoa(env.CLD_KEY + ":" + env.CLD_SECRET) } }).catch(() => null);
        const j = r && r.ok ? await r.json().catch(() => null) : null;
        out.cld = j ? { plan: j.plan, updated: j.last_updated, credits: j.credits, bandwidth: j.bandwidth && j.bandwidth.usage, storage: j.storage && j.storage.usage, tf: j.transformations && j.transformations.usage, resources: j.resources } : { error: r ? r.status : "net" };
      } else out.cld = { error: "nokey" };
      if (env.VIDS) { let n = 0, sz = 0, cur; do { const l = await env.VIDS.list({ prefix: "v/", cursor: cur, limit: 1000 }); l.objects.forEach(o => { n++; sz += o.size; }); cur = l.truncated ? l.cursor : null; } while (cur); out.r2 = { n, size: sz, limit: 10 * 1024 ** 3 }; } else out.r2 = { error: "nostore" };
      return J(out);
    }
    if (act === "yt") {
      const ck = new Request("https://cache.local/yt/v1"), c = caches.default, hit = await c.match(ck);
      if (hit) return new Response(await hit.text(), { headers: cors });
      const t = await fetch("https://www.youtube.com/feeds/videos.xml?channel_id=UC9yQ7_VmqtOguVyPc9_EKQA").then(r => r.ok ? r.text() : "").catch(() => "");
      const dec = x => x.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
      const v = [...t.matchAll(/<entry>[\s\S]*?<yt:videoId>([^<]+)<[\s\S]*?<title>([^<]*)<[\s\S]*?href="([^"]+)"[\s\S]*?<published>([^<]+)</g)].map(m => ({ id: m[1], t: dec(m[2]), sh: /\/shorts\//.test(m[3]), at: m[4] }));
      const out = JSON.stringify({ v });
      if (v.length) ctx.waitUntil(c.put(ck, new Response(out, { headers: { "Cache-Control": "max-age=3600" } })));
      return new Response(out, { headers: cors });
    }
    if (act === "vmodels") {
      let sa; try { sa = JSON.parse(env.VERTEX_SA); } catch (e) { return J({ error: "nosa" }, 503); }
      const tok = await vertexToken(sa); const out = [];
      let pt = "";
      for (let i = 0; i < 8; i++) {
        const r = await fetch(`https://aiplatform.googleapis.com/v1beta1/publishers/google/models?pageSize=100${pt ? "&pageToken=" + pt : ""}`, { headers: { authorization: "Bearer " + tok, "x-goog-user-project": sa.project_id } });
        const d = await r.json(); (d.publisherModels || []).forEach(m => { if (/gemini|imagen|veo|tts|chirp/i.test(m.name)) out.push(m.name.split("/").pop() + ":" + (m.launchStage || "")); });
        if (!d.nextPageToken) { if (!r.ok) out.push("ERR " + JSON.stringify(d).slice(0, 200)); break; } pt = d.nextPageToken;
      }
      return J({ out });
    }
    // ===== 장면(studio) =====
    // 하루 사용량: KV "sq:<종류>:<uid>:<날짜>" (장면 그림 10장, 영상 3개, 음성 10개 / 관리자 무제한)
    if (req.method === "POST" && (act === "scene" || act === "vid" || act === "vidpoll" || act === "tts")) {
      const b = await req.json().catch(() => ({}));
      const who = await lookupUser(b.idToken);
      if (!who || !who.google) return J({ error: "login" }, 401);
      const admin = await isAdmin(b.idToken);
      let sa; try { sa = JSON.parse(env.VERTEX_SA); } catch (e) { return J({ error: "nosa" }, 503); }
      const tok = await vertexToken(sa);
      const day = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
      const LIM = { scene: 10, vid: 3, tts: 10 };
      const qk = k => `sq:${k}:${who.uid}:${day}`;
      const used = async k => +(await env.HIDE.get(qk(k)) || 0);
      const bump = async k => env.HIDE.put(qk(k), String((await used(k)) + 1), { expirationTtl: 172800 });
      const dataUrl = s => String(s || "").match(/^data:(image\/[\w.+-]+);base64,(.+)$/);
      if (act === "scene") {
        const n = await used("scene"); if (!admin && n >= LIM.scene) return J({ error: "limit", used: n, limit: LIM.scene }, 429);
        const prompt = String(b.prompt || "").slice(0, 1500); if (!prompt) return J({ error: "prompt" }, 400);
        const ratio = ["1:1", "16:9", "9:16"].includes(b.ratio) ? b.ratio : "9:16";
        const parts = [{ text: `Use the attached character reference image(s) (character and/or character turnaround sheet). Keep the SAME character: face, hair, outfit, colors and art style must match the references exactly. Draw ONE single scene (not a sheet, no panels, no text, no captions), aspect ratio ${ratio}, full-bleed.\nScene (Korean description): ${prompt}` }];
        (Array.isArray(b.refs) ? b.refs.slice(0, 2) : []).forEach(x => { const m = dataUrl(x); if (m) parts.push({ inlineData: { mimeType: m[1], data: m[2] } }); });
        if (parts.length < 2) return J({ error: "ref" }, 400);
        const ex = (Array.isArray(b.extra) ? b.extra.slice(0, 2) : []).map(dataUrl).filter(Boolean);
        if (ex.length) { parts.push({ text: `The next ${ex.length} image(s) show OTHER character(s) who must ALSO appear in this same scene together with the main character. Keep each character's face, hair, outfit and colors exactly as in their image, redrawn in the same art style as the main character.` }); ex.forEach(m => parts.push({ inlineData: { mimeType: m[1], data: m[2] } })); }
        const body = { contents: [{ role: "user", parts }], generationConfig: { responseModalities: ["TEXT", "IMAGE"], imageConfig: { aspectRatio: ratio } } };
        for (const m of ["gemini-nano-banana-2.1", "gemini-3.1-flash-image", "gemini-2.5-flash-image"]) {
          const r = await fetch(`https://aiplatform.googleapis.com/v1/projects/${sa.project_id}/locations/global/publishers/google/models/${m}:generateContent`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + tok }, body: JSON.stringify(body) });
          if (!r.ok) continue;
          const d = await r.json(); const im = (d?.candidates?.[0]?.content?.parts || []).find(x => x.inlineData || x.inline_data); if (!im) continue;
          const idt = im.inlineData || im.inline_data; await bump("scene");
          return J({ image: `data:${idt.mimeType || idt.mime_type || "image/png"};base64,${idt.data}`, used: n + 1, limit: admin ? null : LIM.scene, model: m });
        }
        return J({ error: "img" }, 502);
      }
      if (act === "tts") {
        const n = await used("tts"); if (!admin && n >= LIM.tts) return J({ error: "limit", used: n, limit: LIM.tts }, 429);
        const text = String(b.text || "").trim().slice(0, 600); if (!text) return J({ error: "text" }, 400);
        const VO = ["Kore", "Leda", "Aoede", "Zephyr", "Puck", "Charon", "Fenrir", "Orus"]; const voice = VO.includes(b.voice) ? b.voice : "Kore";
        const style = String(b.style || "").slice(0, 120);
        const body = { contents: [{ role: "user", parts: [{ text: (style ? style + ": " : "") + text }] }], generationConfig: { responseModalities: ["AUDIO"], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } } } };
        for (const m of ["gemini-2.5-flash-tts", "gemini-2.5-flash-preview-tts", "gemini-2.5-pro-tts", "gemini-2.5-pro-preview-tts"]) {
          for (const loc of ["global", "us-central1"]) {
            const host = loc === "global" ? "aiplatform.googleapis.com" : `${loc}-aiplatform.googleapis.com`;
            const r = await fetch(`https://${host}/v1/projects/${sa.project_id}/locations/${loc}/publishers/google/models/${m}:generateContent`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + tok }, body: JSON.stringify(body) });
            if (!r.ok) continue;
            const d = await r.json(); const p = (d?.candidates?.[0]?.content?.parts || []).find(x => x.inlineData || x.inline_data); if (!p) continue;
            const id = p.inlineData || p.inline_data, mt = id.mimeType || id.mime_type || "";
            const pcm = Uint8Array.from(atob(id.data), c => c.charCodeAt(0));
            let out = pcm, ct = mt;
            if (/L16|pcm/i.test(mt) || !/wav|mp3|mpeg|ogg/i.test(mt)) {
              const rate = +((mt.match(/rate=(\d+)/) || [])[1] || 24000), h = new DataView(new ArrayBuffer(44)), w = (o, s) => [...s].forEach((c, i) => h.setUint8(o + i, c.charCodeAt(0)));
              w(0, "RIFF"); h.setUint32(4, 36 + pcm.length, true); w(8, "WAVE"); w(12, "fmt "); h.setUint32(16, 16, true); h.setUint16(20, 1, true); h.setUint16(22, 1, true); h.setUint32(24, rate, true); h.setUint32(28, rate * 2, true); h.setUint16(32, 2, true); h.setUint16(34, 16, true); w(36, "data"); h.setUint32(40, pcm.length, true);
              out = new Uint8Array(44 + pcm.length); out.set(new Uint8Array(h.buffer), 0); out.set(pcm, 44); ct = "audio/wav";
            }
            let bin = ""; for (let i = 0; i < out.length; i += 32768) bin += String.fromCharCode.apply(null, out.subarray(i, i + 32768));
            await bump("tts");
            return J({ audio: `data:${ct};base64,${btoa(bin)}`, used: n + 1, limit: admin ? null : LIM.tts, model: m });
          }
        }
        return J({ error: "tts" }, 502);
      }
      const LOC = "us-central1", VEO = ["veo-3.1-lite-generate-001", "veo-3.1-fast-generate-001", "veo-3.1-fast-generate-preview", "veo-3.0-fast-generate-001"];
      const base = m => `https://${LOC}-aiplatform.googleapis.com/v1/projects/${sa.project_id}/locations/${LOC}/publishers/google/models/${m}`;
      if (act === "vid") {
        const n = await used("vid"); if (!admin && n >= LIM.vid) return J({ error: "limit", used: n, limit: LIM.vid }, 429);
        const m0 = dataUrl(b.image); if (!m0) return J({ error: "image" }, 400);
        const ratio = b.ratio === "16:9" ? "16:9" : "9:16", dur = [4, 6, 8].includes(+b.dur) ? +b.dur : 8;
        const sfx = !!(b.audio && b.audio.sfx), speech = !!(b.audio && b.audio.speech), line = String((b.audio && b.audio.line) || "").slice(0, 200);
        const aud = !(sfx || speech) ? "" : "\nAudio: " + [sfx ? "natural sound effects that match the actions" : "no sound effects", speech ? (line ? `the character speaks this line in Korean, clearly and naturally with matching lip movement: "${line}"` : "the character speaks briefly in natural Korean with matching lip movement") : "no dialogue, no speech, no voices", "no background music"].join("; ") + ".";
        const prompt = String(b.prompt || "").slice(0, 800) + "\nKeep the character exactly as in the image. Smooth natural motion. No text." + aud;
        for (const m of VEO) {
          const r = await fetch(base(m) + ":predictLongRunning", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + tok }, body: JSON.stringify({ instances: [{ prompt, image: { bytesBase64Encoded: m0[2], mimeType: m0[1] } }], parameters: { aspectRatio: ratio, durationSeconds: dur, sampleCount: 1, generateAudio: sfx || speech, resolution: "720p", personGeneration: "allow_all" } }) });
          if (!r.ok) continue;
          const d = await r.json(); if (!d.name) continue;
          await bump("vid"); return J({ op: d.name, model: m, used: n + 1, limit: admin ? null : LIM.vid });
        }
        return J({ error: "vid" }, 502);
      }
      // vidpoll
      const op = String(b.op || ""), m = VEO.includes(b.model) ? b.model : VEO[0];
      if (!/^projects\/[\w-]+\/locations\/[\w-]+\/publishers\/google\/models\/[\w.-]+\/operations\/[\w-]+$/.test(op)) return J({ error: "op" }, 400);
      const ck = "vo:" + op.split("/").pop(), done = await env.HIDE.get(ck); if (done) return J({ url: done });
      const r = await fetch(base(m) + ":fetchPredictOperation", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + tok }, body: JSON.stringify({ operationName: op }) });
      if (!r.ok) return J({ wait: true });
      const d = await r.json(); if (!d.done) return J({ wait: true });
      if (d.error) return J({ error: "veo", detail: String(d.error.message || "").slice(0, 200) });
      const v = (d.response?.videos || [])[0]; if (!v || !v.bytesBase64Encoded) return J({ error: d.response?.raiMediaFilteredCount ? "filtered" : "novideo" });
      if (!env.VIDS) return J({ error: "nostore" }, 503);
      const bin = Uint8Array.from(atob(v.bytesBase64Encoded), c => c.charCodeAt(0));
      const k = "v/s" + Date.now().toString(36) + crypto.randomUUID().slice(0, 8) + ".mp4";
      await env.VIDS.put(k, bin, { httpMetadata: { contentType: "video/mp4" } });
      const url = u.origin + "/" + k; await env.HIDE.put(ck, url, { expirationTtl: 86400 });
      return J({ url });
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
      const sref = String(b.sref || "").match(/^data:(image\/[\w.+-]+);base64,(.+)$/);
      if (sref && kind === "base") { parts.push({ text: "STYLE REFERENCE ONLY: match this image's art style exactly (rendering, line quality, shading, color palette, eye and face style, head-to-body proportion). Do NOT copy its character, hair, outfit, horns, wings, colors of clothing, or pose. Draw the character described above." }); parts.push({ inlineData: { mimeType: sref[1], data: sref[2] } }); }
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
        // 알림: 사람마다 처음 만들 때 한 번, 그 뒤 1시간은 조용히. 개인정보(이름·메일)는 보내지 않음 — 자세한 건 관리자 '이미지 기록'에서
        if (env.NTFY_TOPIC && env.HIDE && !admin) ctx.waitUntil((async () => {
          const nk = "nt:" + who.uid; if (await env.HIDE.get(nk)) return;
          await env.HIDE.put(nk, "1", { expirationTtl: 3600 });
          await fetch("https://ntfy.sh/" + encodeURIComponent(env.NTFY_TOPIC), { method: "POST", headers: { Tags: "art", Click: "https://dpfkadpfka.github.io/yeram-ai-video/", "Content-Type": "text/plain; charset=utf-8" }, body: `AI 영상 제작소: 새로 그림을 만든 사람이 있어요 (${kind === "sheet" ? "캐릭터 시트" : "기본 이미지"}). 관리자 > 이미지 기록에서 확인` }).catch(() => {});
        })());
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
      if (["st", "tc"].includes(b.who)) m.who = b.who;
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
      const subject = String(b.subject || "").slice(0, 120), body = String(b.body || "").slice(0, 2000), url = String(b.url || ""), by = String(b.by || "").slice(0, 30), intro = String(b.intro || "").slice(0, 300), kind = ["t2v", "i2v"].includes(b.kind) ? b.kind : "", who = b.who === "st" ? "st" : "tc";
      if (!subject || !(/^https:\/\/res\.cloudinary\.com\//.test(url) || url.startsWith(u.origin + "/v/"))) return J({ error: "bad" }, 400);
      const send = att => fetch(`https://api.padlet.dev/v1/boards/${id}/posts`, { method: "POST", headers: H(env.PADLET_KEY), body: JSON.stringify({ data: { type: "post", attributes: { content: { subject, body, attachment: att } } } }) });
      let r = await send({ url, caption: "" });
      if (!r.ok) r = await send({ attachment_url: url, attachment_caption: "" });
      ctx.waitUntil(cache.delete(key));
      if (!r.ok) return J({ ok: false, status: r.status, detail: (await r.text()).slice(0, 300) }, 502);
      const d = await r.json().catch(() => ({}));
      const pid = String(d?.data?.id || "");
      if (pid && env.HIDE) { const X = await getIdx(env); X.meta[pid] = { by, intro, kind, who }; if (X.tmp) await env.HIDE.put("m:" + pid, JSON.stringify(X.meta[pid])); else await env.HIDE.put("idx", JSON.stringify(X)); }
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
      return { id: x.id, subject: meta[x.id]?.subject || strip(c.subject), body: strip(c.body), url: meta[x.id]?.url || at.url || "", caption: at.caption || "", color: a.color || "",
        section: sections[x.relationships?.section?.data?.id] || "", at: a.createdAt || a.created_at || "", by: meta[x.id]?.by || a.author?.name || a.authorName || "", intro: meta[x.id]?.intro || "", kind: meta[x.id]?.kind || "", who: meta[x.id]?.who || "tc" };
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
