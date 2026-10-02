// Every privileged action as a guided flow: what will happen, why (a reason is always required), a summary of
// the change, then confirmation — typed for the destructive ones. Flows resolve true when the change was made.
import * as api from './api.js';
import { esc, modal, toast, ic, until, dateTime, who, friendly, debounce, avatar } from './ui.js';
import { STATUS, SCOPES, DURATIONS, REASONS, REWARD, isLargeReward, can, scopeLabel, statusBadge } from './model.js';

const name = u => esc(u.display_name || u.username || 'this user');
const reasonField = (list, label = 'Reason') => `
    <label class="field"><span>${label}</span>
        <select class="input" name="reasonPick" required>
            <option value="">Choose a reason…</option>${list.map(r => `<option>${esc(r)}</option>`).join('')}<option value="__other">Other (write it)</option>
        </select></label>
    <label class="field" data-other hidden><span>Describe the reason</span><input class="input" name="reasonText" maxlength="300" placeholder="What happened?"></label>`;
const readReason = f => (f.elements.reasonPick.value === '__other' ? f.elements.reasonText.value.trim() : f.elements.reasonPick.value);
const toggleOther = f => { const o = f.querySelector('[data-other]'); if (o) o.hidden = f.elements.reasonPick.value !== '__other'; };
const durationField = (def = 72) => `
    <fieldset class="field" style="border:0;margin:0;padding:0"><legend>Duration</legend>
        <div class="chips" role="radiogroup" aria-label="Duration">${DURATIONS.map(([h, l]) => `
            <label class="chip"><input type="radio" name="hours" value="${h}"${h === def ? ' checked' : ''} class="sr">${esc(l)}</label>`).join('')}</div></fieldset>
    <label class="field" data-custom hidden><span>Ends</span><input class="input" type="datetime-local" name="until"></label>`;
const syncChips = f => f.querySelectorAll('.chip input').forEach(i => i.parentElement.setAttribute('aria-checked', String(i.checked)));
function readDuration(f) {
    const h = Number(f.elements.hours.value);
    if (h === 0) {
        const v = f.elements.until.value;
        if (!v) throw new Error('Choose when it ends');
        const d = new Date(v);
        if (d <= new Date()) throw new Error('The end must be in the future');
        return { hours: null, until: d.toISOString(), text: `until ${dateTime(d.toISOString())}` };
    }
    if (h === -1) return { hours: -1, until: null, text: 'until lifted' };
    return { hours: h, until: null, text: `for ${(DURATIONS.find(x => x[0] === h) || [0, `${h} hours`])[1]}` };
}
const guard = perm => { if (!can(perm)) { toast('You don’t have permission for that', { error: true }); return false; } return true; };
const upgradeNote = what => `<div class="upgrade"><strong>${ic('lock')} ${esc(what)} needs the Command Center database update</strong><p>Run <code>20261002070000_diary_command_center.sql</code> in Supabase to switch it on.</p></div>`;

// ---------- Suspend ----------
export async function suspend(u) {
    if (!guard('users.suspend')) return false;
    let summary = '';
    return modal({
        title: `Suspend ${name(u)}`, icon: 'pause', tone: 'warn', confirm: 'Suspend user', confirmTone: 'primary',
        text: 'They keep their account and can read, but can’t post, comment or message until the suspension ends.',
        body: `${reasonField(REASONS.suspend)}${durationField(72)}
            <label class="field"><span>Message shown to them <small>(optional)</small></span><textarea class="input" name="msg" maxlength="500" rows="2" placeholder="e.g. Please keep conversations respectful."></textarea></label>
            <label class="field"><span>Internal note <small>(only admins see this)</small></span><input class="input" name="note" maxlength="1000"></label>
            <dl class="summary" data-sum></dl>
            <ul class="effects warn"><li>Can’t publish posts, reels or stories</li><li>Can’t comment or send messages</li><li>Sees a notice explaining the suspension and when it ends</li></ul>`,
        onInput(f) {
            toggleOther(f); syncChips(f);
            f.querySelector('[data-custom]').hidden = f.elements.hours.value !== '0';
            let d = ''; try { d = readDuration(f).text; } catch (e) { d = '—'; }
            summary = `<dt>User</dt><dd>${name(u)} · @${esc(u.username || '')}</dd><dt>Action</dt><dd>Suspend</dd><dt>Duration</dt><dd>${esc(d)}</dd><dt>Reason</dt><dd>${esc(readReason(f) || '—')}</dd>`;
            f.querySelector('[data-sum]').innerHTML = summary;
        },
        async onSubmit(f) {
            const reason = readReason(f);
            if (!reason) throw new Error('Choose a reason');
            const d = readDuration(f);
            await api.setStatus({ user: u.id, status: 'suspended', reason, hours: d.hours, until: d.until, userMessage: f.elements.msg.value.trim(), note: f.elements.note.value.trim() });
            toast(`${u.display_name || 'User'} is suspended ${d.text}`);
        }
    });
}

