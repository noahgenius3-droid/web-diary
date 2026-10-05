// Cordial's natural voices on Vercel (Google Gemini text-to-speech): note → podcast, note → video narration.
// POST { text, voice }                                  → one narrator, audio/wav
// POST { turns: [{ speaker: "A"|"B", text }], voices: { A, B } } → two hosts in conversation, audio/wav
// GET → { ready, voices }. Uses the same GEMINI_API_KEY as /api/ai (Vercel → Settings → Environment Variables).
// Signed-in Cordial users only; each request counts against their daily AI allowance (diary_ai_take_quota).
export const config = { runtime: 'edge' };

const env = (k) => (typeof process !== 'undefined' && process.env && process.env[k] ? String(process.env[k]).trim() : '');
const KEY = env('GEMINI_API_KEY');
const MODEL = env('GEMINI_TTS_MODEL') || 'gemini-2.5-flash-preview-tts';
const SUPABASE_URL = env('SUPABASE_URL') || 'https://lphdazuibtqfjamfiirp.supabase.co';
const SUPABASE_ANON = env('SUPABASE_ANON_KEY') || 'sb_publishable_5lvdlyY7k6qlOdTfvTVuVA_geOt38nP';
// Gemini's prebuilt voices (friendly names for the app)
const VOICES = { kore: 'Kore', aoede: 'Aoede', charon: 'Charon', puck: 'Puck', female: 'Kore', male: 'Charon' };
const MAX_TEXT = 4000;

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

// Gemini returns raw 16-bit PCM (24 kHz, mono): wrap it in a WAV header so browsers can play it
function wav(pcm, rate = 24000) {
  const out = new Uint8Array(44 + pcm.length);
  const v = new DataView(out.buffer);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + pcm.length, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, pcm.length, true);
  out.set(pcm, 44);
  return out;
}
const b64bytes = (b64) => { const bin = atob(b64); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; };

export default async function handler(req) {
  if (req.method === 'GET') return json(200, { ready: !!KEY, voices: ['kore', 'aoede', 'charon', 'puck'] });
  if (req.method !== 'POST') return json(405, { error: 'Use POST' });
  if (!KEY) return json(503, { error: 'Natural voices aren’t switched on yet: add GEMINI_API_KEY in the Vercel project’s Environment Variables.' });

  let body;
  try { body = await req.json(); } catch { return json(400, { error: 'Bad request' }); }
  let prompt, speechConfig;
  if (Array.isArray(body.turns) && body.turns.length) {
    const names = { A: 'Ada', B: 'Ben' };
    const lines = body.turns.filter((t) => t && (t.speaker === 'A' || t.speaker === 'B') && typeof t.text === 'string' && t.text.trim())
      .map((t) => `${names[t.speaker]}: ${t.text.replace(/\s+/g, ' ').trim()}`);
    const text = lines.join('\n').slice(0, MAX_TEXT);
    if (!text) return json(400, { error: 'Nothing to read' });
    const vA = VOICES[String(body.voices?.A)] || 'Kore', vB = VOICES[String(body.voices?.B)] || 'Puck';
    prompt = `TTS the following podcast conversation between Ada and Ben. They are warm, curious co-hosts talking naturally, with relaxed pacing:\n${text}`;
    speechConfig = { multiSpeakerVoiceConfig: { speakerVoiceConfigs: [
      { speaker: 'Ada', voiceConfig: { prebuiltVoiceConfig: { voiceName: vA } } },
      { speaker: 'Ben', voiceConfig: { prebuiltVoiceConfig: { voiceName: vB } } }] } };
  } else {
    const text = String(body.text || '').replace(/[ \t]+/g, ' ').trim().slice(0, MAX_TEXT);
    if (!text) return json(400, { error: 'Nothing to read' });
    prompt = `Read this aloud as a warm, natural podcast host — conversational, clear, with short pauses between paragraphs:\n\n${text}`;
    speechConfig = { voiceConfig: { prebuiltVoiceConfig: { voiceName: VOICES[String(body.voice)] || 'Kore' } } };
  }

  // Signed-in users only, within their daily allowance
  const auth = req.headers.get('authorization') || '';
  if (!/^Bearer\s+\S+/.test(auth)) return json(401, { error: 'Please sign in again' });
  const quota = await fetch(`${SUPABASE_URL}/rest/v1/rpc/diary_ai_take_quota`, { method: 'POST', headers: { apikey: SUPABASE_ANON, Authorization: auth, 'Content-Type': 'application/json' }, body: '{}' }).catch(() => null);
  if (!quota || quota.status === 401 || quota.status === 403) return json(401, { error: 'Please sign in again' });
  if (!quota.ok) return json(503, { error: 'Couldn’t check your AI allowance — please try again.' });
  if ((await quota.json().catch(() => true)) === false) return json(429, { error: 'You’ve reached today’s AI limit. It resets tomorrow.' });

  // Answer straight away and send the audio when it's ready (long narrations take a while)
  const body2 = new ReadableStream({
    async start(controller) {
      const fail = (msg) => { controller.enqueue(new TextEncoder().encode(JSON.stringify({ error: msg }))); controller.close(); };
      try {
        const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(MODEL)}:generateContent`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': KEY },
          body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseModalities: ['AUDIO'], speechConfig } }),
        });
        if (!res.ok) {
          const detail = (await res.text()).slice(0, 300);
          console.error('tts failed', res.status, detail);
          if (res.status === 429) return fail('The voices are busy — try again in a minute.');
          if (res.status === 404) return fail(`The voice model "${MODEL}" wasn't found. Set GEMINI_TTS_MODEL to a current text-to-speech model.`);
          if (res.status === 400 && /API key/i.test(detail)) return fail('The AI key was rejected. Check GEMINI_API_KEY in the Vercel project settings.');
          return fail('Couldn’t make the voice — try again.');
        }
        const data = await res.json();
        const b64 = data?.candidates?.[0]?.content?.parts?.find((p) => p.inlineData)?.inlineData?.data;
        if (!b64) return fail('Couldn’t make the voice — try again.');
        controller.enqueue(wav(b64bytes(b64)));
        controller.close();
      } catch (e) {
        console.error('tts error', e);
        fail('Couldn’t make the voice — try again.');
      }
    },
  });
  return new Response(body2, { headers: { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store' } });
}
