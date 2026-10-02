// Cordial's alert server: rings phones and delivers direct messages even when Cordial is closed.
// Called by the app right after it sends a message or starts a call (with the person's sign-in), and by the
// service worker for the lock-screen "Decline" button (with the ring's signed token instead).
//   { action: "message", id }                  alert the recipient of a direct message you just sent
//   { action: "ring", callee, topic, video }   ring someone: an alert with Answer / Decline
//   { action: "missed", ring }                 nobody answered: "Missed call" replaces the ringing alert
//   { action: "decline", ring }                declined from the alert: tells the caller straight away
// Everything is checked here, never trusted from the caller: who sent the message, blocks, deleted accounts,
// "who can call you", muted chats and the person's alert choices.
import webpush from "npm:web-push@3.6.7";
import { createClient } from "npm:@supabase/supabase-js@2";

const URL_ = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const admin = createClient(URL_, SERVICE, { auth: { persistSession: false } });

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

let config: { vapid_public: string; vapid_private: string; trigger_secret: string } | null = null;
async function getConfig() {
  if (config) return config;
  const { data, error } = await admin.rpc("diary_push_config_get");
  if (error || !data || !data[0]) throw new Error("Push isn't configured");
  config = data[0];
  webpush.setVapidDetails("https://web-diary-gamma.vercel.app", config!.vapid_public, config!.vapid_private);
  return config!;
}

// ---------- Signed ring tokens (no database table needed) ----------
const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
async function hmac(secret: string, text: string) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`ring:${text}`))));
}
type Ring = { i: string; c: string; e: string; t: string; v: boolean; x: number };
async function signRing(secret: string, r: Ring) {
  const body = b64url(new TextEncoder().encode(JSON.stringify(r)));
  return `${body}.${await hmac(secret, body)}`;
}
async function readRing(secret: string, token: string): Promise<Ring | null> {
  const [body, sig] = String(token || "").split(".");
  if (!body || !sig || sig !== await hmac(secret, body)) return null;
  try { return JSON.parse(new TextDecoder().decode(fromB64url(body))); } catch { return null; }
}

// ---------- Helpers ----------
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const avatarUrl = (path?: string | null) =>
  path ? `${URL_}/storage/v1/object/public/diary-avatars/${String(path).split("/").map(encodeURIComponent).join("/")}` : undefined;
const plain = (html: string) => String(html || "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim();

async function signedInUser(req: Request) {
  const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!jwt) return null;
  const { data } = await admin.auth.getUser(jwt);
  return data?.user?.id || null;
}
async function blockedEitherWay(a: string, b: string) {
  const { count } = await admin.from("diary_blocks").select("blocker", { count: "exact", head: true })
    .or(`and(blocker.eq.${a},blocked.eq.${b}),and(blocker.eq.${b},blocked.eq.${a})`);
  return (count || 0) > 0;
}
async function areFriends(a: string, b: string) {
  const { count } = await admin.from("diary_friendships").select("id", { count: "exact", head: true }).eq("status", "accepted")
    .or(`and(requester.eq.${a},addressee.eq.${b}),and(requester.eq.${b},addressee.eq.${a})`);
  return (count || 0) > 0;
}
async function mutedFor(user: string): Promise<string[]> {
  const { data } = await admin.from("diary_notification_prefs").select("muted").eq("user_id", user).maybeSingle();
  return (data?.muted as string[]) || [];
}
const profileOf = async (id: string) =>
  (await admin.from("diary_profiles").select("display_name, username, avatar_path").eq("id", id).maybeSingle()).data;

// deno-lint-ignore no-explicit-any
async function deliver(user: string, payload: any, ttl: number, urgency: "normal" | "high") {
  const { data: subs } = await admin.from("diary_push_subscriptions").select("id, endpoint, p256dh, auth").eq("user_id", user);
  let sent = 0;
  const body = JSON.stringify({ icon: "/icons/icon-192.png", badge: "/icons/icon-192.png", ...payload });
  await Promise.all((subs || []).map(async (sub) => {
    const target = { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } };
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await webpush.sendNotification(target, body, { TTL: ttl, urgency, topic: String(payload.tag || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32) || undefined });
        sent++;
        return;
      } catch (e) {
        // deno-lint-ignore no-explicit-any
        const code = (e as any)?.statusCode;
        // The browser dropped this subscription (uninstalled, cleared, turned off): forget it
        if (code === 404 || code === 410) { await admin.from("diary_push_subscriptions").delete().eq("id", sub.id); return; }
        // Temporary trouble: one quick retry
        if ((code === 429 || code >= 500 || !code) && attempt === 0) { await new Promise((r) => setTimeout(r, 700)); continue; }
        console.error("push failed", code, String(e).slice(0, 200));
        return;
      }
    }
  }));
  return sent;
}