// ---------- Block (scoped) ----------
export async function block(u) {
    if (!guard('users.block')) return false;
    if (!api.caps.full) return modal({ title: `Block ${name(u)}`, icon: 'ban', body: upgradeNote('Scoped blocking'), confirm: 'OK', cancel: 'Close', onSubmit: () => true });
    return modal({
        title: `Block ${name(u)}`, icon: 'ban', tone: 'bad', confirm: 'Block user', confirmTone: 'danger',
        text: 'Choose exactly what they’re kept out of. Everything else keeps working.',
        body: `<fieldset class="field" style="border:0;margin:0;padding:0"><legend>Scope</legend>
                <div style="display:grid;gap:8px">${SCOPES.map(([k, l, d]) => `
                    <label style="display:flex;gap:10px;align-items:flex-start"><input type="checkbox" name="scope" value="${k}" style="margin-top:3px">
                        <span><strong>${esc(l)}</strong><br><small class="muted">${esc(d)}</small></span></label>`).join('')}</div></fieldset>
            ${reasonField(REASONS.block)}${durationField(-1)}
            <label class="field"><span>Message shown to them <small>(optional)</small></span><textarea class="input" name="msg" maxlength="500" rows="2"></textarea></label>
            <label class="field"><span>Internal note</span><input class="input" name="note" maxlength="1000"></label>
            <p data-explain class="muted" style="margin:0"></p><dl class="summary" data-sum></dl>`,
        onInput(f, { ok }) {
            toggleOther(f); syncChips(f);
            f.querySelector('[data-custom]').hidden = f.elements.hours.value !== '0';
            const scope = [...f.querySelectorAll('[name="scope"]:checked')].map(i => i.value);
            ok.disabled = !scope.length;
            f.querySelector('[data-explain]').innerHTML = scope.length ? `You are about to block ${name(u)} from <b>${esc(scope.map(scopeLabel).join(', ').toLowerCase())}</b>.` : 'Choose at least one area.';
            let d = ''; try { d = readDuration(f).text; } catch (e) { d = '—'; }
            f.querySelector('[data-sum]').innerHTML = `<dt>User</dt><dd>${name(u)}</dd><dt>Scope</dt><dd>${esc(scope.map(scopeLabel).join(', ') || '—')}</dd><dt>Duration</dt><dd>${esc(d)}</dd><dt>Reason</dt><dd>${esc(readReason(f) || '—')}</dd>`;
        },
        async onSubmit(f) {
            const reason = readReason(f);
            const scope = [...f.querySelectorAll('[name="scope"]:checked')].map(i => i.value);
            if (!scope.length) throw new Error('Choose what the block covers');
            if (!reason) throw new Error('Choose a reason');
            const d = readDuration(f);
            await api.setStatus({ user: u.id, status: 'blocked', scope, reason, hours: d.hours > 0 ? d.hours : null, until: d.until, userMessage: f.elements.msg.value.trim(), note: f.elements.note.value.trim() });
            toast(`${u.display_name || 'User'} is blocked from ${scope.map(scopeLabel).join(', ').toLowerCase()}`);
        }
    });
}

// ---------- Deactivate (typed confirmation) ----------
export async function deactivate(u) {
    if (!guard('users.deactivate')) return false;
    if (!api.caps.full) return modal({ title: `Deactivate ${name(u)}`, icon: 'power', body: upgradeNote('Deactivation'), confirm: 'OK', cancel: 'Close', onSubmit: () => true });
    return modal({
        title: 'Deactivate account', icon: 'power', tone: 'bad', confirm: 'Deactivate account', confirmTone: 'danger', typed: 'DEACTIVATE',
        text: `This will disable ${name(u)}’s access to Cordial.`,
        body: `<ul class="effects"><li>They can’t sign in, post, comment, message or react</li><li>Their sign-in is blocked on every device</li>
                <li>Their content stays in place (remove it separately if needed)</li><li>You can reactivate the account later — this is recorded in the audit log</li></ul>
            ${reasonField(REASONS.deactivate)}
            <label class="field"><span>Message shown to them <small>(optional)</small></span><textarea class="input" name="msg" maxlength="500" rows="2"></textarea></label>
            <label class="field"><span>Internal note</span><input class="input" name="note" maxlength="1000"></label>`,
        onInput: f => toggleOther(f),
        async onSubmit(f) {
            const reason = readReason(f);
            if (!reason) throw new Error('Choose a reason');
            await api.setStatus({ user: u.id, status: 'deactivated', reason, userMessage: f.elements.msg.value.trim(), note: f.elements.note.value.trim() });
            const ban = await api.signInBan(u.id, true);
            if (ban.ok) toast(`${u.display_name || 'Account'} is deactivated and can no longer sign in`);
            else toast('Deactivated in Cordial. Sign-in blocking isn’t set up yet (deploy diary-admin-auth) — they can still sign in but can’t do anything.', { error: true, ms: 8000 });
        }
    });
}

