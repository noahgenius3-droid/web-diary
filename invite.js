// Invites: everyone has a personal link (…/?invite=<username>). Opening it greets the visitor by who invited
// them and opens "Create account"; once they're signed up, the invite is claimed and they're friends with the
// inviter straight away (the database checks it: once per account, only for brand-new accounts, never yourself).
document.addEventListener('DOMContentLoaded', () => {
    const app = window.diaryApp;
    const social = window.diarySocial;
    if (!app || !social || !social.internals) return;
    const I = social.internals;
    const { client, state: s, esc, avatar } = I;
    const KEY = 'cordialInvite';
    const V = { mine: null, loading: false };

    const linkFor = username => `${location.origin}${location.pathname}?invite=${encodeURIComponent(username)}`;
    const store = {
        get: () => { try { return localStorage.getItem(KEY) || ''; } catch (e) { return ''; } },
        set: v => { try { v ? localStorage.setItem(KEY, v) : localStorage.removeItem(KEY); } catch (e) { /* private mode */ } }
    };

    // ---------- Arriving through someone's link ----------
    (async () => {
        const code = new URLSearchParams(location.search).get('invite');
        if (!code || !/^@?[a-z0-9_]{3,20}$/i.test(code)) return;
        store.set(code.replace(/^@/, '').toLowerCase());
        const url = new URL(location.href);
        url.searchParams.delete('invite');
        history.replaceState(history.state, '', url.pathname + url.search + url.hash);
        if (!client) return;
        const { data } = await client.rpc('diary_invite_preview', { p_code: code });
        setTimeout(() => {
            if (social.isSignedIn && social.isSignedIn()) return; // already a member: the claim below just connects you
            const name = data && data.display_name ? data.display_name.split(' ')[0] : 'A friend';
            if (I.openAuth) I.openAuth(`${name} invited you to Cordial. Create your account and you’ll be friends straight away.`, 'signup');
        }, 900);
    })();

    // ---------- Claiming it once you're in ----------
    let claiming = false;
    setInterval(async () => {
        const code = store.get();
        if (!code || claiming || !(social.isSignedIn && social.isSignedIn()) || (social.isGuest && social.isGuest())) return;
        claiming = true;
        const { data, error } = await client.rpc('diary_claim_referral', { p_code: code });
        claiming = false;
        if (error) return; // try again on the next tick (e.g. offline)
        store.set('');
        if (data && data.ok) {
            if (I.loadFriends) await I.loadFriends();
            const who = (s.friends || []).find(f => f.id === data.inviter);
            app.showToast(`You’re now friends with ${who ? who.display_name.split(' ')[0] : 'the person who invited you'} 🎉`);
            app.render();
        }
    }, 2500);

    // ---------- The page ----------
    async function loadMine() {
        if (V.loading) return;
        V.loading = true;
        const { data } = await client.rpc('diary_my_referrals');
        V.loading = false;
        V.mine = data || { count: 0, people: [] };
        if (app.state.view === 'invite') app.requestRender ? app.requestRender('invite') : app.render();
    }

    const message = link => `Join me on Cordial — a private diary, plus friends, chat and games. Sign up with my link and we’ll be connected: ${link}`;

    app.views.invite = () => {
        app.setTitle('Invite friends');
        const blocked = I.gate('Invite friends to Cordial with your own link.');
        if (blocked) return blocked;
        if (V.mine === null) loadMine();
        const link = linkFor(s.profile.username);
        const text = message(link);
        const mine = V.mine;
        return `
            <div class="inv">
                <section class="inv-hero">
                    <h2>Bring your people to Cordial</h2>
                    <p>Share your link. When someone joins with it, you’re friends straight away.</p>
                    <div class="inv-link">
                        <span class="inv-url" title="${esc(link)}">${esc(link.replace(/^https?:\/\//, ''))}</span>
                        <button type="button" class="inv-copy" data-inv="copy"><svg class="i"><use href="#i-link"/></svg>Copy</button>
                    </div>
                    <div class="inv-share">
                        ${navigator.share ? '<button type="button" class="inv-btn primary" data-inv="share"><svg class="i"><use href="#i-share"/></svg>Share</button>' : ''}
                        <a class="inv-btn" href="https://wa.me/?text=${encodeURIComponent(text)}" target="_blank" rel="noopener noreferrer"><svg class="i"><use href="#i-chat"/></svg>WhatsApp</a>
                        <a class="inv-btn" href="sms:?&body=${encodeURIComponent(text)}"><svg class="i"><use href="#i-phone"/></svg>Text</a>
                        <a class="inv-btn" href="mailto:?subject=${encodeURIComponent('Join me on Cordial')}&body=${encodeURIComponent(text)}"><svg class="i"><use href="#i-mail"/></svg>Email</a>
                    </div>
                </section>

                <section class="inv-sec">
                    <h3>Invite by email</h3>
                    <form class="inv-email" data-form="inv-email">
                        <input type="email" id="inv-email" placeholder="friend@example.com" autocomplete="email" aria-label="Your friend’s email" required>
                        <button type="submit" class="primary-btn">Invite</button>
                    </form>
                    <p class="muted small">Opens your email app with a ready-made invite you can change before sending.</p>
                </section>

                <section class="inv-sec">
                    <h3>Joined with your invite ${mine && mine.count ? `<span>${mine.count}</span>` : ''}</h3>
                    ${mine === null ? '<p class="muted small">Loading…</p>'
                        : mine.people.length ? `<div class="inv-people">${mine.people.map(p => `
                            <button type="button" class="inv-person" data-profile="${esc(p.id)}">
                                ${avatar(p, 'lg')}<span>${esc(String(p.display_name || '').split(' ')[0])}</span>
                            </button>`).join('')}</div>`
                        : '<p class="inv-empty">No one yet. Your first invite is one tap away.</p>'}
                </section>
            </div>`;
    };

    async function copy(text, done) {
        try { await navigator.clipboard.writeText(text); app.showToast(done); }
        catch (e) { if (I.copyText) I.copyText(text, done); }
    }

    document.addEventListener('click', async e => {
        const b = e.target.closest('[data-inv]');
        if (!b || app.state.view !== 'invite') return;
        const link = linkFor(s.profile.username);
        if (b.dataset.inv === 'copy') copy(link, 'Invite link copied');
        else if (b.dataset.inv === 'share') {
            try { await navigator.share({ title: 'Join me on Cordial', text: message(link).replace(`: ${link}`, ''), url: link }); }
            catch (err) { if (err && err.name !== 'AbortError') copy(link, 'Invite link copied'); }
        }
    });
    document.addEventListener('submit', e => {
        const form = e.target.closest && e.target.closest('form[data-form="inv-email"]');
        if (!form) return;
        e.preventDefault();
        const to = form.querySelector('input').value.trim();
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) return app.showToast('Type a valid email address');
        const text = message(linkFor(s.profile.username));
        location.href = `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(`${s.profile.display_name.split(' ')[0]} invited you to Cordial`)}&body=${encodeURIComponent(text)}`;
        form.reset();
    });

    // A way in from the menu
    const previousMenu = app.hooks.menuItems;
    // In the More menu on every device (Android, iPhone, desktop): your actual link, one tap to copy or share
    app.hooks.menuItems = () => {
        const before = previousMenu ? previousMenu() : [];
        if (!(social.isSignedIn && social.isSignedIn()) || !s.profile || (social.isGuest && social.isGuest())) return before;
        const link = linkFor(s.profile.username);
        return [
            { heading: 'Your invite link' },
            { label: link.replace(/^https?:\/\//, ''), icon: 'i-link', cls: 'pop-invite', onClick: () => copy(link, 'Invite link copied — paste it anywhere') },
            { label: 'Share invite', icon: 'i-share', onClick: async () => {
                if (navigator.share) {
                    try { await navigator.share({ title: 'Join me on Cordial', text: message(link).replace(`: ${link}`, ''), url: link }); return; }
                    catch (err) { if (err && err.name === 'AbortError') return; }
                }
                app.setView('invite');
            } },
            { label: 'Invite friends', icon: 'i-user-plus', onClick: () => app.setView('invite') },
            { sep: true },
            ...before
        ];
    };
    window.diaryInvite = { open: () => app.setView('invite'), link: () => s.profile && linkFor(s.profile.username) };
});
