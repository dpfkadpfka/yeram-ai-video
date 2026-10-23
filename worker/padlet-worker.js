// Cloudflare Worker: 패들렛 읽기(GET ?id=보드ID) / 글 올리기(POST ?id=보드ID {subject,body,url}) — API 키는 비밀값 PADLET_KEY에만
const ALLOW = "https://dpfkadpfka.github.io";
const strip = s => String(s || "").replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>/gi, "\n").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').trim();
const H = k => ({ "X-Api-Key": k, accept: "application/vnd.api+json", "content-type": "application/vnd.api+json" });
export default {
  async fetch(req, env, ctx) {
    const cors = { "Access-Control-Allow-Origin": ALLOW, "Vary": "Origin", "Content-Type": "application/json; charset=utf-8" };
    if (req.method === "OPTIONS") return new Response(null, { headers: { ...cors, "Access-Control-Allow-Methods": "GET,POST", "Access-Control-Allow-Headers": "content-type" } });
    const id = new URL(req.url).searchParams.get("id") || "";
    if (!/^[a-z0-9]{10,}$/i.test(id)) return new Response('{"error":"id"}', { status: 400, headers: cors });
    const key = new Request("https://cache.local/padlet/" + id), cache = caches.default;
    if (req.method === "POST") {
      const b = await req.json().catch(() => ({}));
      const subject = String(b.subject || "").slice(0, 120), body = String(b.body || "").slice(0, 2000), url = String(b.url || "");
      if (!subject || !/^https:\/\/res\.cloudinary\.com\//.test(url)) return new Response('{"error":"bad"}', { status: 400, headers: cors });
      const send = att => fetch(`https://api.padlet.dev/v1/boards/${id}/posts`, { method: "POST", headers: H(env.PADLET_KEY), body: JSON.stringify({ data: { type: "post", attributes: { content: { subject, body, attachment: att } } } }) });
      let r = await send({ url, caption: "" });
      if (!r.ok) r = await send({ attachment_url: url, attachment_caption: "" });
      ctx.waitUntil(cache.delete(key));
      return new Response(JSON.stringify({ ok: r.ok, status: r.status, detail: r.ok ? "" : (await r.text()).slice(0, 300) }), { status: r.ok ? 200 : 502, headers: cors });
    }
    const hit = await cache.match(key);
    if (hit) return new Response(hit.body, { headers: cors });
    const r = await fetch(`https://api.padlet.dev/v1/boards/${id}?include=posts,sections`, { headers: H(env.PADLET_KEY) });
    if (!r.ok) return new Response(JSON.stringify({ error: r.status }), { status: 502, headers: cors });
    const j = await r.json(), inc = j.included || [];
    const sections = Object.fromEntries(inc.filter(x => x.type === "section").map(x => [x.id, x.attributes?.title || ""]));
    const posts = inc.filter(x => x.type === "post").map(x => {
      const a = x.attributes || {}, c = a.content || {}, at = c.attachment || {};
      return { id: x.id, subject: strip(c.subject), body: strip(c.body), url: at.url || "", caption: at.caption || "", color: a.color || "",
        section: sections[x.relationships?.section?.data?.id] || "", at: a.createdAt || a.created_at || "", by: a.author?.name || a.authorName || "" };
    }).sort((p, q) => String(q.at).localeCompare(String(p.at)));
    const out = JSON.stringify({ board: { id, title: j.data?.attributes?.title || "" }, posts });
    ctx.waitUntil(cache.put(key, new Response(out, { headers: { "Cache-Control": "max-age=10" } })));
    return new Response(out, { headers: cors });
  }
};