// ---------- Restore ----------
export async function reactivate(u) {
    if (!guard('users.reactivate')) return false;
    const r = u.restriction || {};
    const was = u.status || r.status || 'suspended';
    return modal({
        title: `Restore ${name(u)}`, icon: 'undo', confirm: was === 'deactivated' ? 'Reactivate account' : 'Lift restriction', confirmTone: 'primary',
        text: 'Everything they could do before comes back straight away, and they’re told.',
        body: `<dl class="summary"><dt>Current state</dt><dd>${statusBadge(was)}${r.scope && r.scope.length ? ` · ${esc(r.scope.map(scopeLabel).join(', '))}` : ''}</dd>
                <dt>Reason</dt><dd>${esc(r.reason || u.status_reason || '—')}</dd><dt>Applied</dt><dd>${esc(dateTime(r.restricted_at || r.starts_at))}${r.by_name ? ` by ${esc(r.by_name)}` : ''}</dd>
                <dt>Ends</dt><dd>${esc(r.ends_at ? `${dateTime(r.ends_at)} (${until(r.ends_at)})` : 'Until lifted')}</dd></dl>
            <label class="field"><span>Note <small>(why you’re restoring it)</small></span><input class="input" name="note" maxlength="300" placeholder="e.g. Appeal accepted"></label>`,
        async onSubmit(f) {
            await api.setStatus({ user: u.id, status: 'active', reason: f.elements.note.value.trim() || 'Restored', note: f.elements.note.value.trim() });
            if (was === 'deactivated') await api.signInBan(u.id, false);
            toast(`${u.display_name || 'Account'} is restored`);
        }
    });
}

