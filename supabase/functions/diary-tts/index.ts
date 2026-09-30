// Cordial's narrator voices: turns a note into natural speech for "note → video" presenters.
// POST { text, voice: "female" | "male" } → audio/wav. GET → { ready } (whether a voice engine is set up).
// Uses Google Gemini text-to-speech: add GEMINI_API_KEY (free from aistudio.google.com) in
// Supabase → Edge Functions → Secrets. GEMINI_TTS_MODEL optionally overrides the model.
// Each narration counts against the person's daily AI allowance (diary_ai_take_quota).
import { createClient } from "npm:@supabase/supabase-js@2";

const KEY = Deno.env.get("GEMINI_API_KEY")?.trim();
const MODEL = Deno.env.get("GEMINI_TTS_MODEL")?.trim() || "gemini-2.5-flash-preview-tts";
const VOICES: Record<string, string> = { female: "Kore", male: "Charon" };
const MAX_TEXT = 3000;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

// Gemini returns raw 16-bit PCM (24 kHz, mono): wrap it in a WAV header so browsers can play it
function wav(pcm: Uint8Array, rate = 24000) {
  const header = new ArrayBuffer(44);
  const v = new DataView(header);
  const str = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, "RIFF"); v.setUint32(4, 36 + pcm.length, true); str(8, "WAVE");
  str(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, "data"); v.setUint32(40, pcm.length, true);
  const out = new Uint8Array(44 + pcm.length);
  out.set(new Uint8Array(header), 0);
  out.set(pcm, 44);
  return out;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method === "GET") return json(200, { ready: !!KEY });
  if (req.method !== "POST") return json(405, { error: "Use POST" });
  if (!KEY) return json(503, { error: "Narrator voices aren't set up yet." });

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json(400, { error: "Bad request" }); }
  const text = String(body.text || "").replace(/\s+/g, " ").trim().slice(0, MAX_TEXT);
  const voice = VOICES[String(body.voice)] || VOICES.female;
  if (!text) return json(400, { error: "Nothing to read" });

  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
  });
  const { data: allowed, error: quotaError } = await supabase.rpc("diary_ai_take_quota");
  if (quotaError) return json(401, { error: "Please sign in again" });
  if (!allowed) return json(429, { error: "You've reached today's AI limit. It resets tomorrow." });

  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(MODEL)}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": KEY },
    body: JSON.stringify({
      contents: [{ parts: [{ text: `Read this aloud warmly and naturally, like someone sharing their diary, with short pauses between paragraphs:\n\n${text}` }] }],
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
      },
    }),
  });
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 300);
    console.error("tts failed", res.status, detail);
    if (res.status === 429) return json(429, { error: "The narrator is busy — try again in a minute." });
    if (res.status === 404) return json(502, { error: `The voice model "${MODEL}" wasn't found. Set GEMINI_TTS_MODEL to a current text-to-speech model.` });
    return json(502, { error: "Couldn't make the narration — try again." });
  }
  // deno-lint-ignore no-explicit-any
  const data: any = await res.json();
  const b64 = data?.candidates?.[0]?.content?.parts?.find((p: any) => p.inlineData)?.inlineData?.data;
  if (!b64) return json(502, { error: "Couldn't make the narration — try again." });
  const pcm = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return new Response(wav(pcm), { headers: { ...CORS, "Content-Type": "audio/wav", "Cache-Control": "no-store" } });
});
