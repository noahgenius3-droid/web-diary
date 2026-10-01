// Hands signed-in users short-lived TURN relay credentials, so live video, calls and audio rooms connect on
// networks where a direct connection is impossible (many mobile carriers). Uses Cloudflare's TURN service:
// set CLOUDFLARE_TURN_KEY_ID and CLOUDFLARE_TURN_KEY_TOKEN as Supabase secrets. Without them it returns no
// relays and the app keeps using STUN only.
const KEY_ID = Deno.env.get("CLOUDFLARE_TURN_KEY_ID") || "";
const KEY_TOKEN = Deno.env.get("CLOUDFLARE_TURN_KEY_TOKEN") || "";
const TTL = 12 * 3600;
const headers = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers });
  if (!KEY_ID || !KEY_TOKEN) return new Response(JSON.stringify({ ready: false, iceServers: [] }), { headers });
  try {
    const res = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${KEY_ID}/credentials/generate-ice-servers`, {
      method: "POST",
      headers: { Authorization: `Bearer ${KEY_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ ttl: TTL }),
    });
    if (!res.ok) throw new Error(`cloudflare ${res.status}`);
    const data = await res.json();
    // Either { iceServers: [...] } or (older endpoint) { iceServers: { urls, username, credential } }
    const list = Array.isArray(data.iceServers) ? data.iceServers : data.iceServers ? [data.iceServers] : [];
    return new Response(JSON.stringify({ ready: true, ttl: TTL, iceServers: list }), { headers });
  } catch (e) {
    console.error(String(e));
    return new Response(JSON.stringify({ ready: false, iceServers: [] }), { headers });
  }
});
