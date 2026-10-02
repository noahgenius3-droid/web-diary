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
function message(type: string, name: string, d: any = {}, actor = "") {
  const profile = actor ? `/#/profile/${actor}` : "/#/messages";
  switch (type) {
    case "friend_request":
      return d.note
        ? { title: `${name} said hello 👋`, body: `“${String(d.note).slice(0, 140)}” — accept to start chatting`, url: "/#/messages", tag: "friend-request" }
        : { title: "New friend request", body: `${name} wants to be friends on Cordial`, url: "/#/messages", tag: "friend-request" };
    case "friend_accepted":
      return { title: "You're now friends", body: `${name} accepted your friend request — say hi!`, url: "/#/messages", tag: "friend-accepted" };
    case "new_follower":
      return { title: "New follower", body: `${name} started following you`, url: profile, tag: `new-follower-${actor}` };
    case "mention":
      return { title: `${name} mentioned you`, body: `${d.community_name ? `In ${d.community_name}: ` : ''}${d.snippet || ''}`.slice(0, 180), url: `/#/community/${d.community_id}/m/${d.message_id}`, tag: `gc-${d.community_id}` };
    case "reply":
      return { title: `${name} replied to you`, body: `${d.community_name ? `In ${d.community_name}: ` : ''}${d.snippet || ''}`.slice(0, 180), url: `/#/community/${d.community_id}/m/${d.message_id}`, tag: `gc-${d.community_id}` };
    case "new_login":
      return { title: "New sign-in to Cordial", body: `Your account was opened on ${d.label || 'a new device'}. Not you? Change your password.`, url: "/#/settings", tag: "new-login" };
    case "live_started":
      return { title: `🔴 ${name} is live`, body: "Tap to watch now", url: "/#/explore", tag: "live" };
    case "space_live":
      return { title: `🎙️ ${name} opened a space`, body: `“${String(d.snippet || "Live audio room").slice(0, 120)}” — tap to listen in`, url: `/?space=${d.space_id}`, tag: `space-${d.space_id}` };
    case "call_started":
      return { title: `📞 ${name} started a ${d.video ? "video" : "voice"} call`, body: `In ${d.emoji ? d.emoji + " " : ""}${d.community_name || "your group"} · tap to join`, url: `/#/community/${d.community_id}`, tag: `call-${d.community_id}` };
    case "post_activity":
      return { title: `${name} commented on a post you follow`, body: `${d.community_name ? `In ${d.community_name}: ` : ""}${d.snippet || ""}`.slice(0, 180), url: d.kind === "entry" ? `/#/post/${d.entry_id}` : `/#/post/g-${d.post_id}`, tag: `watch-${d.entry_id || d.post_id}` };
    case "comment_reply":
      return { title: `${name} replied to your comment`, body: String(d.snippet || "").slice(0, 180), url: d.entry_id ? `/#/post/${d.entry_id}` : d.post_id ? `/#/post/g-${d.post_id}` : "/#/reels", tag: `creply-${d.entry_id || d.post_id || d.reel_id}` };
    case "tagged":
      return { title: `${name} tagged you in ${d.kind === "comment" ? "a comment" : "a post"}`, body: String(d.snippet || "").slice(0, 180), url: d.entry_id ? `/#/post/${d.entry_id}` : d.post_id ? `/#/post/g-${d.post_id}` : "/#/reels", tag: `tag-${d.comment_id || d.entry_id || d.post_id}` };
    case "entry_like":
    case "entry_reaction": {
      const entry = d.entry_id || d.entry;
      return { title: `${name} reacted ${d.emoji || "👍"} to your post`, body: d.snippet ? `“${String(d.snippet).slice(0, 140)}”` : "Tap to see your post", url: entry ? `/#/post/${entry}` : "/#/feed", tag: `like-${entry || "post"}` };
    }
    case "post_like":
      return { title: `${name} reacted ${d.emoji || "👍"} to your post`, body: d.community_name ? `In ${d.community_name}` : "Tap to see your post", url: d.post_id ? `/#/post/g-${d.post_id}` : "/#/feed", tag: `like-g-${d.post_id || "post"}` };
    case "reel_like":
      return { title: `${name} liked your reel ❤️`, body: d.snippet ? `“${String(d.snippet).slice(0, 140)}”` : "Tap to watch it", url: "/#/reels", tag: `like-reel-${d.reel_id || ""}` };
    case "new_post":
      return {
        title: `${name} posted on the Feed`,
        body: d.snippet ? String(d.snippet).slice(0, 180) : d.photos ? `Shared ${d.photos === 1 ? "a photo" : `${d.photos} photos`}` : "Tap to see it",
        url: d.entry_id ? `/#/post/${d.entry_id}` : "/#/feed",
        tag: `new-post-${actor}`,
      };
    case "referral_joined":
      return { title: `🎉 ${name} joined Cordial`, body: "They signed up with your invite — you're now friends. Say hi!", url: profile, tag: `ref-${d.referred}` };
    case "support_reply":
      return { title: d.ai ? "Cordial Assistant (AI) replied" : "Cordial replied to you", body: String(d.snippet || d.subject || "Tap to read").slice(0, 200), url: "/#/settings", tag: `support-${d.ticket}` };
    case "helpline_handoff":
      return { title: "🙋 A helpline conversation needs you", body: `${String(d.subject || "").slice(0, 100)}${d.reason ? ` — ${String(d.reason).slice(0, 100)}` : ""}`, url: "/#/admin", tag: `handoff-${d.ticket}` };
    case "announcement":
      return { title: String(d.title || "News from Cordial").slice(0, 120), body: String(d.snippet || "").slice(0, 220), url: "/#/feed", tag: `announce-${d.announcement || "cordial"}` };
    case "scheduled_published":
      return {
        title: d.target === "message" ? "Your scheduled message was sent" : d.target === "group" ? `Your scheduled post is live in ${d.community_name || "your group"}` : "Your scheduled post is live",
        body: d.snippet || "",
        url: d.target === "feed" ? `/#/post/${d.ref}` : d.target === "group" ? `/#/post/g-${d.ref}` : "/#/messages",
        tag: `sched-${d.ref}`,
      };
    case "scheduled_failed":
      return { title: "A scheduled post couldn't go out", body: `${d.reason || "Something went wrong"} — ${d.snippet || ""}`.slice(0, 180), url: "/#/scheduled", tag: `sched-${d.scheduled_id}` };
    case "game_invite":
      return { title: `${name} challenged you to Wordplay`, body: "Your seven letters are waiting — tap to play", url: `/#/play/m/${d.match_id}`, tag: `wp-${d.match_id}` };
    case "game_turn":
      return {
        title: "Your turn in Wordplay",
        body: d.kind === "pass" ? `${name} passed` : d.kind === "swap" ? `${name} swapped letters` : d.kind === "resign" ? `${name} left the match` : `${name} played ${d.word || "a word"} for ${d.points || 0}`,
        url: `/#/play/m/${d.match_id}`,
        tag: `wp-${d.match_id}`,
      };
    case "game_over":
      return { title: d.won ? "You won at Wordplay! 🏆" : "Your Wordplay match is over", body: d.resigned ? `${name} resigned` : `You finished on ${d.score ?? 0} points`, url: `/#/play/m/${d.match_id}`, tag: `wp-${d.match_id}` };
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
  const text = message(n.type, actor?.display_name || (actor?.username ? `@${actor.username}` : "Someone"), (n as any).data || {}, String(n.actor || ""));
  if (!text) return new Response("Skipped", { status: 200 });

  const { data: subs } = await admin.from("diary_push_subscriptions").select("id, endpoint, p256dh, auth").eq("user_id", n.user_id);
  const payload = JSON.stringify({ ...text, id: n.id, type: n.type, icon: "/icons/icon-192.png", badge: "/icons/icon-192.png" });
  let sent = 0;
  await Promise.all((subs || []).map(async (sub) => {
    try {
      await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, payload, { TTL: n.type === "call_started" ? 120 : n.type === "space_live" ? 3600 : 86400, urgency: n.type === "new_post" || n.type.endsWith("_like") || n.type === "entry_reaction" ? "normal" : "high" });
      sent++;
    } catch (e: any) {
      // The browser dropped this subscription (uninstalled, cleared, turned off): forget it
      if (e?.statusCode === 404 || e?.statusCode === 410) await admin.from("diary_push_subscriptions").delete().eq("id", sub.id);
      else console.error("push failed", e?.statusCode, String(e?.body || e?.message || e).slice(0, 300));
    }
  }));
  return new Response(JSON.stringify({ sent }), { headers: { "Content-Type": "application/json" } });
});
