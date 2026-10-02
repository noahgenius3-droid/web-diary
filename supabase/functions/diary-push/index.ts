// Cordial's push delivery service: sends alerts to a person's phones and computers, even when Cordial is closed.
// Called only by the database (private.diary_push_dispatch) with a shared secret — never by browsers.
//   { notification_id }        activity: likes, comments, follows, new posts, live, missed calls…
//   { event: "message", id }   a direct message
//   { event: "call", id }      an incoming call (high priority, short-lived, Answer / Decline)
// The database has already decided the person should be alerted (preferences, blocks, mutes, devices). Here we
// build the alert, make sure each event is sent once (diary_push_log), deliver to every device, retry briefly on
// temporary errors, and forget subscriptions the browser has dropped.
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

type Alert = {
  title: string; body: string; url: string; tag: string;
  icon?: string; image?: string; actions?: { action: string; title: string }[]; requireInteraction?: boolean;
  kind?: string; decline?: { invite: string; token: string }; vibrate?: number[]; timestamp?: number; renotify?: boolean;
};

// What each activity notification says, and where tapping it goes
// deno-lint-ignore no-explicit-any
function message(type: string, name: string, d: any = {}, actor = ""): Alert | null {
  const profile = actor ? `/#/profile/${actor}` : "/#/messages";
  switch (type) {
    case "friend_request":
      return d.note
        ? { title: `${name} said hello 👋`, body: `“${String(d.note).slice(0, 140)}” — accept to start chatting`, url: "/#/messages", tag: "friend-request" }
        : { title: "New friend request", body: `${name} wants to be friends on Cordial`, url: "/#/messages", tag: "friend-request" };
    case "friend_accepted":
      return { title: "You're now friends", body: `${name} accepted your friend request — say hi!`, url: actor ? `/#/messages/chat/${actor}` : "/#/messages", tag: "friend-accepted" };
    case "new_follower":
      return { title: "New follower", body: `${name} started following you`, url: profile, tag: `new-follower-${actor}` };
    case "mention":
      return { title: `${name} mentioned you`, body: `${d.community_name ? `In ${d.community_name}: ` : ''}${d.snippet || ''}`.slice(0, 180), url: `/#/community/${d.community_id}/m/${d.message_id}`, tag: `gc-${d.community_id}` };
    case "reply":
      return { title: `${name} replied to you`, body: `${d.community_name ? `In ${d.community_name}: ` : ''}${d.snippet || ''}`.slice(0, 180), url: `/#/community/${d.community_id}/m/${d.message_id}`, tag: `gc-${d.community_id}` };
    case "new_login":
      return { title: "New sign-in to Cordial", body: `Your account was opened on ${d.label || 'a new device'}. Not you? Change your password.`, url: "/#/settings", tag: "new-login" };
    case "live_started":
      return { title: `🔴 ${name} is live`, body: "Tap to watch now", url: d.live_id ? `/?live=${d.live_id}` : "/#/explore", tag: `live-${actor}` };
    case "space_live":
      return { title: `🎙️ ${name} opened a space`, body: `“${String(d.snippet || "Live audio room").slice(0, 120)}” — tap to listen in`, url: `/?space=${d.space_id}`, tag: `space-${d.space_id}` };
    case "call_started":
      return { title: `📞 ${name} started a ${d.video ? "video" : "voice"} call`, body: `In ${d.emoji ? d.emoji + " " : ""}${d.community_name || "your group"} · tap to join`, url: `/#/community/${d.community_id}`, tag: `call-${d.community_id}` };
    case "missed_call":
      // Same tag as the ringing alert, so it replaces it
      return { title: `Missed ${d.video ? "video call" : "call"} from ${name}`, body: "Tap to call back", url: actor ? `/#/messages/chat/${actor}` : "/#/messages", tag: d.invite ? `call-${d.invite}` : `missed-${actor}`, kind: "missed_call" };
    case "post_activity":
      return { title: `${name} commented on a post you follow`, body: `${d.community_name ? `In ${d.community_name}: ` : ""}${d.snippet || ""}`.slice(0, 180), url: d.kind === "entry" ? `/#/post/${d.entry_id}` : `/#/post/g-${d.post_id}`, tag: `watch-${d.entry_id || d.post_id}` };
    case "entry_comment":
    case "post_comment":
    case "reel_comment":
      return { title: `${name} commented on your ${type === "reel_comment" ? "reel" : "post"}`, body: String(d.snippet || "").slice(0, 180), url: d.entry_id ? `/#/post/${d.entry_id}` : d.post_id ? `/#/post/g-${d.post_id}` : "/#/reels", tag: `comment-${d.entry_id || d.post_id || d.reel_id}` };
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
      // One alert per person (the tag), newest replacing older
      return {
        title: `${name} posted something new`,
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

const avatarUrl = (path?: string | null) =>
  path ? `${Deno.env.get("SUPABASE_URL")}/storage/v1/object/public/diary-avatars/${String(path).split("/").map(encodeURIComponent).join("/")}` : undefined;
const plain = (html: string) => String(html || "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim();

// A direct message: "Ada: Are you coming tomorrow?" (or just "New message" when previews are off / the chat vanishes)
// deno-lint-ignore no-explicit-any
async function messageAlert(id: string): Promise<{ user: string; alert: Alert } | null> {
  const { data: m } = await admin.from("diary_messages").select("id, sender, recipient, body, attachments, deleted_at, vanish, expires_at, created_at").eq("id", id).maybeSingle();
  if (!m || m.deleted_at || !m.recipient) return null;
  const [{ data: who }, { data: prefs }, { count }] = await Promise.all([
    admin.from("diary_profiles").select("display_name, avatar_path").eq("id", m.sender).maybeSingle(),
    admin.from("diary_notification_prefs").select("show_previews").eq("user_id", m.recipient).maybeSingle(),
    admin.from("diary_messages").select("id", { count: "exact", head: true }).eq("sender", m.sender).eq("recipient", m.recipient)
      .is("read_at", null).is("deleted_at", null).gt("created_at", new Date(Date.now() - 86400000).toISOString()),
  ]);
  if (!who) return null;
  const name = who.display_name || "Someone";
  const previews = prefs?.show_previews !== false && !m.vanish && !m.expires_at;
  // deno-lint-ignore no-explicit-any
  const att = Array.isArray(m.attachments) && m.attachments.length ? (m.attachments as any[])[0] : null;
  const kind = att ? String(att.kind || att.type || "") : "";
  const media = !att ? "" : /image|photo/.test(kind) ? "📷 Photo" : /video/.test(kind) ? "🎥 Video" : /audio|voice/.test(kind) ? "🎤 Voice message" : /location/.test(kind) ? "📍 Location" : "📎 Attachment";
  const text = plain(m.body).slice(0, 160);
  const unread = Math.max(1, count || 1);
  return {
    user: m.recipient,
    alert: {
      title: unread > 1 ? `${name} (${unread} new messages)` : name,
      body: previews ? (text || media || "Sent you a message") : `${name} sent you a message`,
      url: `/#/messages/chat/${m.sender}`,
      tag: `dm-${m.sender}`, // one alert per conversation, updated as messages arrive
      icon: avatarUrl(who.avatar_path), renotify: true, kind: "message", timestamp: Date.parse(m.created_at),
    },
  };
}

// An incoming call: stays on screen with Answer / Decline; replaced by "Missed call" if nobody answers
async function callAlert(id: string): Promise<{ user: string; alert: Alert; ttl: number } | null> {
  const { data: inv } = await admin.from("diary_call_invites").select("id, caller, callee, video, status, decline_token, created_at").eq("id", id).maybeSingle();
  if (!inv || inv.status !== "ringing") return null;
  const age = Date.now() - Date.parse(inv.created_at);
  if (age > 40000) return null; // too late to ring
  const { data: who } = await admin.from("diary_profiles").select("display_name, avatar_path").eq("id", inv.caller).maybeSingle();
  if (!who) return null;
  return {
    user: inv.callee,
    ttl: Math.max(5, Math.round((45000 - age) / 1000)),
    alert: {
      title: `${who.display_name || "Someone"} is calling`, body: inv.video ? "Cordial video call" : "Cordial voice call",
      url: `/?ring=${inv.id}`, tag: `call-${inv.id}`, icon: avatarUrl(who.avatar_path), requireInteraction: true, renotify: true,
      actions: [{ action: "answer", title: "Answer" }, { action: "decline", title: "Decline" }],
      decline: { invite: inv.id, token: inv.decline_token }, vibrate: [600, 300, 600, 300, 600], kind: "call",
    },
  };
}

// deno-lint-ignore no-explicit-any
async function deliver(user: string, payload: any, ttl: number, urgency: "very-low" | "low" | "normal" | "high") {
  const { data: subs } = await admin.from("diary_push_subscriptions").select("id, endpoint, p256dh, auth, failures").eq("user_id", user).eq("permission", "granted");
  let sent = 0, failed = 0;
  let lastError = "";
  const body = JSON.stringify(payload);
  await Promise.all((subs || []).map(async (sub) => {
    const target = { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } };
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await webpush.sendNotification(target, body, { TTL: ttl, urgency, topic: String(payload.tag || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32) || undefined });
        sent++;
        if (sub.failures) await admin.from("diary_push_subscriptions").update({ failures: 0, last_error: null }).eq("id", sub.id);
        return;
      } catch (e: any) {
        const code = e?.statusCode;
        // The browser dropped this subscription (uninstalled, cleared, turned off): forget it
        if (code === 404 || code === 410) { await admin.from("diary_push_subscriptions").delete().eq("id", sub.id); failed++; return; }
        // Temporary trouble: one quick retry
        if ((code === 429 || (code >= 500 && code < 600) || !code) && attempt === 0) { await new Promise((r) => setTimeout(r, 800)); continue; }
        failed++;
        lastError = `${code || ""} ${String(e?.body || e?.message || e)}`.slice(0, 300);
        const failures = (sub.failures || 0) + 1;
        // A device that keeps failing is let go
        if (failures >= 8) await admin.from("diary_push_subscriptions").delete().eq("id", sub.id);
        else await admin.from("diary_push_subscriptions").update({ failures, last_error: lastError }).eq("id", sub.id);
        console.error("push failed", lastError);
        return;
      }
    }
  }));
  return { sent, failed, error: lastError };
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

  // deno-lint-ignore no-explicit-any
  let input: any = {};
  try { input = await req.json(); } catch { /* handled below */ }
  const uuid = /^[0-9a-f-]{36}$/i;
  let user = "", alert: Alert | null = null, ttl = 86400, urgency: "normal" | "high" = "high", kind = "", key = "";

  if (input.event === "message" && /^\d+$|^[0-9a-f-]{36}$/i.test(String(input.id || ""))) {
    key = `message:${input.id}`; kind = "message";
    const r = await messageAlert(String(input.id));
    if (r) { user = r.user; alert = r.alert; ttl = 6 * 3600; }
  } else if (input.event === "call" && uuid.test(String(input.id || ""))) {
    key = `call:${input.id}`; kind = "call";
    const r = await callAlert(String(input.id));
    if (r) { user = r.user; alert = r.alert; ttl = r.ttl; }
  } else if (uuid.test(String(input.notification_id || ""))) {
    key = `notification:${input.notification_id}`;
    const { data: n } = await admin.from("diary_notifications")
      .select("id, user_id, actor, type, data, actor_profile:diary_profiles!diary_notifications_actor_fkey(display_name, username, avatar_path)")
      .eq("id", input.notification_id).maybeSingle();
    if (n) {
      // deno-lint-ignore no-explicit-any
      const actor = (n as any).actor_profile;
      kind = n.type;
      user = n.user_id;
      // deno-lint-ignore no-explicit-any
      alert = message(n.type, actor?.display_name || (actor?.username ? `@${actor.username}` : "Someone"), (n as any).data || {}, String(n.actor || ""));
      if (alert && actor?.avatar_path) alert.icon = avatarUrl(actor.avatar_path);
      ttl = n.type === "call_started" ? 120 : n.type === "space_live" || n.type === "live_started" ? 3600 : 86400;
      urgency = n.type === "new_post" || n.type.endsWith("_like") || n.type === "entry_reaction" ? "normal" : "high";
    }
  } else {
    return new Response("Bad request", { status: 400 });
  }
  if (!alert || !user) return new Response("Skipped", { status: 200 });

  // Each event is delivered once, however many times we're asked
  const { error: dupe } = await admin.from("diary_push_log").insert({ dedup_key: key, user_id: user, kind });
  if (dupe) return new Response("Already sent", { status: 200 });

  const payload = { ...alert, type: kind, icon: alert.icon || "/icons/icon-192.png", badge: "/icons/icon-192.png" };
  const result = await deliver(user, payload, ttl, urgency);
  await admin.from("diary_push_log").update({ sent: result.sent, failed: result.failed, error: result.error || null }).eq("dedup_key", key);
  return new Response(JSON.stringify(result), { headers: { "Content-Type": "application/json" } });
});