// ---------- Rewards ----------
export async function reward(target = null) {
    if (!guard('rewards.send')) return false;
    const badges = await api.badges().catch(() => []);
    let picked = target;
    const full = api.caps.full;
    onPicked((u, form) => { picked = u; form.dispatchEvent(new Event('input')); });
    return modal({
        title: 'Send reward', icon: 'gift', confirm: 'Send reward', confirmTone: 'primary', wide: false,
        body: `
            ${picked ? `<div data-who>${who(picked, { link: false })}</div>` : `
            <label class="field"><span>Recipient</span><input class="input" name="find" placeholder="Search name, @username or email" autocomplete="off" role="combobox" aria-expanded="false" aria-controls="rw-results"></label>
            <ul class="rows panel" id="rw-results" role="listbox" style="max-height:200px;overflow:auto" hidden></ul><div data-who></div>`}
            <fieldset class="field" style="border:0;margin:0;padding:0"><legend>Reward</legend>
                <div class="chips" role="radiogroup">${Object.entries(REWARD).map(([k, r]) => `
                    <label class="chip"><input type="radio" class="sr" name="kind" value="${k}"${k === (full ? 'xp' : 'badge') ? ' checked' : ''}${!full && k !== 'badge' ? ' disabled' : ''}>${esc(r.label)}</label>`).join('')}</div>
                <small data-about></small></fieldset>
            ${!full ? '<p class="muted" style="margin:0;font-size:.82rem">XP, coins and special rewards switch on with the Command Center database update. Badges work now.</p>' : ''}
            <label class="field" data-amount><span>Amount</span><input class="input" type="number" name="amount" min="1" max="1000000" step="1" value="100" inputmode="numeric"></label>
            <label class="field" data-badge hidden><span>Badge</span><select class="input" name="badge">${badges.map(b => `<option value="${esc(b.id)}">${esc(b.name)} — ${esc(b.tier)}</option>`).join('')}</select></label>
            ${reasonField(REASONS.reward)}
            <label class="field"><span>Message to them <small>(optional, shown with the reward)</small></span><textarea class="input" name="msg" maxlength="500" rows="2" placeholder="Thank you for…"></textarea></label>
            <dl class="summary" data-sum></dl>
            <label class="field" data-large hidden><span>This is a large reward. Type <b>SEND</b> to confirm.</span><input class="input" name="large" autocomplete="off"></label>`,
        onInput(f, { ok }) {
            toggleOther(f); syncChips(f);
            const kind = (f.querySelector('[name="kind"]:checked') || {}).value || 'badge';
            f.querySelector('[data-amount]').hidden = !['xp', 'coins'].includes(kind);
            f.querySelector('[data-badge]').hidden = kind !== 'badge';
            f.querySelector('[data-about]').textContent = REWARD[kind].about;
            const amount = Number(f.elements.amount.value);
            const large = isLargeReward(kind, amount);
            f.querySelector('[data-large]').hidden = !large;
            const what = kind === 'badge' ? (f.elements.badge.selectedOptions[0] || {}).textContent || 'Badge' : kind === 'special' ? 'Special recognition' : `${amount.toLocaleString()} ${REWARD[kind].unit}`;
            f.querySelector('[data-sum]').innerHTML = `<dt>User</dt><dd>${picked ? name(picked) : '—'}</dd><dt>Reward</dt><dd>${esc(what)}</dd><dt>Reason</dt><dd>${esc(readReason(f) || '—')}</dd>`;
            ok.disabled = !picked || (large && f.elements.large.value.trim() !== 'SEND');
        },
        async onSubmit(f) {
            const kind = f.querySelector('[name="kind"]:checked').value;
            const reason = readReason(f);
            if (!picked) throw new Error('Choose who gets the reward');
            if (!reason) throw new Error('Choose a reason');
            const amount = Number(f.elements.amount.value);
            if (['xp', 'coins'].includes(kind) && !(amount > 0)) throw new Error('Enter an amount above zero');
            const res = await api.sendReward({ user: picked.id, kind, amount, badge: f.elements.badge.value, reason, message: f.elements.msg.value.trim(), confirmLarge: isLargeReward(kind, amount) });
            toast(res && res.status === 'pending_review' ? 'Reward recorded — it waits for a super admin to approve' : `Reward sent to ${picked.display_name}`);
        }
    });
}
// Recipient search inside the reward dialog
document.addEventListener('input', debounce(async e => {
    if (e.target.name !== 'find' || !e.target.closest('dialog')) return;
    const box = e.target.closest('form').querySelector('#rw-results');
    const q = e.target.value.trim();
    if (q.length < 2) { box.hidden = true; return; }
    const res = await api.search(q).catch(() => ({ users: [] }));
    box.hidden = false;
    e.target.setAttribute('aria-expanded', 'true');
    box.innerHTML = (res.users || []).map(u => `<li role="option"><button type="button" class="who" data-pick='${esc(JSON.stringify({ id: u.id, username: u.username, display_name: u.display_name, avatar_path: u.avatar_path, verified: u.verified }))}'>${avatar(u, 'sm')}<span><strong>${esc(u.display_name)}</strong><small>@${esc(u.username)}${u.email ? ` · ${esc(u.email)}` : ''}</small></span></button></li>`).join('') || '<li class="muted">No one found</li>';
}, 250));
document.addEventListener('click', e => {
    const b = e.target.closest('[data-pick]');
    if (!b) return;
    const form = b.closest('form');
    const u = JSON.parse(b.dataset.pick);
    form.querySelector('[data-who]').innerHTML = who(u, { link: false });
    form.querySelector('#rw-results').hidden = true;
    form.elements.find.value = '';
    form.__picked = u;
    // hand the choice to the open reward flow
    pickedHook(u, form);
});
let pickedHook = () => {};
export function onPicked(fn) { pickedHook = fn; }

// ---------- Message a user (opens a helpline thread) ----------
export async function message(u) {
    if (!guard('support.manage')) return false;
    if (!api.caps.full) return modal({ title: `Message ${name(u)}`, icon: 'mail', body: upgradeNote('Messaging users'), confirm: 'OK', cancel: 'Close', onSubmit: () => true });
    return modal({
        title: `Message ${name(u)}`, icon: 'mail', confirm: 'Send message', text: 'Opens a helpline conversation they see in Cordial (and get a notification for). Replies come back to Support.',
        body: `<label class="field"><span>Subject</span><input class="input" name="subject" maxlength="140" value="A message from Cordial"></label>
               <label class="field"><span>Message</span><textarea class="input" name="body" maxlength="4000" rows="5" required></textarea></label>`,
        async onSubmit(f) {
            if (!f.elements.body.value.trim()) throw new Error('Write a message');
            await api.messageUser(u.id, f.elements.subject.value.trim(), f.elements.body.value.trim());
            toast('Message sent');
        }
    });
}

