// Sends push notifications to a person's phones and computers, even when Cordial is closed.
// Called by the database (trigger on diary_notifications) with a shared secret — not by browsers.
// Keys live in private.diary_push_config and are read with the service role.
import webpush from "npm:web-push@3.6.7";
import { createClient } from "npm:@supabase/supabase-js@2";

const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});

let config: { vapid_public: string; vapid_private: string; trigger_secret: string } | null = null;
async function getConfig() {
  if (config) return config;
  const { data, error } = await admin.rpc("diary_push_config_get");
  if (error || !data || !data[0]) throw new Error("Push isn't configured");
  config = data[0];
  webpush.setVapidDetails("https://web-diary-gamma.vercel.app", config!.vapid_public, config!.vapid_private);
  return config!;
}

// What each notification says on the lock screen, and where tapping it goes
// deno-lint-ignore no-explicit-any
function message(type: string, name: string, d: any = {}) {
  switch (type) {
    case "friend_request":
      return { title: "New friend request", body: `${name} wants to be friends on Cordial`, url: "/#/messages", tag: "friend-request" };
    case "friend_accepted":
      return { title: "You're now friends", body: `${name} accepted your friend request — say hi!`, url: "/#/messages", tag: "friend-accepted" };
    case "new_follower":
      return { title: "New follower", body: `${name} started following you`, url: "/#/settings", tag: "new-follower" };
    case "mention":
      return { title: `${name} mentioned you`, body: `${d.community_name ? `In ${d.community_name}: ` : ''}${d.snippet || ''}`.slice(0, 180), url: `/#/community/${d.community_id}/m/${d.message_id}`, tag: `gc-${d.community_id}` };
    case "reply":
      return { title: `${name} replied to you`, body: `${d.community_name ? `In ${d.community_name}: ` : ''}${d.snippet || ''}`.slice(0, 180), url: `/#/community/${d.community_id}/m/${d.message_id}`, tag: `gc-${d.community_id}` };
    case "live_started":
      return { title: `🔴 ${name} is live`, body: "Tap to watch now", url: "/#/explore", tag: "live" };
    default:
      return null;
  }
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  let cfg;
  try {
    cfg = await getConfig();
  } catch (e) {
    console.error(String(e));
    return new Response("Not configured", { status: 503 });
  }
  if (req.headers.get("x-push-secret") !== cfg.trigger_secret) return new Response("Forbidden", { status: 403 });

  let id = "";
  try {
    id = String((await req.json()).notification_id || "");
  } catch { /* handled below */ }
  if (!/^[0-9a-f-]{36}$/i.test(id)) return new Response("Bad request", { status: 400 });

  const { data: n } = await admin.from("diary_notifications")
    .select("id, user_id, actor, type, data, actor_profile:diary_profiles!diary_notifications_actor_fkey(display_name, username)")
    .eq("id", id).maybeSingle();
  if (!n) return new Response("Gone", { status: 200 });
  const actor = (n as any).actor_profile;
  const text = message(n.type, actor?.display_name || (actor?.username ? `@${actor.username}` : "Someone"), (n as any).data || {});
  if (!text) return new Response("Skipped", { status: 200 });

  const { data: subs } = await admin.from("diary_push_subscriptions").select("id, endpoint, p256dh, auth").eq("user_id", n.user_id);
  const payload = JSON.stringify({ ...text, id: n.id, type: n.type, icon: "/icons/icon-192.png", badge: "/icons/icon-192.png" });
  let sent = 0;
  await Promise.all((subs || []).map(async (sub) => {
    try {
      await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, payload, { TTL: 86400, urgency: "high" });
      sent++;
    } catch (e: any) {
      // The browser dropped this subscription (uninstalled, cleared, turned off): forget it
      if (e?.statusCode === 404 || e?.statusCode === 410) await admin.from("diary_push_subscriptions").delete().eq("id", sub.id);
      else console.error("push failed", e?.statusCode, String(e?.body || e?.message || e).slice(0, 300));
    }
  }));
  return new Response(JSON.stringify({ sent }), { headers: { "Content-Type": "application/json" } });
});
