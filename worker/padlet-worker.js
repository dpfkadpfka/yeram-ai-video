// Cloudflare Worker: 패들렛 게시물을 바로 가져와 사이트에 넘겨줌 (API 키는 Worker 비밀값 PADLET_KEY에만 저장)
// 사용: https://<worker주소>/?id=<패들렛 보드 ID>
const ALLOW = "https://dpfkadpfka.github.io";
const strip = s => String(s || "").replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>/gi, "\n").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').trim();
export default {
  async fetch(req, env, ctx) {
    const origin = req.headers.get("Origin") || "";
    const cors = { "Access-Control-Allow-Origin": origin === ALLOW ? ALLOW : ALLOW, "Vary": "Origin", "Content-Type": "application/json; charset=utf-8" };
    if (req.method === "OPTIONS") return new Response(null, { headers: { ...cors, "Access-Control-Allow-Methods": "GET" } });
    const id = new URL(req.url).searchParams.get("id") || "";
    if (!/^[a-z0-9]{10,}$/i.test(id)) return new Response('{"error":"id"}', { status: 400, headers: cors });
    const cache = caches.default, key = new Request("https://cache.local/padlet/" + id);
    let hit = await cache.match(key);
    if (hit) return new Response(hit.body, { headers: cors });
    const r = await fetch(`https://api.padlet.dev/v1/boards/${id}?include=posts,sections`, { headers: { "X-Api-Key": env.PADLET_KEY, accept: "application/vnd.api+json" } });
    if (!r.ok) return new Response(JSON.stringify({ error: r.status }), { status: 502, headers: cors });
    const j = await r.json(), inc = j.included || [];
    const sections = Object.fromEntries(inc.filter(x => x.type === "section").map(x => [x.id, x.attributes?.title || ""]));
    const posts = inc.filter(x => x.type === "post").map(x => {
      const a = x.attributes || {}, c = a.content || {}, at = c.attachment || {};
      return { id: x.id, subject: strip(c.subject), body: strip(c.body), url: at.url || "", caption: at.caption || "", color: a.color || "",
        section: sections[x.relationships?.section?.data?.id] || "", at: a.createdAt || a.created_at || "", by: a.author?.name || a.authorName || "" };
    }).sort((p, q) => String(q.at).localeCompare(String(p.at)));
    const body = JSON.stringify({ board: { id, title: j.data?.attributes?.title || "" }, posts });
    ctx.waitUntil(cache.put(key, new Response(body, { headers: { "Cache-Control": "max-age=15" } })));
    return new Response(body, { headers: cors });
  }
};