// ---------- Bulk ----------
export async function bulk(list, status) {
    const perm = { suspended: 'users.suspend', blocked: 'users.block', active: 'users.reactivate' }[status];
    if (!guard(perm)) return false;
    const n = list.length;
    return modal({
        title: `${status === 'active' ? 'Restore' : status === 'suspended' ? 'Suspend' : 'Block'} ${n} ${n === 1 ? 'account' : 'accounts'}`,
        icon: status === 'active' ? 'undo' : 'alert', tone: status === 'active' ? '' : 'bad', confirmTone: status === 'active' ? 'primary' : 'danger',
        confirm: status === 'active' ? 'Restore all' : 'Apply to all', typed: status === 'active' ? '' : `${n}`,
        text: `Each account is checked and recorded separately. Admin accounts are skipped unless you’re a super admin.`,
        body: `<div class="summary" style="grid-template-columns:1fr">${list.slice(0, 8).map(u => `<span>${esc(u.display_name)} <span class="muted">@${esc(u.username)}</span></span>`).join('')}${n > 8 ? `<span class="muted">and ${n - 8} more</span>` : ''}</div>
            ${status === 'blocked' ? `<fieldset class="field" style="border:0;margin:0;padding:0"><legend>Scope</legend><div class="chips">${SCOPES.map(([k, l]) => `<label class="chip"><input type="checkbox" class="sr" name="scope" value="${k}">${esc(l)}</label>`).join('')}</div></fieldset>` : ''}
            ${status === 'active' ? '<label class="field"><span>Note</span><input class="input" name="reasonText" maxlength="300"></label>' : `${reasonField(status === 'blocked' ? REASONS.block : REASONS.suspend)}${status === 'suspended' ? durationField(72) : ''}`}`,
        onInput(f) {
            if (f.elements.reasonPick) toggleOther(f);
            f.querySelectorAll('.chip input').forEach(i => i.parentElement.setAttribute('aria-checked', String(i.checked)));
            const c = f.querySelector('[data-custom]'); if (c) c.hidden = f.elements.hours.value !== '0';
        },
        async onSubmit(f) {
            const reason = status === 'active' ? (f.elements.reasonText.value.trim() || 'Restored') : readReason(f);
            if (!reason) throw new Error('Choose a reason');
            const scope = [...f.querySelectorAll('[name="scope"]:checked')].map(i => i.value);
            if (status === 'blocked' && !scope.length) throw new Error('Choose what the block covers');
            const d = status === 'suspended' ? readDuration(f) : { hours: null };
            const res = await api.bulkStatus(list.map(u => u.id), { status, reason, scope, hours: d.hours ?? null });
            toast(`${res.done} of ${n} updated${res.failed && res.failed.length ? ` — ${res.failed.length} skipped` : ''}`, { error: !!(res.failed && res.failed.length) });
        }
    });
}

// ---------- Announcement ----------
export async function announcement() {
    return modal({
        title: 'Send announcement', icon: 'megaphone', confirm: 'Publish announcement', text: 'Shown at the top of everyone’s Feed, with an optional notification.',
        body: `<label class="field"><span>Title</span><input class="input" name="title" maxlength="120" required></label>
               <label class="field"><span>Message</span><textarea class="input" name="body" maxlength="1000" rows="4"></textarea></label>
               <label class="field"><span>Link <small>(optional)</small></span><input class="input" name="link" placeholder="#/play or https://…"></label>
               <label class="field"><span>Show for</span><select class="input" name="days"><option value="1">1 day</option><option value="3">3 days</option><option value="7" selected>7 days</option><option value="30">30 days</option></select></label>
               <label style="display:flex;gap:8px;align-items:center"><input type="checkbox" name="notify" checked> Notify everyone</label>`,
        async onSubmit(f) {
            if (!f.elements.title.value.trim()) throw new Error('Add a title');
            await api.announce(f.elements.title.value.trim(), f.elements.body.value.trim(), f.elements.link.value.trim(), Number(f.elements.days.value), f.elements.notify.checked);
            toast('Announcement published');
        }
    });
}

export { friendly, STATUS };
