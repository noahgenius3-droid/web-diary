// Profile sheet: tap someone's name or picture in a chat, a group chat, a call or search to see who they
// are — photo, name, @username, online / last seen (as far as their privacy settings allow), how you're
// connected — with quick actions: message, voice or video call, add friend, follow.
document.addEventListener('DOMContentLoaded', () => {
    const app = window.diaryApp;
    const social = window.diarySocial;
    if (!app || !social || !social.internals) return;
    const I = social.internals;
    const { client, state: s, esc, avatar } = I;
    const $ = id => document.getElementById(id);
    const cache = new Map(); // id -> profile row

    let dlg = null;
    function sheet() {
        if (dlg) return dlg;
        dlg = document.createElement('dialog');
        dlg.className = 'profile-sheet';
        dlg.setAttribute('aria-labelledby', 'ps-name');
        document.body.append(dlg);
        dlg.addEventListener('click', e => {
            if (e.target === dlg) return dlg.close();
            const el = e.target.closest('[data-ps]');
            if (el) act(el.dataset.ps, el);
        });
        return dlg;
    }

    async function open(id) {
        if (!id || !s.profile) return;
        if (id === s.profile.id) return app.setView('settings');
        const d = sheet();
        d.dataset.id = id;
        let p = cache.get(id) || s.friends.find(f => f.id === id) || s.incoming.find(f => f.id === id) || s.outgoing.find(f => f.id === id);
        d.innerHTML = body(p || { id, display_name: 'Loading…', username: '' }, !p);
        if (!d.open) d.showModal();
        const [{ data }] = await Promise.all([
            client.rpc('diary_profile_card', { p_id: id }).maybeSingle(),
            I.refreshPresence ? I.refreshPresence([id]) : null
        ]);
        if (d.dataset.id !== id) return;
        if (!data) {
            d.innerHTML = body({ id, display_name: 'Account not found', username: '' }, false, true);
            return;
        }
        cache.set(id, data);
        d.innerHTML = body(data, false);
    }

    function relationOf(id) {
        if (s.friends.some(f => f.id === id)) return 'friend';
        if (s.incoming.some(f => f.id === id)) return 'incoming';
        if (s.outgoing.some(f => f.id === id)) return 'requested';
        return 'none';
    }

    function body(p, loading, missing = false) {
        const rel = relationOf(p.id);
        const status = I.presenceText ? I.presenceText(p.id) : '';
        const online = s.online && s.online.has(p.id);
        const blocked = window.diarySafety && window.diarySafety.isBlocked(p.id);
        const st = I.statusOf ? I.statusOf(p.id) : null;
        const since = p.created_at ? new Date(p.created_at).toLocaleDateString(undefined, { month: 'long', year: 'numeric' }) : '';
        const btn = (action, icon, label, cls = '') => `<button type="button" class="ps-action ${cls}" data-ps="${action}"><svg class="i"><use href="#${icon}"/></svg><span>${label}</span></button>`;
        let actions = '';
        if (!loading && !missing && blocked) {
            actions = btn('unblock', 'i-block', 'Unblock', 'primary');
        } else if (!loading && !missing) {
            if (rel === 'friend') {
                actions = btn('message', 'i-chat', 'Message', 'primary')
                    + (window.diaryCalls ? btn('call', 'i-phone', 'Voice call') + btn('video', 'i-video', 'Video call') : '');
            } else if (rel === 'incoming') {
                actions = btn('accept', 'i-user-plus', 'Accept request', 'primary');
            } else if (rel === 'requested') {
                actions = '<button type="button" class="ps-action" disabled><svg class="i"><use href="#i-user-plus"/></svg><span>Request sent</span></button>';
            } else {
                actions = btn('add', 'i-user-plus', 'Add friend', 'primary');
            }
            if (rel !== 'friend' && I.followButton) {
                const on = s.following && s.following.has(p.id);
                actions += btn('follow', 'i-user', on ? 'Following' : 'Follow', on ? 'on' : '');
            }
        }
        return `
            <div class="ps-card">
                <button type="button" class="icon-btn ps-close" data-ps="close" aria-label="Close"><svg class="i"><use href="#i-close"/></svg></button>
                <div class="ps-photo${online ? ' online' : ''}">${avatar(p, 'xl')}</div>
                <h2 id="ps-name">${esc(p.display_name || 'Someone')}</h2>
                ${p.username ? `<p class="ps-handle">@${esc(p.username)}</p>` : ''}
                <p class="ps-status${online ? ' on' : ''}" data-status="${esc(p.id)}" data-away="">${esc(status)}</p>
                ${st ? `<p class="ps-custom">${esc(st.label)}${st.text ? ` · ${esc(st.text)}` : ''}</p>` : ''}
                ${missing ? '<p class="muted">This account no longer exists.</p>' : ''}
                ${blocked ? '<p class="ps-note">You blocked this person. They can’t message or call you.</p>' : p.limited ? '<p class="ps-note">This profile is only fully visible to their friends.</p>' : ''}
                <div class="ps-facts">
                    ${rel === 'friend' ? '<span class="ps-fact"><svg class="i"><use href="#i-users"/></svg>Friends</span>' : ''}
                    ${s.following && s.following.has(p.id) ? '<span class="ps-fact"><svg class="i"><use href="#i-user"/></svg>You follow them</span>' : ''}
                    ${since ? `<span class="ps-fact"><svg class="i"><use href="#i-calendar"/></svg>On Cordial since ${esc(since)}</span>` : ''}
                </div>
                <div class="ps-actions">${loading ? '<span class="lv-spinner" aria-hidden="true"></span>' : actions}</div>
                ${!loading && !missing && window.diarySafety ? `<div class="ps-safety">${blocked ? '' : '<button type="button" class="link-btn" data-ps="block"><svg class="i"><use href="#i-block"/></svg>Block</button>'}<button type="button" class="link-btn" data-ps="report"><svg class="i"><use href="#i-flag"/></svg>Report</button></div>` : ''}
            </div>`;
    }

    async function act(what, el) {
        const id = dlg.dataset.id;
        const p = cache.get(id) || s.friends.find(f => f.id === id) || { id };
        if (what === 'close') return dlg.close();
        if (what === 'message') {
            dlg.close();
            app.setView('messages');
            if (I.openChat) I.openChat(id);
        } else if (what === 'call' || what === 'video') {
            dlg.close();
            const friend = s.friends.find(f => f.id === id);
            if (friend && window.diaryCalls) window.diaryCalls.callUser(friend, { video: what === 'video' });
        } else if (what === 'add') {
            el.disabled = true;
            const { error } = await client.rpc('diary_send_friend_request', { target_username: p.username });
            if (error) { el.disabled = false; return app.showToast(error.message || 'Couldn’t send the request'); }
            if (I.loadFriends) await I.loadFriends();
            app.showToast('Friend request sent');
            dlg.innerHTML = body(p, false);
        } else if (what === 'accept') {
            const req = s.incoming.find(f => f.id === id);
            if (!req || !I.respond) return;
            el.disabled = true;
            await I.respond(req.friendshipId, true);
            dlg.innerHTML = body(p, false);
        } else if (what === 'block') {
            if (await window.diarySafety.block(p)) dlg.innerHTML = body(p, false);
        } else if (what === 'unblock') {
            if (await window.diarySafety.unblock(p)) dlg.innerHTML = body(p, false);
        } else if (what === 'report') {
            dlg.close();
            window.diarySafety.report('user', id, { who: p.display_name, offerBlock: window.diarySafety.isBlocked(id) ? null : p });
        } else if (what === 'follow') {
            if (I.toggleFollow) await I.toggleFollow(id, (p.display_name || '').split(' ')[0]);
            dlg.innerHTML = body(p, false);
        }
    }

    window.diaryProfile = { open };

    // Anything marked data-profile="<user id>" opens the sheet (names and pictures in chats, calls, search)
    document.addEventListener('click', e => {
        const el = e.target.closest('[data-profile]');
        if (!el || !el.dataset.profile || e.defaultPrevented) return;
        if (el.closest('.profile-sheet')) return;
        e.preventDefault();
        e.stopPropagation();
        open(el.dataset.profile);
    }, true);
});
