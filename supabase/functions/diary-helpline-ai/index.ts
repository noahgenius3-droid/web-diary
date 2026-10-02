// The Cordial Assistant: answers members on the helpline in the founder's voice.
//   POST { ticket: "<uuid>" }  with the member's own JWT, after they send a message.
// It replies only when the member wrote last, the assistant is on for the conversation, and the reply cap isn't
// reached. Every reply is stored as an AI message, so the app labels it "Cordial Assistant (AI)" — it never claims
// to be a person. It hands the conversation to an admin (ai_active = false, admins notified) when it can't help,
// when the member asks for a person, or for safety, account changes, rewards decisions, recovery, payments or
// legal matters. It has no tools: it can explain and guide, never change anything.
//
// Secrets (Supabase → Edge Functions → Secrets): ANTHROPIC_API_KEY (preferred) or GEMINI_API_KEY.
import Anthropic from "npm:@anthropic-ai/sdk";
import { createClient } from "npm:@supabase/supabase-js@2";

const URL_ = Deno.env.get("SUPABASE_URL")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANTHROPIC_KEY = Deno.env.get("ANTHROPIC_API_KEY")?.trim();
const GEMINI_KEY = Deno.env.get("GEMINI_API_KEY")?.trim();
const GEMINI_MODEL = Deno.env.get("GEMINI_MODEL")?.trim() || "gemini-flash-latest";
const CLAUDE_MODEL = "claude-sonnet-5-5";
const anthropic = ANTHROPIC_KEY ? new Anthropic({ apiKey: ANTHROPIC_KEY }) : null;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

// What the assistant knows about Cordial (keep in step with the app)
const CORDIAL = `Cordial is a private diary and a friendly social app.
- Notes: a private diary on the person's device — folders, templates, voice notes, photos, calendar, insights, highlights, archive and trash. Signed in, notes are backed up to their account (Settings → Your data → Backup). Settings → Your data → Export downloads everything.
- Feed: posts with photos and an optional sound, shared with Friends or Everyone; reactions (hold Like for more), comments, reposts, sending to friends, saving. Stories last 24 hours. Reels are videos up to 3 minutes. Live streams and audio rooms (Spaces).
- People: friends, followers, profiles, verified ticks (requested in Settings; the Cordial team reviews them).
- Groups (Communities) with posts, group chat and calls. Chats: direct messages, voice and video calls.
- Playnote: daily trivia, question of the day, Bible and brain challenges, a weekly challenge, puzzles (Five, Word search, Sudoku, Memory, Maths sprint, Sliding puzzle) and Wordplay with friends. Points, XP, levels, badges and leaderboards. A streak counts days in a row with daily trivia finished.
- Safety: block or report someone from their profile's ⋯ menu, or report a post or message. Moderators review reports. Privacy options are in Settings → Privacy & security.
- Account: change password in Settings → Account; forgotten password — on the sign-in screen type your email and tap "Forgot password?" for a reset link. Delete account: Settings → Account (permanent).
- If something isn't working: reload the app (Settings → Your data → Reload the app), check the connection, update the browser.`;

function systemPrompt(voice: string, notes: string, member: { name: string; category: string; subject: string; status: string; reason: string | null }) {
  return `You are the Cordial Assistant, the AI that answers Cordial's helpline on behalf of ${voice}, Cordial's founder.

WHO YOU ARE
- You are an AI. Reply in ${voice}'s voice — warm, personal, plain-spoken, like the founder writing back himself — but never claim to be ${voice} or any human. If asked whether you are a person, a bot, or ${voice}, say clearly that you're Cordial's AI assistant and that ${voice} or the team can step in.
- Write like a caring founder: short paragraphs, no corporate tone, no markdown headings, at most one emoji. Use the member's first name now and then.

WHAT YOU CAN DO
- Explain how Cordial works, guide people step by step, troubleshoot, and reassure. Use only the facts below; if you're not sure, say so and hand over rather than guess.
- You cannot change anything: no account changes, unbanning, refunds, granting rewards/XP/coins/badges, restoring content, verifying people, or reading anyone's messages. Never promise those.

HAND OVER TO A PERSON when any of these is true:
- the member asks for a human, the founder, or "a real person";
- safety: harassment, threats, abuse, self-harm, someone in danger (answer with care first — and for self-harm or danger, encourage them to contact local emergency services or a trusted person right now);
- account recovery, a hacked account, a suspension or ban, deleting data on their behalf, payments, rewards decisions, verification decisions, or legal requests;
- you can't solve it after a couple of tries, or they're upset with the answer.
When you hand over, tell them kindly that ${voice} or the team will pick this up personally, then on the LAST line write exactly:
[[HANDOFF: short reason | priority]]   where priority is one of low, normal, high, urgent (urgent for safety).
Otherwise do not write that line.

CORDIAL
${CORDIAL}
${notes ? `\nFROM ${voice.toUpperCase()} (tone and facts to follow)\n${notes}` : ""}

THIS CONVERSATION
- Member: ${member.name}
- Topic: ${member.category} — "${member.subject}"
- Their account: ${member.status}${member.reason ? ` (reason given: ${member.reason})` : ""}`;
}

