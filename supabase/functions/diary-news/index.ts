// World and local news for Explore. Reads publishers' public RSS feeds on the server (browsers can't fetch
// them directly) and returns a small, clean JSON list of headlines that link to the publisher's own article.
// Results are cached for 10 minutes per request.
// POST { scope: 'world' | 'local' | 'topic', country?: 'NG', city?: 'Lagos', topic?: 'business' }

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const TTL = 10 * 60 * 1000;
const cache = new Map<string, { at: number; body: string }>();

const BBC = (path: string) => `https://feeds.bbci.co.uk/news/${path}/rss.xml`;
const WORLD = [{ url: BBC("world"), name: "BBC News" }];
const TOPICS: Record<string, { url: string; name: string }[]> = {
  business: [{ url: BBC("business"), name: "BBC Business" }],
  technology: [{ url: BBC("technology"), name: "BBC Technology" }],
  science: [{ url: BBC("science_and_environment"), name: "BBC Science" }],
  health: [{ url: BBC("health"), name: "BBC Health" }],
  entertainment: [{ url: BBC("entertainment_and_arts"), name: "BBC Entertainment" }],
  sports: [{ url: "https://feeds.bbci.co.uk/sport/rss.xml", name: "BBC Sport" }],
};
// National publishers, by ISO country code
const LOCAL: Record<string, { url: string; name: string }[]> = {
  NG: [
    { url: "https://www.premiumtimesng.com/feed", name: "Premium Times" },
    { url: "https://www.vanguardngr.com/feed/", name: "Vanguard" },
    { url: "https://www.channelstv.com/feed/", name: "Channels TV" },
    { url: "https://punchng.com/feed/", name: "Punch" },
  ],
  GH: [{ url: "https://www.myjoyonline.com/feed/", name: "MyJoyOnline" }],
  GB: [{ url: BBC("uk"), name: "BBC News" }],
  US: [{ url: "https://feeds.npr.org/1001/rss.xml", name: "NPR" }, { url: BBC("world/us_and_canada"), name: "BBC News" }],
  CA: [{ url: "https://www.cbc.ca/webfeed/rss/rss-topstories", name: "CBC" }],
  IN: [{ url: "https://www.thehindu.com/news/national/feeder/default.rss", name: "The Hindu" }],
  AU: [{ url: "https://www.abc.net.au/news/feed/51120/rss.xml", name: "ABC News" }],
};
// Everywhere else: BBC's regional feed
const REGION: Record<string, string> = {};
"DZ AO BJ BW BF BI CM CV CF TD KM CD CG CI DJ EG GQ ER ET GA GM GH GN GW KE LS LR LY MG MW ML MR MU MA MZ NA NE NG RW ST SN SC SL SO ZA SS SD SZ TZ TG TN UG ZM ZW".split(" ").forEach(c => REGION[c] = "world/africa");
"CN JP KR KP TW HK MO MN IN PK BD LK NP BT MV AF ID MY SG TH VN PH MM KH LA BN TL".split(" ").forEach(c => REGION[c] = "world/asia");
"AE SA QA KW BH OM YE IQ IR IL PS JO LB SY TR".split(" ").forEach(c => REGION[c] = "world/middle_east");
"MX GT BZ SV HN NI CR PA CU DO HT JM TT BS BB CO VE EC PE BO BR PY UY AR CL".split(" ").forEach(c => REGION[c] = "world/latin_america");
"FR DE IT ES PT NL BE LU IE CH AT PL CZ SK HU RO BG GR HR SI RS BA ME MK AL DK SE NO FI IS EE LV LT UA BY MD RU CY MT".split(" ").forEach(c => REGION[c] = "world/europe");
"US CA".split(" ").forEach(c => REGION[c] = "world/us_and_canada");
"AU NZ FJ PG".split(" ").forEach(c => REGION[c] = "world/australia");

type Item = { title: string; link: string; source: string; published: string | null; image: string | null; summary: string };

function json(status: number, body: unknown) {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json", "Cache-Control": "public, max-age=300" },
  });
}

