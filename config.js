// Public Supabase settings. The publishable key is safe to ship to browsers:
// row-level security decides what each signed-in user can read or write.
window.DIARY_CONFIG = {
    supabaseUrl: 'https://lphdazuibtqfjamfiirp.supabase.co',
    supabaseKey: 'sb_publishable_5lvdlyY7k6qlOdTfvTVuVA_geOt38nP',
    // Voice calls connect people directly. STUN works on most networks; some mobile carriers
    // need a TURN relay too — add one here, e.g.
    //   { urls: 'turn:your.turn.server:3478', username: '…', credential: '…' }
    iceServers: [
        { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] }
    ]
};
