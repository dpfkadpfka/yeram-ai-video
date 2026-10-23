// 패들렛 게시물을 가져와 data/padlet.json 으로 저장 (GitHub Actions에서 실행, 키는 Secrets에만 있음)
// run
import { writeFileSync, readFileSync, existsSync } from "node:fs";
const KEY = process.env.PADLET_KEY;
if (!KEY) { console.log("PADLET_KEY 없음 — 건너뜀"); process.exit(0); }
const DEFAULT = "https://padlet.com/dpfkadpfka/261024-ai-s024r0un3iscpii4h8d4";
let url = DEFAULT;
try {
  const r = await fetch("https://firestore.googleapis.com/v1/projects/yeram-ai-video/databases/(default)/documents/config/site");
  if (r.ok) { const j = await r.json(); const v = j.fields?.padlet?.stringValue; if (v) url = v; }
} catch (e) { console.log("config 읽기 실패, 기본 주소 사용"); }
const m = url.match(/padlet\.com\/(?:embed\/)?(?:[^\/]+\/)?(?:[^\/?#]*-)?([a-z0-9]{10,})/i);
if (!m) { console.log("보드 ID를 찾지 못함:", url); process.exit(0); }
const id = m[1];
const res = await fetch(`https://api.padlet.dev/v1/boards/${id}?include=posts,sections`, { headers: { "X-Api-Key": KEY, accept: "application/vnd.api+json" } });
if (!res.ok) { console.log("API 오류", res.status, await res.text()); process.exit(1); }
const j = await res.json();
const strip = s => String(s || "").replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>/gi, "\n").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').trim();
const inc = j.included || [];
const sections = Object.fromEntries(inc.filter(x => x.type === "section").map(x => [x.id, x.attributes?.title || ""]));
const posts = inc.filter(x => x.type === "post").map(x => {
  const a = x.attributes || {}, c = a.content || {}, at = c.attachment || {};
  return {
    id: x.id,
    subject: strip(c.subject),
    body: strip(c.body),
    url: at.url || "",
    caption: at.caption || "",
    color: a.color || "",
    section: sections[x.relationships?.section?.data?.id] || "",
    at: a.createdAt || a.created_at || "",
    by: a.author?.name || a.authorName || ""
  };
}).sort((p, q) => String(q.at).localeCompare(String(p.at)));
const out = { board: { id, url, title: j.data?.attributes?.title || "" }, posts };
const file = "data/padlet.json", txt = JSON.stringify(out, null, 1);
const prev = existsSync(file) ? readFileSync(file, "utf8") : "";
if (prev === txt) { console.log("변화 없음"); process.exit(0); }
writeFileSync(file, txt);
console.log("저장:", posts.length, "개");
if (posts[0]) console.log("샘플 키:", JSON.stringify(inc.find(x => x.type === "post")?.attributes).slice(0, 600));
