// Sign-in blocking for deactivated accounts (Command Center).
//   POST { user: "<uuid>", action: "ban" | "unban" }  with the admin's own JWT
// The caller must hold users.deactivate (ban) or users.reactivate (unban) — checked in the database with the
// caller's own token. Only then does this use Supabase's Auth admin API (service role, server-side only) to set
// or clear a ban, which stops sign-in and token refresh on every device. Nothing else about the user changes.
import { createClient } from "jsr:@supabase/supabase-js@2";

const URL_ = Deno.env.get("SUPABASE_URL")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const auth = req.headers.get("Authorization") || "";
  if (!auth.startsWith("Bearer ")) return json({ error: "Sign in first" }, 401);

  let body: { user?: string; action?: string } = {};
  try { body = await req.json(); } catch { /* empty */ }
  const user = String(body.user || "");
  const action = body.action === "unban" ? "unban" : body.action === "ban" ? "ban" : "";
  if (!/^[0-9a-f-]{36}$/i.test(user) || !action) return json({ error: "Bad request" }, 400);

  // Who is asking, and may they? (their own token, so the database applies their real permissions)
  const asCaller = createClient(URL_, ANON, { global: { headers: { Authorization: auth } } });
  const { data: me } = await asCaller.auth.getUser();
  if (!me?.user) return json({ error: "Sign in first" }, 401);
  if (me.user.id === user) return json({ error: "You can't change your own sign-in" }, 400);
  const perm = action === "ban" ? "users.deactivate" : "users.reactivate";
  let allowed = false;
  const { data: ok, error } = await asCaller.rpc("diary_cc_has_perm", { p_perm: perm });
  if (!error) allowed = !!ok;
  else {
    const { data: admin } = await asCaller.rpc("diary_am_admin"); // before the Command Center update
    allowed = !!admin;
  }
  if (!allowed) return json({ error: "Not allowed" }, 403);

  // The account's status in Cordial must agree (so this can't be used on its own to lock someone out)
  const admin = createClient(URL_, SERVICE, { auth: { persistSession: false } });
  const { data: st } = await admin.from("diary_account_status").select("status").eq("user_id", user).maybeSingle();
  if (action === "ban" && st?.status !== "deactivated") return json({ error: "Deactivate the account in the Command Center first" }, 409);

  const { error: banError } = await admin.auth.admin.updateUserById(user, { ban_duration: action === "ban" ? "876000h" : "none" });
  if (banError) return json({ error: banError.message }, 500);
  await admin.from("diary_audit_log").insert({
    actor: me.user.id, action: action === "ban" ? "SIGN_IN_BLOCKED" : "SIGN_IN_RESTORED", target_user: user, details: { via: "diary-admin-auth" },
  });
  return json({ ok: true, action });
});