const decode = (s: string) =>
  s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;|&#8217;|&#8216;/g, "'")
    .replace(/&#822[01];/g, '"').replace(/&#8211;|&#8212;/g, "–").replace(/&#8230;/g, "…").replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))).replace(/&amp;/g, "&");
const strip = (s: string) => decode(decode(s)).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
const tag = (block: string, name: string) => {
  const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, "i"));
  return m ? m[1] : "";
};
const attr = (block: string, name: string, key: string) => {
  const m = block.match(new RegExp(`<${name}[^>]*\\s${key}="([^"]+)"`, "i"));
  return m ? decode(m[1]) : null;
};
const safeUrl = (u: string | null) => {
  if (!u) return null;
  try {
    const url = new URL(u.trim());
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
};

async function feed({ url, name }: { url: string; name: string }): Promise<Item[]> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { "User-Agent": "Mozilla/5.0 (compatible; CordialNews/1.0; +https://web-diary-gamma.vercel.app)" } });
    if (!res.ok) return [];
    const xml = await res.text();
    const items = xml.split(/<item[\s>]/i).slice(1).map(chunk => chunk.split(/<\/item>/i)[0]);
    return items.slice(0, 30).map(block => {
      const title = strip(tag(block, "title"));
      const link = safeUrl(strip(tag(block, "link")) || attr(block, "link", "href"));
      const inline = (tag(block, "content:encoded") || tag(block, "description")).match(/<img[^>]+src="([^"]+)"/i);
      const image = safeUrl(attr(block, "media:thumbnail", "url") || attr(block, "media:content", "url") ||
        attr(block, "enclosure", "url") || (inline ? decode(inline[1]) : null));
      const pub = strip(tag(block, "pubDate")) || strip(tag(block, "dc:date"));
      const date = pub ? new Date(pub) : null;
      const summary = strip(tag(block, "description")).replace(/The post .* appeared first on .*$/i, "").slice(0, 220);
      return { title: title.slice(0, 220), link: link || "", source: name, published: date && !isNaN(+date) ? date.toISOString() : null, image, summary };
    }).filter(i => i.title && i.link);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

function mergeNewest(lists: Item[][], limit = 30) {
  const seen = new Set<string>();
  const all = lists.flat().filter(i => {
    const key = i.title.toLowerCase().replace(/[^a-z0-9]+/g, " ").slice(0, 70);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  all.sort((a, b) => (Date.parse(b.published || "") || 0) - (Date.parse(a.published || "") || 0));
  return all.slice(0, limit);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  let p: Record<string, string> = {};
  try {
    if (req.method === "POST") p = await req.json();
    else p = Object.fromEntries(new URL(req.url).searchParams);
  } catch {
    return json(400, { error: "Invalid request" });
  }
  const scope = ["world", "local", "topic"].includes(p.scope) ? p.scope : "world";
  const country = /^[A-Za-z]{2}$/.test(p.country || "") ? p.country.toUpperCase() : "US";
  const city = String(p.city || "").replace(/[^\p{L}\p{N} ,.'-]/gu, "").trim().slice(0, 60);
  const topic = TOPICS[String(p.topic || "").toLowerCase()] ? String(p.topic).toLowerCase() : "business";

  const key = JSON.stringify({ scope, country, city, topic });
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return json(200, hit.body);

  let items: Item[] = [];
  let sources: string[] = [];
  if (scope === "world") {
    const lists = await Promise.all(WORLD.map(feed));
    items = mergeNewest(lists);
    sources = WORLD.map(s => s.name);
  } else if (scope === "topic") {
    const lists = await Promise.all(TOPICS[topic].map(feed));
    items = mergeNewest(lists);
    sources = TOPICS[topic].map(s => s.name);
  } else {
    const list = LOCAL[country] || (REGION[country] ? [{ url: BBC(REGION[country]), name: "BBC News" }] : WORLD);
    items = mergeNewest(await Promise.all(list.map(feed)), 40);
    sources = [...new Set(list.map(s => s.name))];
    // Stories that mention your city come first
    if (city) {
      const c = city.split(",")[0].trim().toLowerCase();
      const near = items.filter(i => `${i.title} ${i.summary}`.toLowerCase().includes(c));
      items = [...near, ...items.filter(i => !near.includes(i))];
    }
    items = items.slice(0, 30);
  }
  const body = JSON.stringify({ scope, country, city, topic, sources, national: !!LOCAL[country], fetchedAt: new Date().toISOString(), items });
  if (items.length) cache.set(key, { at: Date.now(), body });
  return json(items.length ? 200 : 502, items.length ? body : { error: "Couldn't load the news right now" });
});
