// Book marketplace: readers sell, rent out or give away books. A listing gets requests; the seller accepts
// one, and the two of them sort out the handover in a private conversation attached to that request.
// Payment happens between people — Cordial never handles money (the UI says so, with safety tips).
document.addEventListener('DOMContentLoaded', () => {
    const app = window.diaryApp;
    const social = window.diarySocial;
    if (!app || !social || !social.available) return;
    const I = social.internals;
    const { client, esc, avatar, timeAgo } = I;
    const s = I.state;
    const cfg = window.DIARY_CONFIG;
    const content = document.getElementById('content');
    const BUCKET = 'diary-market';
    const $ = id => document.getElementById(id);

    const KINDS = { sell: 'For sale', rent: 'For rent', gift: 'Free' };
    const KIND_VERB = { sell: 'Buy', rent: 'Rent', gift: 'Ask for it' };
    const CONDITIONS = [['new', 'New'], ['like_new', 'Like new'], ['good', 'Good'], ['fair', 'Fair'], ['worn', 'Well loved']];
    const CONDITION = Object.fromEntries(CONDITIONS);
    const PERIODS = { day: 'day', week: 'week', month: 'month' };
    const STATUS = { available: 'Available', reserved: 'Reserved', rented: 'Rented out', closed: 'Gone' };
    const REQ_STATUS = { pending: 'Waiting', accepted: 'Accepted', declined: 'Declined', cancelled: 'Cancelled', completed: 'Done' };
    const CURRENCIES = ['NGN', 'GHS', 'KES', 'ZAR', 'EGP', 'GBP', 'EUR', 'USD', 'CAD', 'INR', 'AUD', 'AED', 'BRL', 'JPY', 'CNY'];
    const COUNTRY_CURRENCY = { NG: 'NGN', GH: 'GHS', KE: 'KES', ZA: 'ZAR', EG: 'EGP', GB: 'GBP', US: 'USD', CA: 'CAD', IN: 'INR', AU: 'AUD', AE: 'AED', BR: 'BRL', JP: 'JPY', CN: 'CNY', FR: 'EUR', DE: 'EUR', IE: 'EUR', IT: 'EUR', ES: 'EUR', NL: 'EUR', PT: 'EUR', BE: 'EUR' };
    const PROFILE = 'id, username, display_name, avatar_path';
    const LISTING_SELECT = `*, seller_profile:diary_profiles!diary_book_listings_seller_fkey(${PROFILE})`;
    const REQUEST_SELECT = `*,
        requester_profile:diary_profiles!diary_book_requests_requester_fkey(${PROFILE}),
        seller_profile:diary_profiles!diary_book_requests_seller_fkey(${PROFILE}),
        listing:diary_book_listings(id, title, author_name, kind, price, currency, rent_period, deposit, photos, status, seller)`;

    const M = {
        tab: 'browse',          // browse | mine | requests
        kind: 'all',            // all | sell | rent | gift
        sort: 'new',            // new | near | price
        query: '',
        listings: null,
        mine: null,
        requests: null,
        loading: false,
        channel: null,
        userId: null,
        deal: null,             // open conversation { id, messages }
        place: (() => {
            try { return JSON.parse(localStorage.getItem('diaryNewsPlace')) || {}; } catch (e) { return {}; }
        })()
    };
    const me = () => s.profile && s.profile.id;
    const myCurrency = () => {
        try { const saved = localStorage.getItem('diaryMarketCurrency'); if (saved) return saved; } catch (e) {}
        const c = M.place.country || (navigator.language || '').split('-')[1];
        return COUNTRY_CURRENCY[(c || '').toUpperCase()] || 'USD';
    };

    // ---------- Formatting ----------
    function money(amount, currency) {
        if (amount === null || amount === undefined) return '';
        try {
            return new Intl.NumberFormat(undefined, { style: 'currency', currency, currencyDisplay: 'narrowSymbol', maximumFractionDigits: Number(amount) % 1 ? 2 : 0 }).format(amount);
        } catch (e) {
            return `${currency} ${amount}`;
        }
    }
    function priceLabel(l) {
        if (l.kind === 'gift') return 'Free';
        const p = money(l.price, l.currency);
        return l.kind === 'rent' ? `${p} / ${PERIODS[l.rent_period] || 'week'}` : p;
    }
    const photoUrl = path => `${cfg.supabaseUrl}/storage/v1/object/public/${BUCKET}/${String(path).split('/').map(encodeURIComponent).join('/')}`;
    const person = p => p || { id: '', username: 'someone', display_name: 'Someone' };

    // A cover for books without a photo: the title set on a colour that's stable per listing
    const COVER = [['#1e3a8a', '#3b82f6'], ['#7c2d12', '#f97316'], ['#14532d', '#22c55e'], ['#4c1d95', '#a855f7'], ['#831843', '#ec4899'], ['#134e4a', '#14b8a6'], ['#3f3f46', '#a1a1aa']];
    function coverStyle(id) {
        let h = 0;
        for (const ch of String(id)) h = (h * 31 + ch.charCodeAt(0)) | 0;
        const [a, b] = COVER[Math.abs(h) % COVER.length];
        return `--c1:${a};--c2:${b}`;
    }
    function coverHTML(l, cls = '') {
        const first = (l.photos || [])[0];
        if (first) return `<span class="mk-cover ${cls}"><img src="${esc(photoUrl(first))}" alt="" loading="lazy"></span>`;
        return `<span class="mk-cover mk-cover-made ${cls}" style="${coverStyle(l.id)}"><strong>${esc(l.title)}</strong>${l.author_name ? `<small>${esc(l.author_name)}</small>` : ''}</span>`;
    }

    // ---------- Data ----------
    async function loadListings() {
        if (M.loading) return;
        M.loading = true;
        const [all, mine] = await Promise.all([
            client.from('diary_book_listings').select(LISTING_SELECT).in('status', ['available', 'reserved']).order('created_at', { ascending: false }).limit(120),
            client.from('diary_book_listings').select(LISTING_SELECT).eq('seller', me()).order('created_at', { ascending: false })
        ]);
        M.loading = false;
        M.listings = all.error ? [] : all.data;
        M.mine = mine.error ? [] : mine.data;
        M.error = !!all.error;
        app.requestRender(['market', 'explore']);
    }

    async function loadRequests() {
        const { data, error } = await client.from('diary_book_requests').select(REQUEST_SELECT).order('updated_at', { ascending: false }).limit(100);
        M.requests = error ? [] : data;
        paintBadge();
        app.requestRender('market');
        if (M.deal) paintDealHead();
    }

    function subscribe() {
        if (M.channel) client.removeChannel(M.channel);
        M.channel = client.channel(`diary-market-${me()}`)
            .on('postgres_changes', { event: '*', schema: 'public', table: 'diary_book_requests' }, () => loadRequests())
            .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'diary_book_messages' }, ({ new: m }) => onDealMessage(m))
            .on('postgres_changes', { event: '*', schema: 'public', table: 'diary_book_listings' }, () => {
                clearTimeout(subscribe.t);
                subscribe.t = setTimeout(loadListings, 800);
            })
            .subscribe();
    }

    // Start/stop with the signed-in account
    setInterval(() => {
        const id = me();
        if (id && M.userId !== id) {
            M.userId = id;
            Object.assign(M, { listings: null, mine: null, requests: null, deal: null });
            subscribe();
            loadRequests();
        }
        if (!id && M.userId) {
            if (M.channel) client.removeChannel(M.channel);
            Object.assign(M, { userId: null, channel: null, listings: null, mine: null, requests: null });
        }
    }, 1000);

    const pendingForMe = () => (M.requests || []).filter(r => r.seller === me() && r.status === 'pending').length;
    function paintBadge() {
        const n = pendingForMe();
        document.querySelectorAll('[data-view="market"]').forEach(b => {
            let badge = b.querySelector('.nav-count');
            if (!badge) {
                badge = document.createElement('span');
                badge.className = 'nav-count badge';
                b.append(badge);
            }
            badge.textContent = n ? String(n) : '';
        });
    }

    // ---------- The page ----------
    app.views.market = () => {
        app.setTitle('Marketplace');
        const blocked = I.gate('Buy, rent and give away books with readers near you.');
        if (blocked) return blocked;
        if (M.listings === null) loadListings();
        if (M.requests === null) loadRequests();

        const incoming = pendingForMe();
        const tab = (key, label, count) => `<button type="button" class="tab" role="tab" aria-selected="${M.tab === key}" data-action="mk-tab" data-tab="${key}">${label}${count ? `<span class="badge">${count}</span>` : ''}</button>`;
        let body;
        if (M.tab === 'mine') body = mineTab();
        else if (M.tab === 'requests') body = requestsTab();
        else body = browseTab();
        return `
            <div class="mk">
                <section class="mk-hero">
                    <div class="mk-hero-text">
                        <p class="mk-kicker"><svg class="i"><use href="#i-store"/></svg>Book marketplace</p>
                        <h2>Pass your books on</h2>
                        <p>Sell, rent out or give away the books on your shelf — and find your next read from people nearby.</p>
                    </div>
                    <button type="button" class="primary-btn mk-list-btn" data-action="mk-new"><svg class="i"><use href="#i-plus"/></svg>List a book</button>
                </section>
                <div class="tabs mk-tabs" role="tablist">${tab('browse', 'Browse')}${tab('mine', 'My listings', 0)}${tab('requests', 'Requests', incoming)}</div>
                ${body}
            </div>`;
    };

    function filtered() {
        const q = M.query.trim().toLowerCase();
        let list = (M.listings || []).filter(l => M.kind === 'all' || l.kind === M.kind);
        if (q) list = list.filter(l => `${l.title} ${l.author_name || ''} ${l.genre || ''} ${l.city || ''} ${l.description || ''}`.toLowerCase().includes(q));
        const city = (M.place.city || '').toLowerCase();
        const country = (M.place.country || '').toUpperCase();
        const near = l => (city && (l.city || '').toLowerCase() === city ? 2 : 0) + (country && l.country === country ? 1 : 0);
        if (M.sort === 'near') list = [...list].sort((a, b) => near(b) - near(a) || Date.parse(b.created_at) - Date.parse(a.created_at));
        if (M.sort === 'price') list = [...list].sort((a, b) => (a.kind === 'gift' ? -1 : Number(a.price)) - (b.kind === 'gift' ? -1 : Number(b.price)));
        // Available books first
        return list.sort((a, b) => (a.status === 'available' ? 0 : 1) - (b.status === 'available' ? 0 : 1));
    }

    function browseTab() {
        const chip = (k, label) => `<button type="button" class="cm-filter" aria-pressed="${M.kind === k}" data-action="mk-kind" data-kind="${k}">${label}</button>`;
        const list = M.listings === null ? null : filtered();
        return `
            <div class="mk-tools">
                <label class="search mk-search">
                    <svg class="i"><use href="#i-search"/></svg>
                    <input type="search" id="mk-search" placeholder="Search title, author, genre or city" aria-label="Search books" value="${esc(M.query)}" enterkeyhint="search" autocomplete="off">
                </label>
                <label class="mk-sort"><span class="sr-only">Sort</span>
                    <select id="mk-sort" aria-label="Sort books">
                        <option value="new"${M.sort === 'new' ? ' selected' : ''}>Newest</option>
                        <option value="near"${M.sort === 'near' ? ' selected' : ''}>Near me</option>
                        <option value="price"${M.sort === 'price' ? ' selected' : ''}>Lowest price</option>
                    </select>
                </label>
            </div>
            <div class="mk-kinds" role="group" aria-label="Show">${chip('all', 'All books')}${chip('sell', 'For sale')}${chip('rent', 'For rent')}${chip('gift', 'Free')}</div>
            <div id="mk-results">${resultsHTML(list)}</div>`;
    }

    function resultsHTML(list) {
        if (list === null) return `<div class="mk-grid">${'<span class="mk-card skel"></span>'.repeat(8)}</div>`;
        if (M.error) return '<div class="ex-empty"><strong>Couldn’t load the marketplace</strong><span>Check your connection and pull to refresh.</span></div>';
        if (!list.length) {
            return `<div class="ex-empty mk-empty"><svg class="i"><use href="#i-store"/></svg><strong>${M.query || M.kind !== 'all' ? 'No books match that' : 'No books listed yet'}</strong>
                <span>${M.query || M.kind !== 'all' ? 'Try another search or filter.' : 'Be the first — list a book you’ve finished.'}</span>
                <button type="button" class="primary-btn small" data-action="mk-new"><svg class="i"><use href="#i-plus"/></svg>List a book</button></div>`;
        }
        return `<div class="mk-grid">${list.map(card).join('')}</div>`;
    }

    function card(l) {
        const seller = person(l.seller_profile);
        const mine = l.seller === me();
        return `
            <button type="button" class="mk-card${l.status !== 'available' ? ' unavailable' : ''}" data-action="mk-open" data-id="${esc(l.id)}" aria-label="${esc(`${l.title}, ${priceLabel(l)}${l.status !== 'available' ? `, ${STATUS[l.status]}` : ''}`)}">
                <span class="mk-card-cover">
                    ${coverHTML(l)}
                    <span class="mk-kind k-${l.kind}">${l.kind === 'gift' ? '<svg class="i"><use href="#i-gift"/></svg>' : l.kind === 'rent' ? '<svg class="i"><use href="#i-repeat"/></svg>' : '<svg class="i"><use href="#i-tag"/></svg>'}${KINDS[l.kind]}</span>
                    ${l.status !== 'available' ? `<span class="mk-status">${STATUS[l.status]}</span>` : ''}
                </span>
                <span class="mk-card-body">
                    <strong class="mk-price">${esc(priceLabel(l))}</strong>
                    <span class="mk-title">${esc(l.title)}</span>
                    ${l.author_name ? `<span class="mk-author">${esc(l.author_name)}</span>` : ''}
                    <span class="mk-meta">${esc(CONDITION[l.condition] || '')}${l.city ? ` · ${esc(l.city)}` : ''}</span>
                    <span class="mk-seller">${avatar(seller, 'xs')}<span>${mine ? 'You' : esc(seller.display_name)}</span></span>
                </span>
            </button>`;
    }

    function mineTab() {
        if (M.mine === null) return `<div class="mk-grid">${'<span class="mk-card skel"></span>'.repeat(4)}</div>`;
        if (!M.mine.length) {
            return `<div class="ex-empty mk-empty"><svg class="i"><use href="#i-book"/></svg><strong>You haven’t listed any books</strong>
                <span>Finished a book? Sell it, rent it out or give it to someone who’ll love it.</span>
                <button type="button" class="primary-btn small" data-action="mk-new"><svg class="i"><use href="#i-plus"/></svg>List a book</button></div>`;
        }
        const open = M.mine.filter(l => l.status !== 'closed');
        const gone = M.mine.filter(l => l.status === 'closed');
        return `
            ${open.length ? `<div class="mk-grid">${open.map(card).join('')}</div>` : ''}
            ${gone.length ? `<h3 class="mk-sub">Sold &amp; given away</h3><div class="mk-grid">${gone.map(card).join('')}</div>` : ''}`;
    }

    function requestsTab() {
        if (M.requests === null) return '<p class="muted">Loading requests…</p>';
        const incoming = M.requests.filter(r => r.seller === me());
        const outgoing = M.requests.filter(r => r.requester === me());
        const section = (title, sub, list, empty) => `
            <section class="mk-req-sec">
                <h3 class="mk-sub">${title}<small>${sub}</small></h3>
                ${list.length ? `<div class="mk-reqs">${list.map(requestRow).join('')}</div>` : `<p class="muted small mk-none">${empty}</p>`}
            </section>`;
        return `
            ${section('For your books', 'People who want what you listed', incoming, 'No requests yet — they’ll show up here.')}
            ${section('Books you asked for', 'Your requests to other readers', outgoing, 'When you ask for a book, you can follow it here.')}
            ${safetyNote()}`;
    }

    function requestRow(r) {
        const mine = r.seller === me();
        const other = person(mine ? r.requester_profile : r.seller_profile);
        const l = r.listing || { title: 'Listing removed', kind: 'sell', photos: [] };
        return `
            <button type="button" class="mk-req${r.status === 'pending' && mine ? ' needs' : ''}" data-action="mk-deal" data-id="${esc(r.id)}">
                ${coverHTML({ ...l, id: l.id || r.id }, 'sm')}
                <span class="mk-req-text">
                    <strong>${esc(l.title)}</strong>
                    <span>${mine ? `${esc(other.display_name)} wants to ${l.kind === 'rent' ? 'rent it' : l.kind === 'gift' ? 'have it' : 'buy it'}` : `From ${esc(other.display_name)}`}${r.offer !== null && r.offer !== undefined ? ` · offered ${esc(money(r.offer, l.currency || 'USD'))}` : ''}</span>
                    <small>${timeAgo(r.updated_at)}</small>
                </span>
                <span class="mk-pill s-${r.status}">${REQ_STATUS[r.status]}</span>
            </button>`;
    }

    const safetyNote = () => `
        <aside class="mk-safety">
            <svg class="i"><use href="#i-info"/></svg>
            <p><strong>Trade safely.</strong> Meet somewhere public, check the book before you pay, and never send money to someone you haven’t met. Cordial doesn’t handle payments.</p>
        </aside>`;

    // Search re-draws only the results so typing keeps focus
    content.addEventListener('input', e => {
        if (e.target.id !== 'mk-search') return;
        M.query = e.target.value;
        const box = $('mk-results');
        if (box) box.innerHTML = resultsHTML(filtered());
    });
    content.addEventListener('change', e => {
        if (e.target.id !== 'mk-sort') return;
        M.sort = e.target.value;
        if (M.sort === 'near' && !M.place.city && !M.place.country) app.showToast('Set your city under Explore → News → Local to sort by distance');
        const box = $('mk-results');
        if (box) box.innerHTML = resultsHTML(filtered());
    });

    app.onRefresh('market', async () => {
        M.listings = null;
        await Promise.all([loadListings(), loadRequests()]);
    });

    // ---------- Listing details ----------
    function dialog(id, cls, label) {
        let d = $(id);
        if (!d) {
            d = document.createElement('dialog');
            d.id = id;
            d.className = `mk-dialog ${cls}`;
            d.setAttribute('aria-label', label);
            document.body.append(d);
            // Dialogs live outside the page, so their buttons (close, edit, accept…) are wired up here;
            // a tap on the dimmed backdrop closes the sheet
            d.addEventListener('click', e => {
                if (e.target === d) return d.close();
                const el = e.target.closest('[data-action]');
                if (el && d.contains(el) && app.actions[el.dataset.action]) {
                    e.preventDefault();
                    app.actions[el.dataset.action](el, e);
                }
            });
        }
        return d;
    }

    function findListing(id) {
        return [...(M.listings || []), ...(M.mine || [])].find(l => l.id === id);
    }

    async function openListing(id) {
        let l = findListing(id);
        if (!l) {
            const { data } = await client.from('diary_book_listings').select(LISTING_SELECT).eq('id', id).maybeSingle();
            l = data;
        }
        if (!l) return app.showToast('That listing is no longer available');
        const d = dialog('mk-detail', 'mk-detail', 'Book details');
        d.innerHTML = detailHTML(l);
        if (!d.open) d.showModal();
        d.querySelector('.mk-close')?.focus({ preventScroll: true });
    }

    function detailHTML(l) {
        const mine = l.seller === me();
        const seller = person(l.seller_profile);
        const photos = l.photos || [];
        const open = (M.requests || []).find(r => r.listing_id === l.id && r.requester === me() && ['pending', 'accepted'].includes(r.status));
        const requestsFor = (M.requests || []).filter(r => r.listing_id === l.id && r.seller === me());
        const facts = [
            ['Condition', CONDITION[l.condition]],
            l.genre && ['Genre', esc(l.genre)],
            l.kind === 'rent' && l.deposit !== null && l.deposit !== undefined && ['Deposit', esc(money(l.deposit, l.currency))],
            ['Handover', [l.pickup && 'Pick-up', l.delivery && 'Delivery'].filter(Boolean).join(' or ') || 'Arrange with seller'],
            l.city && ['Where', esc([l.city, l.country].filter(Boolean).join(', '))],
            ['Visible to', l.visibility === 'friends' ? 'Friends only' : 'Everyone']
        ].filter(Boolean);
        let cta;
        if (mine) {
            cta = `
                <div class="mk-owner">
                    <button type="button" class="chip" data-action="mk-edit" data-id="${esc(l.id)}"><svg class="i"><use href="#i-edit"/></svg>Edit</button>
                    ${l.status !== 'available' ? `<button type="button" class="chip" data-action="mk-status" data-id="${esc(l.id)}" data-status="available">${l.status === 'rented' ? 'It’s back — available again' : 'Mark available'}</button>` : ''}
                    ${l.status !== 'closed' ? `<button type="button" class="chip" data-action="mk-status" data-id="${esc(l.id)}" data-status="closed">Mark as gone</button>` : ''}
                    <button type="button" class="chip danger" data-action="mk-delete" data-id="${esc(l.id)}"><svg class="i"><use href="#i-trash"/></svg>Delete</button>
                </div>
                ${requestsFor.length ? `<div class="mk-reqs compact">${requestsFor.map(requestRow).join('')}</div>` : '<p class="muted small">No requests yet. We’ll notify you when someone asks.</p>'}`;
        } else if (open) {
            cta = `<button type="button" class="primary-btn block" data-action="mk-deal" data-id="${esc(open.id)}"><svg class="i"><use href="#i-chat"/></svg>Open your conversation</button>
                <p class="muted small center">You asked ${timeAgo(open.created_at)} · ${REQ_STATUS[open.status]}</p>`;
        } else if (l.status !== 'available') {
            cta = `<p class="mk-unavailable">${STATUS[l.status]} — check back later.</p>`;
        } else {
            cta = `
                <form class="mk-ask" data-form="mk-request" data-id="${esc(l.id)}">
                    <label class="mk-field"><span>Message to ${esc(seller.display_name.split(' ')[0])}</span>
                        <textarea id="mk-note" rows="2" maxlength="500" placeholder="${l.kind === 'gift' ? 'Say why you’d love it…' : 'Hi! Is it still available? When could I pick it up?'}"></textarea></label>
                    ${l.kind !== 'gift' ? `<label class="mk-field"><span>Your offer (optional)</span>
                        <span class="mk-money"><span>${esc(l.currency)}</span><input id="mk-offer" type="number" inputmode="decimal" min="0" step="any" placeholder="${esc(String(l.price))}"></span></label>` : ''}
                    <button type="submit" class="primary-btn block">${KIND_VERB[l.kind]}${l.kind === 'gift' ? '' : ` — ${esc(priceLabel(l))}`}</button>
                </form>`;
        }
        return `
            <div class="mk-sheet">
                <header class="mk-sheet-head">
                    <button type="button" class="icon-btn mk-close" data-action="mk-close" aria-label="Close"><svg class="i"><use href="#i-close"/></svg></button>
                    <span class="mk-kind k-${l.kind}">${KINDS[l.kind]}</span>
                </header>
                <div class="mk-gallery${photos.length ? '' : ' none'}">
                    ${photos.length ? `<div class="mk-slides">${photos.map((p, i) => `<button type="button" class="mk-slide" data-action="mk-photo" data-src="${esc(photoUrl(p))}" aria-label="Photo ${i + 1} of ${photos.length}"><img src="${esc(photoUrl(p))}" alt=""></button>`).join('')}</div>
                        ${photos.length > 1 ? `<span class="mk-count">${photos.length} photos · swipe</span>` : ''}` : coverHTML(l, 'lg')}
                </div>
                <div class="mk-info">
                    <p class="mk-price big">${esc(priceLabel(l))}${l.status !== 'available' ? ` <span class="mk-pill s-${l.status}">${STATUS[l.status]}</span>` : ''}</p>
                    <h2 class="mk-dtitle">${esc(l.title)}</h2>
                    ${l.author_name ? `<p class="mk-dauthor">by ${esc(l.author_name)}</p>` : ''}
                    <dl class="mk-facts">${facts.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('')}</dl>
                    ${l.description ? `<p class="mk-desc">${esc(l.description)}</p>` : ''}
                    <div class="mk-seller-row">${avatar(seller, 'md')}<span><strong>${mine ? 'You' : esc(seller.display_name)}</strong><small>@${esc(seller.username)} · listed ${timeAgo(l.created_at)}</small></span>${!mine && window.diarySafety ? `<button type="button" class="link-btn mk-report" data-action="mk-report" data-id="${esc(l.id)}"><svg class="i"><use href="#i-flag"/></svg>Report</button>` : ''}</div>
                    ${cta}
                    ${mine ? '' : safetyNote()}
                </div>
            </div>`;
    }

    // ---------- New / edit listing ----------
    let draftPhotos = []; // [{ path } | { file, preview }]

    function openForm(l = null) {
        draftPhotos = (l ? l.photos || [] : []).map(path => ({ path }));
        const d = dialog('mk-form', 'mk-form-dialog', l ? 'Edit listing' : 'List a book');
        const kind = l ? l.kind : 'sell';
        const currency = l ? l.currency : myCurrency();
        d.innerHTML = `
            <form class="mk-sheet mk-form" data-form="mk-save" data-id="${l ? esc(l.id) : ''}" novalidate>
                <header class="mk-sheet-head">
                    <button type="button" class="icon-btn mk-close" data-action="mk-close" aria-label="Close"><svg class="i"><use href="#i-close"/></svg></button>
                    <h2 id="mk-form-title">${l ? 'Edit listing' : 'List a book'}</h2>
                </header>
                <div class="mk-form-body">
                    <div class="mk-seg" role="radiogroup" aria-label="What would you like to do?">
                        ${[['sell', 'Sell', 'i-tag'], ['rent', 'Rent out', 'i-repeat'], ['gift', 'Give away', 'i-gift']].map(([k, label, icon]) => `
                            <label class="mk-seg-opt"><input type="radio" name="mk-kind" value="${k}"${kind === k ? ' checked' : ''}><span><svg class="i"><use href="#${icon}"/></svg>${label}</span></label>`).join('')}
                    </div>
                    <div class="mk-photos" id="mk-photos"></div>
                    <label class="mk-field"><span>Title</span><input id="mk-title" required maxlength="160" value="${l ? esc(l.title) : ''}" placeholder="e.g. Things Fall Apart" autocomplete="off"></label>
                    <label class="mk-field"><span>Author</span><input id="mk-author" maxlength="120" value="${l ? esc(l.author_name || '') : ''}" placeholder="e.g. Chinua Achebe" autocomplete="off"></label>
                    <div class="mk-row2">
                        <label class="mk-field"><span>Condition</span><select id="mk-condition">${CONDITIONS.map(([k, label]) => `<option value="${k}"${(l ? l.condition : 'good') === k ? ' selected' : ''}>${label}</option>`).join('')}</select></label>
                        <label class="mk-field"><span>Genre</span><input id="mk-genre" maxlength="40" value="${l ? esc(l.genre || '') : ''}" placeholder="Fiction, poetry…" list="mk-genres"></label>
                    </div>
                    <datalist id="mk-genres">${['Fiction', 'Non-fiction', 'Poetry', 'Romance', 'Thriller', 'Fantasy', 'Sci-fi', 'Biography', 'Self-help', 'Faith', 'Children', 'Textbook', 'Business', 'History'].map(g => `<option value="${g}">`).join('')}</datalist>
                    <div class="mk-price-fields">
                        <div class="mk-row2">
                            <label class="mk-field"><span id="mk-price-label">Price</span>
                                <span class="mk-money"><select id="mk-currency" aria-label="Currency">${CURRENCIES.map(c => `<option${c === currency ? ' selected' : ''}>${c}</option>`).join('')}</select><input id="mk-price" type="number" inputmode="decimal" min="0" step="any" value="${l && l.price !== null ? esc(String(l.price)) : ''}" placeholder="0"></span></label>
                            <label class="mk-field mk-rent-only"><span>Per</span><select id="mk-period">${Object.keys(PERIODS).map(p => `<option value="${p}"${(l && l.rent_period ? l.rent_period : 'week') === p ? ' selected' : ''}>${p}</option>`).join('')}</select></label>
                        </div>
                        <label class="mk-field mk-rent-only"><span>Refundable deposit (optional)</span><input id="mk-deposit" type="number" inputmode="decimal" min="0" step="any" value="${l && l.deposit !== null && l.deposit !== undefined ? esc(String(l.deposit)) : ''}" placeholder="0"></label>
                    </div>
                    <label class="mk-field"><span>Description</span><textarea id="mk-desc" rows="3" maxlength="2000" placeholder="Edition, notes in the margins, why you loved it…">${l ? esc(l.description || '') : ''}</textarea></label>
                    <div class="mk-row2">
                        <label class="mk-field"><span>City</span><input id="mk-city" maxlength="60" value="${esc(l ? l.city || '' : M.place.city || '')}" placeholder="e.g. Lagos" autocomplete="address-level2"></label>
                        <label class="mk-field"><span>Country code</span><input id="mk-country" maxlength="2" value="${esc(l ? l.country || '' : M.place.country || '')}" placeholder="NG" autocapitalize="characters" autocomplete="country"></label>
                    </div>
                    <fieldset class="mk-checks"><legend>Handover</legend>
                        <label><input type="checkbox" id="mk-pickup"${!l || l.pickup ? ' checked' : ''}> Pick-up</label>
                        <label><input type="checkbox" id="mk-delivery"${l && l.delivery ? ' checked' : ''}> I can deliver or post it</label>
                    </fieldset>
                    <label class="mk-field"><span>Who can see it</span><select id="mk-visibility">
                        <option value="public"${!l || l.visibility === 'public' ? ' selected' : ''}>Everyone on Cordial</option>
                        <option value="friends"${l && l.visibility === 'friends' ? ' selected' : ''}>Friends only</option>
                    </select></label>
                    <p class="mk-error" id="mk-error" role="alert" hidden></p>
                </div>
                <footer class="mk-form-foot">
                    <button type="submit" class="primary-btn block" id="mk-submit">${l ? 'Save changes' : 'Publish listing'}</button>
                </footer>
            </form>`;
        paintKind(d);
        paintPhotos();
        if (!d.open) d.showModal();
        setTimeout(() => $('mk-title')?.focus({ preventScroll: true }), 60);
    }

    function paintKind(d = $('mk-form')) {
        const kind = d.querySelector('input[name="mk-kind"]:checked').value;
        d.querySelector('.mk-price-fields').hidden = kind === 'gift';
        d.querySelectorAll('.mk-rent-only').forEach(el => { el.hidden = kind !== 'rent'; });
        $('mk-price-label').textContent = kind === 'rent' ? 'Rent' : 'Price';
    }

    function paintPhotos() {
        const box = $('mk-photos');
        if (!box) return;
        box.innerHTML = `
            ${draftPhotos.map((p, i) => `
                <span class="mk-thumb">
                    <img src="${esc(p.path ? photoUrl(p.path) : p.preview)}" alt="Photo ${i + 1}">
                    ${!p.path && window.PhotoEditor ? `<button type="button" class="mk-thumb-edit" data-action="mk-photo-edit" data-i="${i}" aria-label="Edit photo ${i + 1}"><svg class="i"><use href="#i-wand"/></svg></button>` : ''}
                    <button type="button" class="mk-thumb-x" data-action="mk-photo-remove" data-i="${i}" aria-label="Remove photo ${i + 1}"><svg class="i"><use href="#i-close"/></svg></button>
                </span>`).join('')}
            ${draftPhotos.length < 4 ? `<button type="button" class="mk-add-photo" data-action="mk-photo-add"><svg class="i"><use href="#i-image"/></svg><span>${draftPhotos.length ? 'Add' : 'Add photos'}</span><small>${draftPhotos.length}/4</small></button>` : ''}`;
    }

    async function saveListing(form) {
        const err = $('mk-error');
        const fail = msg => { err.textContent = msg; err.hidden = false; };
        err.hidden = true;
        const kind = form.querySelector('input[name="mk-kind"]:checked').value;
        const title = $('mk-title').value.trim();
        const priceRaw = $('mk-price').value.trim();
        const depositRaw = $('mk-deposit').value.trim();
        if (!title) { $('mk-title').focus(); return fail('Add the book’s title.'); }
        if (kind !== 'gift' && (priceRaw === '' || !(Number(priceRaw) >= 0))) { $('mk-price').focus(); return fail(kind === 'rent' ? 'Set how much the rent is.' : 'Set a price — or choose “Give away”.'); }
        const country = $('mk-country').value.trim().toUpperCase();
        if (country && !/^[A-Z]{2}$/.test(country)) { $('mk-country').focus(); return fail('Use a two-letter country code, like NG or GB.'); }
        const btn = $('mk-submit');
        btn.disabled = true;
        btn.textContent = draftPhotos.some(p => p.file) ? 'Uploading photos…' : 'Saving…';
        try {
            const uploaded = [];
            const paths = [];
            for (const p of draftPhotos) {
                if (p.path) { paths.push(p.path); continue; }
                const path = await I.uploadImage(BUCKET, `${me()}/${I.randomId()}`, p.file);
                if (!path) throw new Error('A photo couldn’t be uploaded — try a JPEG or PNG.');
                uploaded.push(path);
                paths.push(path);
            }
            const currency = $('mk-currency').value;
            try { localStorage.setItem('diaryMarketCurrency', currency); } catch (e) {}
            const row = {
                kind, title,
                author_name: $('mk-author').value.trim() || null,
                description: $('mk-desc').value.trim() || null,
                genre: $('mk-genre').value.trim() || null,
                condition: $('mk-condition').value,
                price: kind === 'gift' ? null : Number(priceRaw),
                currency,
                rent_period: kind === 'rent' ? $('mk-period').value : null,
                deposit: kind === 'rent' && depositRaw !== '' ? Number(depositRaw) : null,
                city: $('mk-city').value.trim() || null,
                country: country || null,
                pickup: $('mk-pickup').checked,
                delivery: $('mk-delivery').checked,
                photos: paths,
                visibility: $('mk-visibility').value
            };
            const id = form.dataset.id;
            const before = id ? findListing(id) : null;
            const { error } = id
                ? await client.from('diary_book_listings').update(row).eq('id', id)
                : await client.from('diary_book_listings').insert(row);
            if (error) {
                if (uploaded.length) client.storage.from(BUCKET).remove(uploaded);
                throw new Error('Couldn’t save the listing — check the details and try again.');
            }
            // Photos taken off an edited listing are deleted
            if (before) {
                const dropped = (before.photos || []).filter(p => !paths.includes(p));
                if (dropped.length) client.storage.from(BUCKET).remove(dropped);
            }
            $('mk-form').close();
            app.showToast(id ? 'Listing updated' : 'Your book is listed ✨');
            M.tab = id ? M.tab : 'mine';
            await loadListings();
            if (id && $('mk-detail')?.open) openListing(id);
        } catch (e) {
            fail(e.message);
        } finally {
            btn.disabled = false;
            btn.textContent = form.dataset.id ? 'Save changes' : 'Publish listing';
        }
    }

    // ---------- Requests & the conversation ----------
    async function sendRequest(form) {
        const btn = form.querySelector('button[type="submit"]');
        const offerEl = $('mk-offer');
        const offer = offerEl && offerEl.value.trim() !== '' ? Number(offerEl.value) : null;
        if (offer !== null && !(offer >= 0)) return app.showToast('That offer doesn’t look right');
        btn.disabled = true;
        const { data, error } = await client.rpc('diary_request_book', { p_listing: form.dataset.id, p_note: $('mk-note').value.trim() || null, p_offer: offer });
        btn.disabled = false;
        if (error) return app.showToast(error.message || 'Couldn’t send your request');
        app.showToast('Request sent — you’ll hear back here');
        await loadRequests();
        openDeal(data.id);
    }

    async function openDeal(id) {
        if (!M.requests || !M.requests.some(r => r.id === id)) await loadRequests();
        const r = (M.requests || []).find(x => x.id === id);
        if (!r) return app.showToast('That request isn’t available');
        $('mk-detail')?.open && $('mk-detail').close();
        M.deal = { id, messages: null };
        const d = dialog('mk-deal', 'mk-deal', 'Book conversation');
        d.innerHTML = `
            <div class="mk-sheet mk-deal-sheet">
                <header class="mk-sheet-head">
                    <button type="button" class="icon-btn mk-close" data-action="mk-close" aria-label="Close"><svg class="i"><use href="#i-close"/></svg></button>
                    <div id="mk-deal-head" class="mk-deal-head"></div>
                </header>
                <div id="mk-deal-actions" class="mk-deal-actions"></div>
                <div class="mk-thread" id="mk-thread" aria-live="polite"><p class="muted small center">Loading…</p></div>
                <form class="mk-compose" data-form="mk-send">
                    <input id="mk-msg" maxlength="2000" placeholder="Write a message…" autocomplete="off" enterkeyhint="send" aria-label="Message">
                    <button type="submit" class="send-btn" aria-label="Send"><svg class="i"><use href="#i-send"/></svg></button>
                </form>
            </div>`;
        if (!d.open) d.showModal();
        d.addEventListener('close', () => { M.deal = null; }, { once: true });
        paintDealHead();
        const { data } = await client.from('diary_book_messages').select('*').eq('request_id', id).order('created_at').limit(300);
        if (!M.deal || M.deal.id !== id) return;
        M.deal.messages = data || [];
        paintThread();
    }

    function paintDealHead() {
        const r = M.deal && (M.requests || []).find(x => x.id === M.deal.id);
        const head = $('mk-deal-head');
        if (!r || !head) return;
        const seller = r.seller === me();
        const other = person(seller ? r.requester_profile : r.seller_profile);
        const l = r.listing || { title: 'Listing removed', kind: 'sell', photos: [] };
        head.innerHTML = `
            ${coverHTML({ ...l, id: l.id || r.id }, 'sm')}
            <span class="mk-deal-title"><strong>${esc(l.title)}</strong><small>${seller ? `${esc(other.display_name)} · wants to ${l.kind === 'rent' ? 'rent' : l.kind === 'gift' ? 'have' : 'buy'} it` : `${esc(other.display_name)} · ${esc(l.kind === 'gift' ? 'Free' : priceLabel(l))}`}${r.offer !== null && r.offer !== undefined ? ` · offer ${esc(money(r.offer, l.currency || 'USD'))}` : ''}</small></span>
            <span class="mk-pill s-${r.status}">${REQ_STATUS[r.status]}</span>`;
        const btn = (action, label, cls = 'chip') => `<button type="button" class="${cls}" data-action="mk-req" data-act="${action}" data-id="${esc(r.id)}">${label}</button>`;
        let actions = '';
        if (seller && r.status === 'pending') actions = btn('accept', `Accept${l.kind === 'rent' ? '' : ' & reserve'}`, 'primary-btn small') + btn('decline', 'Decline');
        else if (seller && r.status === 'accepted') actions = btn('complete', l.kind === 'rent' ? 'Mark as lent out' : 'Mark as handed over', 'primary-btn small') + btn('cancel', 'Cancel');
        else if (!seller && ['pending', 'accepted'].includes(r.status)) actions = btn('cancel', 'Cancel request');
        const tips = {
            pending: seller ? 'Accepting reserves the book for them. You can still chat before deciding.' : 'Waiting for the seller to reply. You can keep chatting here.',
            accepted: 'Agree a time and a public place to meet. Pay only when you have the book.',
            completed: l.kind === 'rent' ? 'Lent out — mark it available again from the listing when it’s back.' : 'All done. Enjoy the book!',
            declined: 'This request was declined.',
            cancelled: 'This request was cancelled.'
        };
        $('mk-deal-actions').innerHTML = `${actions ? `<div class="mk-deal-btns">${actions}</div>` : ''}<p class="muted small">${tips[r.status]}</p>`;
        const compose = document.querySelector('#mk-deal .mk-compose');
        if (compose) compose.hidden = !['pending', 'accepted'].includes(r.status);
    }

    function paintThread() {
        const box = $('mk-thread');
        if (!box || !M.deal || !M.deal.messages) return;
        const list = M.deal.messages;
        box.innerHTML = list.length
            ? list.map(m => `<div class="mk-msg ${m.sender === me() ? 'out' : 'in'}"><p>${esc(m.body)}</p><time>${timeAgo(m.created_at)}</time></div>`).join('')
            : '<p class="muted small center">Say hello and agree on the handover.</p>';
        box.scrollTop = box.scrollHeight;
    }

    function onDealMessage(m) {
        if (M.deal && M.deal.id === m.request_id && M.deal.messages && !M.deal.messages.some(x => x.id === m.id)) {
            M.deal.messages.push(m);
            paintThread();
        } else if (m.sender !== me()) {
            loadRequests();
        }
    }

    async function sendDealMessage(form) {
        const input = $('mk-msg');
        const body = input.value.trim();
        if (!body || !M.deal) return;
        input.value = '';
        const { data, error } = await client.from('diary_book_messages').insert({ request_id: M.deal.id, body }).select().single();
        if (error) {
            input.value = body;
            return app.showToast('Message not sent');
        }
        onDealMessage(data);
    }

    async function actOnRequest(id, action) {
        if (action === 'decline' || action === 'cancel') {
            const ok = await app.ask({ title: action === 'decline' ? 'Decline this request?' : 'Cancel this request?', text: 'The other person will be told.', ok: action === 'decline' ? 'Decline' : 'Cancel request', danger: true });
            if (!ok) return;
        }
        const { error } = await client.rpc('diary_update_book_request', { p_request: id, p_action: action });
        if (error) return app.showToast(error.message || 'Couldn’t update the request');
        app.showToast({ accept: 'Accepted — the book is reserved for them', decline: 'Declined', complete: 'Marked as done 🎉', cancel: 'Cancelled' }[action]);
        await Promise.all([loadRequests(), loadListings()]);
    }

    // ---------- Actions ----------
    Object.assign(app.actions, {
        'go-market': () => app.setView('market'),
        'mk-tab': el => { M.tab = el.dataset.tab; app.render(); },
        'mk-kind': el => { M.kind = el.dataset.kind; app.render(); },
        'mk-new': () => openForm(),
        'mk-open': el => openListing(el.dataset.id),
        'mk-close': el => el.closest('dialog')?.close(),
        'mk-edit': el => { $('mk-detail')?.close(); openForm(findListing(el.dataset.id)); },
        'mk-status': async el => {
            const { error } = await client.from('diary_book_listings').update({ status: el.dataset.status }).eq('id', el.dataset.id);
            if (error) return app.showToast('Couldn’t update the listing');
            await loadListings();
            openListing(el.dataset.id);
        },
        'mk-delete': async el => {
            const l = findListing(el.dataset.id);
            const ok = await app.ask({ title: 'Delete this listing?', text: 'It disappears for everyone, along with its requests and messages.', ok: 'Delete', danger: true });
            if (!ok) return;
            const { error } = await client.from('diary_book_listings').delete().eq('id', el.dataset.id);
            if (error) return app.showToast('Couldn’t delete the listing');
            if (l && l.photos && l.photos.length) client.storage.from(BUCKET).remove(l.photos);
            $('mk-detail')?.close();
            app.showToast('Listing deleted');
            loadListings();
            loadRequests();
        },
        'mk-deal': el => openDeal(el.dataset.id),
        'mk-report': el => window.diarySafety && window.diarySafety.report('listing', el.dataset.id),
        'mk-req': el => actOnRequest(el.dataset.id, el.dataset.act),
        'mk-photo': el => window.Media && Media.lightbox ? Media.lightbox(el.dataset.src, '') : window.open(el.dataset.src, '_blank', 'noopener'),
        'mk-photo-add': async () => {
            const files = await Media.pickFiles('image/png,image/jpeg,image/webp,image/gif,image/heic,image/heif');
            files.slice(0, 4 - draftPhotos.length).forEach(file => draftPhotos.push({ file, preview: URL.createObjectURL(file) }));
            paintPhotos();
        },
        'mk-photo-remove': el => {
            const [p] = draftPhotos.splice(Number(el.dataset.i), 1);
            if (p && p.preview) URL.revokeObjectURL(p.preview);
            paintPhotos();
        },
        'mk-photo-edit': async el => {
            const i = Number(el.dataset.i);
            const p = draftPhotos[i];
            if (!p || !p.file || !window.PhotoEditor) return;
            const edited = await window.PhotoEditor.open(p.file, { title: 'Edit photo' });
            if (!edited) return;
            URL.revokeObjectURL(p.preview);
            draftPhotos[i] = { file: edited, preview: URL.createObjectURL(edited) };
            paintPhotos();
        }
    });

    // Dialog forms and inputs live outside #content, so listen on the document
    document.addEventListener('submit', e => {
        const form = e.target.closest('form[data-form^="mk-"]');
        if (!form) return;
        e.preventDefault();
        if (form.dataset.form === 'mk-save') saveListing(form);
        if (form.dataset.form === 'mk-request') sendRequest(form);
        if (form.dataset.form === 'mk-send') sendDealMessage(form);
    });
    document.addEventListener('change', e => {
        if (e.target.name === 'mk-kind') paintKind();
    });

    // ---------- For other pages ----------
    window.diaryMarket = {
        openRequest: id => { if (id) openDeal(id); },
        openListing,
        // A row of books for Explore's "For you"
        exploreSection() {
            if (M.listings === null) { loadListings(); return ''; }
            const list = filtered().filter(l => l.status === 'available' && l.seller !== me()).slice(0, 10);
            if (!list.length) return '';
            return `
                <section class="ex-sec">
                    <header class="ex-head"><h3><span class="ex-ic"><svg class="i"><use href="#i-store"/></svg></span>Books from readers</h3>
                        <p>For sale, for rent and free — from people on Cordial</p>
                        <button type="button" class="link-btn accent ex-more" data-action="go-market">Marketplace</button></header>
                    <div class="ex-row mk-row">${list.map(card).join('')}</div>
                </section>`;
        }
    };
});