type Msg = { role: "user" | "assistant"; content: string };
async function generate(system: string, messages: Msg[]): Promise<string> {
  if (anthropic) {
    const res = await anthropic.messages.create({ model: CLAUDE_MODEL, max_tokens: 900, system, messages });
    return res.content.map((b) => (b.type === "text" ? b.text : "")).join("").trim();
  }
  if (GEMINI_KEY) {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": GEMINI_KEY },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: messages.map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] })),
        generationConfig: { maxOutputTokens: 900 },
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error?.message || `Gemini ${res.status}`);
    return (data?.candidates?.[0]?.content?.parts || []).map((p: { text?: string }) => p.text || "").join("").trim();
  }
  throw new Error("no-provider");
}

// Plain safety net: obvious danger words always reach a person, whatever the model says
const DANGER = /\b(kill(ing)? myself|suicid\w*|end(ing)? my life|self[- ]?harm\w*|hurt(ing)? myself|want to die|don'?t want to (live|be here)|being abused|threaten(ed|ing)? to (kill|hurt)|in danger)/i;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const auth = req.headers.get("Authorization") || "";
  if (!auth.startsWith("Bearer ")) return json({ error: "Sign in first" }, 401);
  let body: { ticket?: string } = {};
  try { body = await req.json(); } catch { /* empty */ }
  const ticketId = String(body.ticket || "");
  if (!/^[0-9a-f-]{36}$/i.test(ticketId)) return json({ error: "Bad request" }, 400);

  const asMember = createClient(URL_, ANON, { global: { headers: { Authorization: auth } } });
  const { data: who } = await asMember.auth.getUser();
  if (!who?.user) return json({ error: "Sign in first" }, 401);
  const db = createClient(URL_, SERVICE, { auth: { persistSession: false } });

  const { data: t } = await db.from("diary_support_tickets").select("*").eq("id", ticketId).maybeSingle();
  if (!t || t.user_id !== who.user.id) return json({ error: "No such request" }, 404);
  const { data: settings } = await db.from("diary_helpline_settings").select("*").maybeSingle();
  if (!settings?.ai_enabled || !t.ai_active || t.status === "resolved") return json({ replied: false, why: "a person is handling this" });

  const { data: rows } = await db.from("diary_support_messages").select("body, from_staff, ai, internal, created_at")
    .eq("ticket_id", ticketId).eq("internal", false).order("created_at", { ascending: true }).limit(60);
  const msgs = rows || [];
  const last = msgs[msgs.length - 1];
  if (!last || last.from_staff) return json({ replied: false, why: "nothing new to answer" });
  const aiCount = msgs.filter((m) => m.ai).length;

  const notifyAdmins = async (reason: string, priority: string) => {
    const { data: admins } = await db.from("diary_app_admins").select("user_id");
    const rowsN = (admins || []).filter((a) => a.user_id !== t.user_id).map((a) => ({
      user_id: a.user_id, actor: t.user_id, type: "helpline_handoff",
      data: { ticket: t.id, ref: t.ref, subject: t.subject, reason: reason.slice(0, 200), priority },
    }));
    if (rowsN.length) await db.from("diary_notifications").insert(rowsN);
  };
  const handOver = async (reason: string, priority: string) => {
    await db.from("diary_support_tickets").update({
      ai_active: false, handoff_reason: reason.slice(0, 300), status: priority === "urgent" ? "escalated" : "open",
      priority: ["low", "normal", "high", "urgent"].includes(priority) ? priority : "high", updated_at: new Date().toISOString(),
    }).eq("id", t.id);
    await notifyAdmins(reason, priority);
  };

  const { data: profile } = await db.from("diary_profiles").select("display_name").eq("id", t.user_id).maybeSingle();
  const firstName = String(profile?.display_name || "there").split(" ")[0];
  const voice = settings.voice_name || "Noah";

  // Reply cap reached: a person takes it from here
  if (aiCount >= (settings.max_ai_replies || 12)) {
    const text = `Thanks for bearing with me, ${firstName}. I'm going to pass this to ${voice} and the team so a person can look at it properly — you'll hear back here.`;
    await db.from("diary_support_messages").insert({ ticket_id: t.id, from_staff: true, ai: true, body: text });
    await handOver("The assistant reached its reply limit", "normal");
    return json({ replied: true, handoff: true });
  }

  const { data: susp } = await db.from("diary_suspensions").select("until, reason").eq("user_id", t.user_id).maybeSingle();
  const suspended = susp && (!susp.until || Date.parse(susp.until) > Date.now());
  const system = systemPrompt(voice, settings.voice_notes || "", {
    name: firstName, category: t.category, subject: t.subject,
    status: suspended ? `suspended${susp.until ? ` until ${new Date(susp.until).toUTCString()}` : ""}` : "active", reason: suspended ? susp.reason : null,
  });
  // Conversation for the model: member turns as "user", earlier staff/AI replies as "assistant" (merged so roles alternate)
  const convo: Msg[] = [];
  for (const m of msgs) {
    const role: Msg["role"] = m.from_staff ? "assistant" : "user";
    const content = m.from_staff && !m.ai ? `[A Cordial team member wrote:] ${m.body}` : m.body;
    if (convo.length && convo[convo.length - 1].role === role) convo[convo.length - 1].content += `\n\n${content}`;
    else convo.push({ role, content });
  }
  if (convo[0]?.role === "assistant") convo.unshift({ role: "user", content: "(conversation started)" });

  let reply = "";
  try {
    reply = await generate(system, convo);
  } catch (e) {
    const why = String((e as Error).message || e);
    if (why === "no-provider") return json({ replied: false, why: "The assistant isn't set up yet" }, 503);
    console.error(why);
    return json({ replied: false, why: "The assistant couldn't answer just now" }, 502);
  }
  const m = reply.match(/\[\[HANDOFF:\s*([^|\]]*)\|?\s*(low|normal|high|urgent)?\s*\]\]\s*$/i);
  let text = reply.replace(/\[\[HANDOFF:[^\]]*\]\]\s*$/i, "").trim();
  const danger = DANGER.test(last.body);
  if (!text) text = `Thanks, ${firstName}. I'm passing this to ${voice} and the team so a person can help you directly — you'll hear back here.`;

  // Another reply may have landed while the model was writing (two quick messages): don't answer twice
  const { data: latest } = await db.from("diary_support_messages").select("from_staff").eq("ticket_id", t.id).eq("internal", false)
    .order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (latest?.from_staff) return json({ replied: false, why: "already answered" });
  await db.from("diary_support_messages").insert({ ticket_id: t.id, from_staff: true, ai: true, body: text.slice(0, 4000) });
  if (m || danger) {
    await handOver(danger ? "Possible safety concern — please check in" : (m![1] || "The member needs a person").trim(), danger ? "urgent" : (m![2] || "high").toLowerCase());
  } else {
    await db.from("diary_support_tickets").update({ status: "pending", updated_at: new Date().toISOString() }).eq("id", t.id);
  }
  await db.from("diary_notifications").insert({
    user_id: t.user_id, actor: null, type: "support_reply", data: { ticket: t.id, ref: t.ref, subject: t.subject, snippet: text.slice(0, 180), ai: true },
  });
  return json({ replied: true, handoff: !!(m || danger) });
});