// ---------- Direct messages ----------
async function onMessage(me: string, id: string) {
  const { data: m } = await admin.from("diary_messages")
    .select("id, sender, recipient, body, attachments, deleted_at, vanish, expires_at, created_at").eq("id", id).maybeSingle();
  if (!m || m.sender !== me || !m.recipient || m.deleted_at) return json({ ok: false, reason: "not-found" }, 404);
  if (Date.now() - Date.parse(m.created_at) > 120000) return json({ ok: true, skipped: "old" }); // only fresh messages ring
  const to = m.recipient;
  const [blocked, muted, prefs, who] = await Promise.all([
    blockedEitherWay(me, to),
    mutedFor(to),
    admin.from("diary_chat_prefs").select("muted_until").eq("user_id", to).eq("kind", "dm").eq("peer", me).maybeSingle(),
    profileOf(me),
  ]);
  if (blocked || !who) return json({ ok: true, skipped: "blocked" });
  if (muted.includes("messages")) return json({ ok: true, skipped: "muted" });
  const until = prefs.data?.muted_until;
  if (until && Date.parse(until) > Date.now()) return json({ ok: true, skipped: "chat-muted" });

  const { count } = await admin.from("diary_messages").select("id", { count: "exact", head: true }).eq("sender", me).eq("recipient", to)
    .is("read_at", null).is("deleted_at", null).gt("created_at", new Date(Date.now() - 86400000).toISOString());
  const name = who.display_name || (who.username ? `@${who.username}` : "Someone");
  const previews = !muted.includes("nopreview") && !m.vanish && !m.expires_at;
  // deno-lint-ignore no-explicit-any
  const att = Array.isArray(m.attachments) && m.attachments.length ? (m.attachments as any[])[0] : null;
  const kind = att ? String(att.kind || att.type || "") : "";
  const media = !att ? "" : /image|photo/.test(kind) ? "📷 Photo" : /video/.test(kind) ? "🎥 Video" : /audio|voice/.test(kind) ? "🎤 Voice message" : /location/.test(kind) ? "📍 Location" : "📎 Attachment";
  const unread = Math.max(1, count || 1);
  const sent = await deliver(to, {
    type: "message",
    title: unread > 1 ? `${name} (${unread} new messages)` : name,
    body: previews ? (plain(m.body).slice(0, 160) || media || "Sent you a message") : "Sent you a message",
    url: `/#/messages/chat/${me}`,
    tag: `dm-${me}`, // one alert per conversation, updated as messages arrive
    icon: avatarUrl(who.avatar_path), renotify: true, timestamp: Date.parse(m.created_at),
  }, 6 * 3600, "high");
  return json({ ok: true, sent });
}

