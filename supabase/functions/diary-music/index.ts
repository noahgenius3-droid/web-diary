// Licensed music for the "Add audio" library: Jamendo's catalogue of independent artists, released under
// Creative Commons licences. The client ID stays here on the server (secret JAMENDO_CLIENT_ID).
//   POST { category?, q?, offset? } -> { ready, provider, tracks: [...] }
//   POST { stream: "<jamendo audio url>" } -> the audio bytes (so a track can be mixed into a reel)
// Without the secret it answers { ready: false } and the app shows Cordial Sounds only.
const CLIENT = Deno.env.get("JAMENDO_CLIENT_ID") || "";
const API = "https://api.jamendo.com/v3.0/tracks/";
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { headers: { ...cors, "Content-Type": "application/json", ...extra } });

// Cordial's categories -> Jamendo genre tags (any of them) and sort order
const GENRES: Record<string, string> = {
  afrobeats: "afrobeat+afrobeats+afro",
  highlife: "highlife+palmwine+african",
  gospel: "gospel+worship+christian",
  afropop: "afropop+african+afro",
  amapiano: "amapiano+afrohouse+african",
};
const AFRICAN = "afrobeat+afrobeats+highlife+afropop+african+afro+amapiano+gospel";
const ORDER: Record<string, string> = { trending: "popularity_week", popular: "popularity_total", new: "releasedate_desc" };

const cache = new Map<string, { at: number; tracks: unknown[] }>();

function licenceName(url: string) {
  const m = /licenses\/([a-z-]+)\//i.exec(url || "");
  return m ? `CC ${m[1].toUpperCase()}` : "Creative Commons";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405, headers: cors });
  let body: { category?: string; q?: string; offset?: number; stream?: string } = {};
  try { body = await req.json(); } catch { /* empty */ }

  // Pass a Jamendo audio file through (browsers can't always read it directly for mixing)
  if (body.stream) {
    let url: URL;
    try { url = new URL(body.stream); } catch { return new Response("Bad request", { status: 400, headers: cors }); }
    if (url.protocol !== "https:" || !/(^|\.)jamendo\.com$/i.test(url.hostname)) return new Response("Forbidden", { status: 403, headers: cors });
    const res = await fetch(url.toString());
    if (!res.ok || !res.body) return new Response("Not found", { status: 404, headers: cors });
    const size = Number(res.headers.get("content-length") || 0);
    if (size > 25 * 1048576) return new Response("Too large", { status: 413, headers: cors });
    return new Response(res.body, { headers: { ...cors, "Content-Type": res.headers.get("content-type") || "audio/mpeg" } });
  }

  if (!CLIENT) return json({ ready: false, provider: "Jamendo", tracks: [] });

  const category = String(body.category || "all").toLowerCase();
  const q = String(body.q || "").trim().slice(0, 80);
  const offset = Math.max(0, Math.min(400, Number(body.offset) || 0));
  const key = `${category}|${q}|${offset}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 30 * 60 * 1000) return json({ ready: true, provider: "Jamendo", tracks: hit.tracks }, { "Cache-Control": "max-age=600" });

  const params = new URLSearchParams({
    client_id: CLIENT, format: "json", limit: "40", offset: String(offset),
    include: "licenses+musicinfo", audioformat: "mp32", imagesize: "200",
    order: q ? "relevance" : (ORDER[category] || "popularity_month"),
  });
  params.set("fuzzytags", GENRES[category] || AFRICAN);
  if (q) params.set("search", q);
  try {
    const res = await fetch(`${API}?${params}`);
    const data = await res.json();
    if (!res.ok || !data || !Array.isArray(data.results)) throw new Error(`jamendo ${res.status}`);
    const tracks = data.results
      .filter((t: any) => t && t.audio)
      .map((t: any) => ({
        id: `jamendo:${t.id}`,
        title: t.name,
        artist: t.artist_name,
        cover: t.image || t.album_image || null,
        preview: t.audio,
        src: t.audio,
        duration: Number(t.duration) || 30,
        category: [GENRES[category] ? category : "afrobeats", ...(ORDER[category] ? [category] : [])],
        licenseUrl: t.license_ccurl || null,
        licenseName: licenceName(t.license_ccurl),
        shareurl: t.shareurl || null,
        provider: "Jamendo",
      }));
    cache.set(key, { at: Date.now(), tracks });
    return json({ ready: true, provider: "Jamendo", tracks }, { "Cache-Control": "max-age=600" });
  } catch (e) {
    console.error(String(e));
    return json({ ready: true, provider: "Jamendo", tracks: [], error: "unavailable" });
  }
});
