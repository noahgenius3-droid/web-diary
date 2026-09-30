// Cordial's instant sign-up: creates an account that's ready to use straight away, with no confirmation email
// (Supabase's built-in mailer is heavily rate-limited). The browser then signs in with the same email + password.
// POST { email, password, username, name } → { ok: true } or { error, code }
// Someone who signed up before but never confirmed (and never signed in) can finish here with a new password.
// SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are provided by the platform.
import { createClient } from "npm:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const USERNAME_RE = /^[a-z0-9_]{3,20}$/;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/;

const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
const fail = (code: string, error: string, status = 400) => reply({ code, error }, status);

async function findUserByEmail(email: string) {
  // listUsers has no email filter; pages of 1000 are plenty at Cordial's size
  for (let page = 1; page <= 20; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw error;
    const hit = data.users.find((u) => (u.email || "").toLowerCase() === email);
    if (hit) return hit;
    if (data.users.length < 1000) return null;
  }
  return null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return fail("method", "Use POST", 405);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return fail("bad_request", "Something went wrong — try again.");
  }
  const email = String(body.email || "").trim().toLowerCase();
  const password = String(body.password || "");
  const username = String(body.username || "").trim().toLowerCase();
  const name = String(body.name || "").trim().slice(0, 40);

  if (!EMAIL_RE.test(email) || email.length > 254) return fail("email", "Enter a valid email address.");
  if (password.length < 6 || password.length > 72) return fail("password", "Use 6–72 characters for your password.");
  if (!USERNAME_RE.test(username)) return fail("username", "Usernames are 3–20 lowercase letters, numbers or _.");
  if (!name) return fail("name", "Tell us your name.");

  const ip = (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || req.headers.get("cf-connecting-ip") || "unknown";
  // Per network: 35 new accounts an hour
  const { data: limit, error: gateErr } = await admin.rpc("diary_signup_check", { p_ip: ip });
  if (gateErr) return fail("server", "Sign-up is having a moment — try again shortly.", 500);
  if (limit !== "ok") return fail("rate_limited", "Lots of new accounts from this network in the last hour — try again a bit later.", 429);

  const { data: free, error: freeErr } = await admin.rpc("diary_username_free", { p_username: username });
  if (freeErr) return fail("server", "Sign-up is having a moment — try again shortly.", 500);
  if (!free) return fail("username_taken", `@${username} is taken — try another.`, 409);

  const user_metadata = { username, display_name: name };
  const { error } = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata });
  if (!error) {
    await admin.rpc("diary_signup_record", { p_ip: ip, p_email: email });
    return reply({ ok: true });
  }

  if (!/already|registered|exists/i.test(error.message)) {
    return fail("server", "Couldn’t create your account — try again.", 500);
  }
  // The email is already registered. If that account was never confirmed and never used, let them finish it now.
  try {
    const existing = await findUserByEmail(email);
    if (existing && !existing.email_confirmed_at && !existing.last_sign_in_at) {
      const { error: upErr } = await admin.auth.admin.updateUserById(existing.id, {
        password, email_confirm: true, user_metadata,
      });
      if (!upErr) {
        await admin.rpc("diary_signup_record", { p_ip: ip, p_email: email });
        return reply({ ok: true, finished: true });
      }
    }
  } catch { /* fall through */ }
  return fail("email_taken", "There’s already an account with that email — sign in instead.", 409);
});