// ---------- Calls ----------
async function onRing(me: string, input: { callee?: string; topic?: string; video?: boolean }, secret: string) {
  const callee = String(input.callee || "");
  if (!uuid.test(callee) || callee === me) return json({ ok: false, reason: "bad-request" }, 400);
  const topic = `diary_call:d:${[me, callee].sort().join(":")}`;
  if (input.topic !== topic) return json({ ok: false, reason: "bad-topic" }, 400);
  const [blocked, presence, who, muted] = await Promise.all([
    blockedEitherWay(me, callee),
    admin.from("diary_presence").select("allow_calls").eq("user_id", callee).maybeSingle(),
    profileOf(me),
    mutedFor(callee),
  ]);
  if (blocked || !who || !(await profileOf(callee))) return json({ ok: false, reason: "unavailable" }, 403);
  const allow = presence.data?.allow_calls || "friends";
  if (allow === "nobody" || !(await areFriends(me, callee))) return json({ ok: false, reason: "not-allowed" }, 403);

  const ring: Ring = { i: crypto.randomUUID(), c: me, e: callee, t: topic, v: !!input.video, x: Date.now() + 45000 };
  const token = await signRing(secret, ring);
  let sent = 0;
  if (!muted.includes("calls")) {
    const name = who.display_name || (who.username ? `@${who.username}` : "Someone");
    sent = await deliver(callee, {
      type: "call",
      title: `${name} is calling`, body: ring.v ? "Cordial video call" : "Cordial voice call",
      url: `/?ring=${encodeURIComponent(token)}`, tag: `call-${ring.i}`, icon: avatarUrl(who.avatar_path),
      requireInteraction: true, renotify: true, vibrate: [600, 300, 600, 300, 600],
      actions: [{ action: "answer", title: "Answer" }, { action: "decline", title: "Decline" }],
      decline: { invite: ring.i, token },
    }, 45, "high");
  }
  return json({ ok: true, ring: token, sent });
}

async function onMissed(me: string, token: string, secret: string) {
  const r = await readRing(secret, token);
  if (!r || r.c !== me) return json({ ok: false, reason: "bad-ring" }, 403);
  if (Date.now() > r.x + 120000) return json({ ok: true, skipped: "old" });
  // In the person's notifications (their "calls" choice applies there too); once per ring
  const { count } = await admin.from("diary_notifications").select("id", { count: "exact", head: true })
    .eq("user_id", r.e).eq("actor", me).eq("type", "missed_call").eq("data->>ring", r.i);
  if (count) return json({ ok: true, skipped: "already" });
  const { data: row } = await admin.from("diary_notifications")
    .insert({ user_id: r.e, actor: me, type: "missed_call", data: { video: r.v, ring: r.i } }).select("id").maybeSingle();
  if (!row) return json({ ok: true, skipped: "muted" }); // their choices filtered it out
  const who = await profileOf(me);
  const name = who?.display_name || "Someone";
  const sent = await deliver(r.e, {
    type: "missed_call",
    title: `Missed ${r.v ? "video call" : "call"} from ${name}`, body: "Tap to call back",
    url: `/#/messages/chat/${me}`, tag: `call-${r.i}`, // replaces the ringing alert
    icon: avatarUrl(who?.avatar_path), renotify: false,
  }, 24 * 3600, "normal");
  return json({ ok: true, sent });
}

async function onDecline(token: string, secret: string) {
  const r = await readRing(secret, token);
  if (!r) return json({ ok: false, reason: "bad-ring" }, 403);
  if (Date.now() > r.x + 30000) return json({ ok: true, skipped: "old" });
  // Same message the open app sends when you tap Decline on the ringing screen
  const res = await fetch(`${URL_}/realtime/v1/api/broadcast`, {
    method: "POST",
    headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, "Content-Type": "application/json" },
    body: JSON.stringify({ messages: [{ topic: `diary_ring:${r.c}`, event: "decline", payload: { from: r.e }, private: true }] }),
  });
  return json({ ok: res.ok });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ ok: false }, 405);
  let cfg;
  try { cfg = await getConfig(); } catch (e) { console.error(String(e)); return json({ ok: false, reason: "not-configured" }, 503); }
  // deno-lint-ignore no-explicit-any
  let input: any = {};
  try { input = await req.json(); } catch { /* handled below */ }
  const action = String(input.action || "");

  if (action === "decline") return onDecline(String(input.ring || ""), cfg.trigger_secret);

  const me = await signedInUser(req);
  if (!me) return json({ ok: false, reason: "sign-in" }, 401);
  try {
    if (action === "message" && /^\d+$/.test(String(input.id || ""))) return await onMessage(me, String(input.id));
    if (action === "ring") return await onRing(me, input, cfg.trigger_secret);
    if (action === "missed") return await onMissed(me, String(input.ring || ""), cfg.trigger_secret);
  } catch (e) {
    console.error(action, String(e).slice(0, 300));
    return json({ ok: false, reason: "error" }, 500);
  }
  return json({ ok: false, reason: "bad-request" }, 400);
});
