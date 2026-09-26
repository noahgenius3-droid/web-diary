// Communities: public or invite-only groups where members post updates, photos and diary notes.
// Builds on social.js (auth, storage, the shared post card and comments).
document.addEventListener('DOMContentLoaded', () => {
    const app = window.diaryApp;
    const social = window.diarySocial;
    const I = social && social.internals;
    if (!I) return;
    const { client, state: s, esc, avatar, timeAgo, gate, randomId, uploadImage, hydrateStorage, renderPost, commentCount } = I;
    const $ = id => document.getElementById(id);
    const content = $('content');
    const BUCKET = 'diary-community';
    const COLORS = ['yellow', 'pink', 'blue', 'green', 'purple'];
    const EMOJIS = ['📓', '📚', '✍️', '🎨', '🎵', '🏃', '🍳', '✈️', '🌱', '💼', '🙏', '🎮', '📸', '💡', '🧘', '⚽'];
    const MAX_PHOTOS = 10;

    const c = {
        list: null,              // every community you can see (public + yours)
        loading: false,
        memberships: new Map(),  // community id -> role
        current: null,           // open community
        opening: null,
        posts: [],
        members: [],
        loadingPosts: false,
        tab: 'posts',
        draft: { text: '', photos: [] },
        posting: false
    };

    window.diaryCommunities = {
        posts: () => c.posts,
        canInteract: () => !!(c.current && c.memberships.has(c.current.id)),
        toggleLike, postMenu, onRemoteChange, reset,
        // For the note share sheet
        async myGroups() {
            if (c.list === null) await loadCommunities();
            return (c.list || []).filter(x => c.memberships.has(x.id));
        },
        postNoteTo: (cm, note) => postNoteTo(cm, note)
    };

    function reset() {
        Object.assign(c, { list: null, memberships: new Map(), current: null, posts: [], members: [], draft: { text: '', photos: [] } });
    }

    const me = () => s.profile.id;
    const roleOf = id => c.memberships.get(id);
    const isMod = id => ['owner', 'admin'].includes(roleOf(id));
    const memberCount = cm => (Array.isArray(cm.members) && cm.members[0] ? cm.members[0].count : 0);
    const inView = () => ['communities', 'community'].includes(app.state.view);

    // ---------- Data ----------
    async function loadCommunities() {
        if (c.loading) return;
        c.loading = true;
        const [all, mine] = await Promise.all([
            client.from('diary_communities')
                .select('id, name, description, emoji, color, visibility, owner, created_at, members:diary_community_members(count)')
                .order('created_at', { ascending: false })
                .limit(100),
            client.from('diary_community_members').select('community_id, role').eq('user_id', me())
        ]);
        c.loading = false;
        c.list = all.data || [];
        c.memberships = new Map((mine.data || []).map(m => [m.community_id, m.role]));
        if (inView()) app.render();
    }

    async function openCommunity(id) {
        if (c.opening === id) return;
        c.opening = id;
        if (c.list === null) await loadCommunities();
        const { data: cm } = await client.from('diary_communities')
            .select('*, members:diary_community_members(count)')
            .eq('id', id)
            .maybeSingle();
        c.opening = null;
        if (!cm) {
            app.showToast('That community isn’t available');
            app.setView('communities');
            return;
        }
        Object.assign(c, { current: cm, tab: 'posts', posts: [], members: [], draft: { text: '', photos: [] } });
        loadPosts();
        loadMembers();
        app.render();
    }

    async function loadPosts() {
        if (!c.current) return;
        const id = c.current.id;
        c.loadingPosts = true;
        const { data } = await client.from('diary_community_posts')
            .select(`id, community_id, author, kind, title, body, html, photos, created_at,
                author_profile:diary_profiles!diary_community_posts_author_fkey(username, display_name, avatar_path),
                likes:diary_community_likes(user_id),
                comments:diary_comments(count)`)
            .eq('community_id', id)
            .order('created_at', { ascending: false })
            .limit(60);
        if (!c.current || c.current.id !== id) return;
        c.loadingPosts = false;
        c.posts = data || [];
        if (app.state.view === 'community') app.render();
    }

    async function loadMembers() {
        if (!c.current) return;
        const id = c.current.id;
        const { data } = await client.from('diary_community_members')
            .select('role, joined_at, user_id, profile:diary_profiles!diary_community_members_user_id_fkey(id, username, display_name, avatar_path)')
            .eq('community_id', id)
            .order('joined_at');
        if (!c.current || c.current.id !== id) return;
        c.members = data || [];
        if (app.state.view === 'community' && c.tab !== 'posts') app.render();
    }

    function onRemoteChange(payload) {
        const row = payload.new && payload.new.id ? payload.new : payload.old;
        if (!c.current || !row) return;
        if (payload.eventType === 'DELETE') {
            const before = c.posts.length;
            c.posts = c.posts.filter(p => p.id !== row.id);
            if (c.posts.length !== before && app.state.view === 'community') app.render();
            return;
        }
        if (row.community_id === c.current.id && row.author !== me() && !c.posts.some(p => p.id === row.id)) loadPosts();
    }

    // ---------- Views ----------
    app.views.communities = () => {
        app.setTitle('Communities');
        const blocked = gate('Create or join communities to share notes and updates with people who care about the same things.');
        if (blocked) return blocked;
        if (c.list === null) {
            loadCommunities();
            return '<p class="muted">Loading communities…</p>';
        }
        const mine = c.list.filter(x => c.memberships.has(x.id));
        const discover = c.list.filter(x => !c.memberships.has(x.id) && x.visibility === 'public');

        return `
            <header class="notes-head">
                <div>
                    <h2 class="notes-title">Communities</h2>
                    <p class="muted">Share notes, photos and updates with the groups that matter to you.</p>
                </div>
                <div class="head-actions">
                    <button class="chip" data-action="cm-join-code"><svg class="i"><use href="#i-link"/></svg>Join with code</button>
                    <button class="create-post" data-action="cm-create"><svg class="i"><use href="#i-plus"/></svg><span>Create community</span></button>
                </div>
            </header>
            <section class="section">
                <h2>Your communities</h2>
                <div class="cm-grid">
                    ${mine.map(card).join('')}
                    <button class="cm-card cm-new" data-action="cm-create">
                        <span class="cm-new-icon"><svg class="i"><use href="#i-plus"/></svg></span>
                        <strong>Start a community</strong><small>Book club, study group, family…</small>
                    </button>
                </div>
            </section>
            <section class="section">
                <h2>Discover</h2>
                ${discover.length
                    ? `<div class="cm-grid">${discover.map(card).join('')}</div>`
                    : '<p class="muted small" style="margin-top:12px">No other public communities yet — start the first one!</p>'}
            </section>`;
    };

    function card(cm) {
        const role = roleOf(cm.id);
        return `
            <article class="cm-card" data-action="cm-open" data-id="${esc(cm.id)}" tabindex="0" role="button" aria-label="Open ${esc(cm.name)}">
                <div class="cm-cover tinted c-${esc(cm.color)}"><span class="cm-emoji">${esc(cm.emoji)}</span></div>
                <div class="cm-info">
                    <h3>${esc(cm.name)}</h3>
                    <p class="cm-meta">${cm.visibility === 'private' ? '🔒 Invite-only' : '🌐 Public'} · ${memberCount(cm)} ${memberCount(cm) === 1 ? 'member' : 'members'}</p>
                    ${cm.description ? `<p class="cm-desc">${esc(cm.description)}</p>` : ''}
                </div>
                <div class="cm-card-foot">
                    ${role
                        ? `<span class="cm-role">${role === 'owner' ? 'Owner' : role === 'admin' ? 'Admin' : 'Member'}</span>`
                        : `<button class="chip accent" data-action="cm-join" data-id="${esc(cm.id)}">Join</button>`}
                </div>
            </article>`;
    }

    app.views.community = () => {
        const blocked = gate('Sign in to see this community.');
        if (blocked) return blocked;
        const id = app.state.communityId;
        if (!c.current || c.current.id !== id) {
            openCommunity(id);
            return '<p class="muted">Loading community…</p>';
        }
        const cm = c.current;
        const role = roleOf(cm.id);
        app.setTitle(cm.name);
        const tab = (key, label) => `<button class="tab" role="tab" aria-selected="${c.tab === key}" data-action="cm-tab" data-tab="${key}">${label}</button>`;

        return `
            <button class="back-link" data-action="cm-back"><svg class="i"><use href="#i-back"/></svg>All communities</button>
            <header class="cm-hero tinted c-${esc(cm.color)}">
                <span class="cm-hero-emoji">${esc(cm.emoji)}</span>
                <div class="cm-hero-text">
                    <h2>${esc(cm.name)}</h2>
                    ${cm.description ? `<p>${esc(cm.description)}</p>` : ''}
                    <p class="cm-meta">${cm.visibility === 'private' ? '🔒 Invite-only' : '🌐 Public'} · ${memberCount(cm)} ${memberCount(cm) === 1 ? 'member' : 'members'}${role ? ` · You’re ${role === 'member' ? 'a member' : `the ${role}`}` : ''}</p>
                </div>
                <div class="cm-hero-actions">
                    ${role
                        ? `<span class="cm-call-slot" id="cm-call-slot">${callButton(lastCallPeople)}</span>
                           <button class="chip" data-action="cm-invite"><svg class="i"><use href="#i-user-plus"/></svg>Invite</button>
                           <button class="icon-btn" data-action="cm-settings" aria-label="Community options"><svg class="i"><use href="#i-more"/></svg></button>`
                        : `<button class="primary-btn" data-action="cm-join" data-id="${esc(cm.id)}">Join community</button>`}
                </div>
            </header>
            <div class="tabs" role="tablist">${tab('posts', 'Posts')}${tab('members', `Members · ${memberCount(cm)}`)}${tab('about', 'About')}</div>
            ${c.tab === 'members' ? membersTab(cm) : c.tab === 'about' ? aboutTab(cm) : postsTab(cm)}`;
    };

    function postsTab(cm) {
        const member = !!roleOf(cm.id);
        const first = s.profile.display_name.split(' ')[0];
        const composer = member ? `
            <form class="post-composer" data-form="cm-post">
                <div class="pc-row">
                    ${avatar(s.profile, 'md')}
                    <textarea id="cm-text" rows="2" maxlength="5000" placeholder="Share an update with ${esc(cm.name)}, ${esc(first)}…" aria-label="Write a post"></textarea>
                </div>
                <div class="pc-photos" id="cm-photos" hidden></div>
                <div class="pc-foot">
                    <button type="button" class="pc-tool" data-action="cm-add-photos"><svg class="i"><use href="#i-image"/></svg>Photo</button>
                    <button type="button" class="pc-tool camera" data-action="cm-camera"><svg class="i"><use href="#i-camera"/></svg>Camera</button>
                    <button type="button" class="pc-tool note" data-action="cm-share-note"><svg class="i"><use href="#i-notes"/></svg>Share a note</button>
                    <button type="submit" class="pc-post" id="cm-post-btn"${c.posting ? ' disabled' : ''}>${c.posting ? 'Posting…' : 'Post'}</button>
                </div>
            </form>` : `
            <div class="cm-join-banner">
                <p><strong>Join ${esc(cm.name)}</strong> to post, like and comment.</p>
                <button class="primary-btn" data-action="cm-join" data-id="${esc(cm.id)}">Join</button>
            </div>`;

        const posts = c.loadingPosts && !c.posts.length
            ? '<p class="muted">Loading posts…</p>'
            : c.posts.map(p => postHTML(p, member)).join('') || `<div class="empty"><p class="empty-title">No posts yet</p><p>${member ? 'Be the first to share something.' : 'Nothing has been shared here yet.'}</p></div>`;

        return `<div class="cm-posts">${composer}<div class="feed-list">${posts}</div></div>`;
    }

    function postHTML(p, member) {
        return renderPost({
            kind: 'post',
            id: p.id,
            author: p.author,
            profile: p.author_profile,
            createdAt: p.created_at,
            title: p.title,
            body: p.body,
            html: p.html,
            photos: p.photos,
            bucket: BUCKET,
            likes: p.likes || [],
            commentCount: commentCount(p),
            canComment: member,
            mine: p.author === me(),
            badge: p.kind === 'note' ? '📓 shared a note' : ''
        });
    }

    function membersTab(cm) {
        if (!c.members.length) return '<p class="muted">Loading members…</p>';
        const canManage = isMod(cm.id);
        return `<div class="cm-members">${c.members.map(m => {
            const p = m.profile || { id: m.user_id, display_name: 'Member', username: '' };
            const removable = canManage && m.role !== 'owner' && m.user_id !== me();
            return `
                <div class="contact-row">
                    ${avatar(p, 'md')}
                    <span class="contact-name"><strong>${m.user_id === me() ? 'You' : esc(p.display_name)}</strong><small>@${esc(p.username)} · joined ${timeAgo(m.joined_at)}</small></span>
                    ${m.role !== 'member' ? `<span class="cm-role">${m.role === 'owner' ? 'Owner' : 'Admin'}</span>` : ''}
                    ${m.user_id !== me() && roleOf(cm.id) && window.diaryCalls ? `<button class="icon-btn ghost accent" data-action="cm-call-member" data-id="${esc(m.user_id)}" aria-label="Call ${esc(p.display_name)}"><svg class="i"><use href="#i-phone"/></svg></button>` : ''}
                    ${removable ? `<button class="icon-btn ghost" data-action="cm-remove-member" data-id="${esc(m.user_id)}" aria-label="Remove ${esc(p.display_name)}"><svg class="i"><use href="#i-close"/></svg></button>` : ''}
                </div>`;
        }).join('')}</div>`;
    }

    function aboutTab(cm) {
        const role = roleOf(cm.id);
        const owner = c.members.find(m => m.role === 'owner');
        return `
            <div class="cm-about">
                <div class="info-row"><span class="info-ic purple"><svg class="i"><use href="#i-info"/></svg></span><span>About</span><b>${cm.description ? esc(cm.description) : 'No description yet'}</b></div>
                <div class="info-row"><span class="info-ic blue"><svg class="i"><use href="#i-lock"/></svg></span><span>Visibility</span><b>${cm.visibility === 'private' ? 'Invite-only' : 'Public — anyone can join'}</b></div>
                <div class="info-row"><span class="info-ic green"><svg class="i"><use href="#i-user"/></svg></span><span>Owner</span><b>${owner && owner.profile ? esc(owner.profile.display_name) : '—'}</b></div>
                <div class="info-row"><span class="info-ic pink"><svg class="i"><use href="#i-calendar"/></svg></span><span>Created</span><b>${new Date(cm.created_at).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' })}</b></div>
                ${role ? `<div class="info-row"><span class="info-ic yellow"><svg class="i"><use href="#i-link"/></svg></span><span>Invite code</span><b class="invite-code">${esc(cm.invite_code)}</b>
                    <button class="chip" data-action="cm-copy-code">Copy</button></div>` : ''}
            </div>`;
    }

    // ---------- Calls ----------
    let lastCallPeople = [];
    let watching = null; // { topic, stop }

    function callButton(people) {
        if (!window.diaryCalls || !c.current) return '';
        const topic = window.diaryCalls.topicFor(c.current);
        if (window.diaryCalls.activeTopic() === topic) {
            return '<button class="call-join live" data-action="cm-call"><svg class="i"><use href="#i-phone"/></svg>You’re in the call</button>';
        }
        if (people.length) {
            return `<button class="call-join live" data-action="cm-call">
                <span class="avatar-stack">${people.slice(0, 3).map(p => avatar({ id: p.id, display_name: p.name, avatar_path: p.avatar_path }, 'xs')).join('')}</span>
                Join call · ${people.length}</button>`;
        }
        return '<button class="chip call-chip" data-action="cm-call"><svg class="i"><use href="#i-phone"/></svg>Voice call</button>';
    }

    // Watch the community's call room while its page is open, so "Join call · 3" stays live
    function syncCallWatch() {
        const want = app.state.view === 'community' && c.current && roleOf(c.current.id) && window.diaryCalls
            ? window.diaryCalls.topicFor(c.current) : null;
        if (watching && watching.topic !== want) {
            watching.stop();
            watching = null;
            lastCallPeople = [];
        }
        if (want && !watching) {
            watching = {
                topic: want,
                stop: window.diaryCalls.watch(want, people => {
                    lastCallPeople = people;
                    const slot = $('cm-call-slot');
                    if (slot) slot.innerHTML = callButton(people);
                })
            };
        }
    }

    // Keep the composer's text and photos across re-renders, and load private photos
    const previousAfter = app.hooks.afterRender;
    app.hooks.afterRender = view => {
        if (previousAfter) previousAfter(view);
        syncCallWatch();
        if (view !== 'community') return;
        hydrateStorage(content);
        const text = $('cm-text');
        if (text) {
            text.value = c.draft.text;
            renderDraftPhotos();
        }
    };

    // ---------- Composer ----------
    async function addDraftPhotos(files) {
        for (const original of files) {
            if (c.draft.photos.length >= MAX_PHOTOS) {
                app.showToast(`Up to ${MAX_PHOTOS} photos per post`);
                break;
            }
            const file = await Media.compressImage(original);
            if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(file.type)) {
                app.showToast(`${original.name || 'That photo'} isn’t a supported format`);
                continue;
            }
            c.draft.photos.push({ id: randomId(), file, preview: URL.createObjectURL(file) });
        }
        renderDraftPhotos();
    }

    function renderDraftPhotos() {
        const box = $('cm-photos');
        if (!box) return;
        box.hidden = !c.draft.photos.length;
        box.innerHTML = c.draft.photos.map(p => `
            <figure class="pc-thumb">
                <img src="${p.preview}" alt="">
                <button type="button" class="att-remove" data-action="cm-remove-photo" data-id="${p.id}" aria-label="Remove photo"><svg class="i"><use href="#i-close"/></svg></button>
            </figure>`).join('');
    }

    async function uploadAll(sources, cid) {
        const paths = [];
        for (const src of sources) {
            const path = await uploadImage(BUCKET, `${cid}/${me()}/${randomId()}`, src);
            if (path) paths.push({ path });
        }
        return paths;
    }

    // Post into a community (the open one by default). Returns the new post, or null.
    async function publish(fields, sources, cm = c.current) {
        const onPage = c.current && c.current.id === cm.id;
        if (onPage) {
            c.posting = true;
            app.render();
        }
        try {
            const photos = await uploadAll(sources, cm.id);
            if (sources.length && photos.length < sources.length) {
                app.showToast(`${sources.length - photos.length} photo(s) couldn’t upload`);
            }
            if (!fields.body && !fields.title && !photos.length) throw new Error('Nothing to post');
            const { data, error } = await client.from('diary_community_posts')
                .insert({ community_id: cm.id, photos, ...fields })
                .select(`id, community_id, author, kind, title, body, html, photos, created_at,
                    author_profile:diary_profiles!diary_community_posts_author_fkey(username, display_name, avatar_path),
                    likes:diary_community_likes(user_id),
                    comments:diary_comments(count)`)
                .single();
            if (error) throw error;
            if (c.current && c.current.id === cm.id) c.posts.unshift(data);
            return data;
        } catch (err) {
            app.showToast(err.message === 'Nothing to post' ? 'Write something or add a photo first' : 'Couldn’t post — please try again');
            return null;
        } finally {
            if (onPage) {
                c.posting = false;
                if (app.state.view === 'community') app.render();
            }
        }
    }

    async function postUpdate() {
        if (c.posting) return;
        const body = c.draft.text.trim();
        const photos = c.draft.photos;
        if (!body && !photos.length) return app.showToast('Write something or add a photo first');
        const ok = await publish({ kind: 'update', body }, photos.map(p => p.file));
        if (ok) {
            photos.forEach(p => URL.revokeObjectURL(p.preview));
            c.draft = { text: '', photos: [] };
            app.render();
            app.showToast(`Posted to ${c.current.name}`);
        }
    }

    function pickNoteToShare(anchor) {
        const notes = app.getNotes().filter(n => !n.trashedAt && !n.private).slice(0, 8);
        if (!notes.length) return app.showToast('Write a note first — private notes can’t be shared');
        app.openPopover(anchor, notes.map(n => ({
            label: (n.title || n.text.split('\n')[0] || 'Untitled').slice(0, 48),
            icon: n.attachments.some(a => a.kind === 'image' || a.kind === 'drawing') ? 'i-image' : 'i-notes',
            onClick: () => shareNote(n)
        })));
    }

    async function shareNote(n) {
        const ok = await app.ask({ title: `Share this note with ${c.current.name}?`, text: `“${n.title || n.text.slice(0, 60) || 'Untitled'}” will be visible to ${c.current.visibility === 'public' ? 'anyone who opens this community' : 'its members'}.`, ok: 'Share' });
        if (!ok) return;
        if (await postNoteTo(c.current, n)) app.showToast('Note shared 📓');
    }

    // Post a diary note (text, formatting and photos) to any community you belong to
    async function postNoteTo(cm, n) {
        const images = [];
        for (const a of n.attachments
            .filter(x => x.kind === 'image' || x.kind === 'drawing')
            .sort((x, y) => (y.id === n.cover) - (x.id === n.cover))
            .slice(0, MAX_PHOTOS)) {
            const blob = await Media.get(a.id);
            if (blob) images.push(new File([blob], a.name || 'photo', { type: a.type || blob.type }));
        }
        const html = Rich.sanitize(n.html || '');
        const posted = await publish({
            kind: 'note',
            title: (n.title || '').slice(0, 200),
            body: n.text.slice(0, 20000),
            html: html.length <= 60000 ? html : ''
        }, images, cm);
        if (posted) {
            // Remember where it went so the share sheet can show "✓ Shared"
            const groups = [...new Set([...(n.sharedGroups || []), cm.id])];
            app.updateNote(n.id, { sharedGroups: groups });
        }
        return !!posted;
    }

    // ---------- Likes & post menu ----------
    async function toggleLike(postId) {
        const post = c.posts.find(p => p.id === postId);
        if (!post) return;
        if (!roleOf(post.community_id)) return app.showToast('Join the community to like posts');
        const liked = post.likes.some(l => l.user_id === me());
        post.likes = liked ? post.likes.filter(l => l.user_id !== me()) : [...post.likes, { user_id: me() }];
        app.render();
        const { error } = liked
            ? await client.from('diary_community_likes').delete().eq('post_id', postId).eq('user_id', me())
            : await client.from('diary_community_likes').insert({ post_id: postId });
        if (error) {
            post.likes = liked ? [...post.likes, { user_id: me() }] : post.likes.filter(l => l.user_id !== me());
            app.render();
            app.showToast('Couldn’t update like');
        }
    }

    function postMenu(el) {
        const post = c.posts.find(p => p.id === el.dataset.id);
        if (!post) return;
        const canDelete = post.author === me() || isMod(post.community_id);
        const isFriend = s.friends.some(f => f.id === post.author);
        const items = [];
        if (isFriend && post.author !== me()) {
            items.push({ label: 'Message', icon: 'i-chat', onClick: () => { app.setView('messages'); content.querySelector(`.convo[data-id="${CSS.escape(post.author)}"]`)?.click(); } });
        }
        if (canDelete) {
            items.push({ label: 'Delete post', icon: 'i-trash', danger: true, onClick: () => deletePost(post) });
        }
        if (!items.length) items.push({ label: 'Copy text', icon: 'i-notes', onClick: () => navigator.clipboard?.writeText(post.body || post.title || '') });
        app.openPopover(el, items);
    }

    async function deletePost(post) {
        const ok = await app.ask({ title: 'Delete this post?', text: 'It will be removed for everyone in the community.', ok: 'Delete', danger: true });
        if (!ok) return;
        const { error } = await client.from('diary_community_posts').delete().eq('id', post.id);
        if (error) return app.showToast('Couldn’t delete that post');
        if (post.author === me() && post.photos?.length) {
            client.storage.from(BUCKET).remove(post.photos.map(p => p.path));
        }
        c.posts = c.posts.filter(p => p.id !== post.id);
        app.render();
        app.showToast('Post deleted');
    }

    // ---------- Create / edit / join / leave ----------
    const dialog = $('cm-dialog');
    let editing = null; // community being edited, or null when creating

    $('cm-emojis').innerHTML = EMOJIS.map(e => `<button type="button" class="cm-emoji-opt" data-emoji="${e}" role="radio" aria-label="${e}">${e}</button>`).join('');
    $('cm-colors').innerHTML = COLORS.map(col => `<button type="button" class="swatch c-${col}" data-color="${col}" role="radio" aria-label="${col}"></button>`).join('');
    const choice = { emoji: EMOJIS[0], color: 'purple' };

    function paintChoice() {
        $('cm-emojis').querySelectorAll('[data-emoji]').forEach(b => b.setAttribute('aria-checked', String(b.dataset.emoji === choice.emoji)));
        $('cm-colors').querySelectorAll('[data-color]').forEach(b => b.setAttribute('aria-checked', String(b.dataset.color === choice.color)));
    }

    $('cm-emojis').addEventListener('click', e => {
        const b = e.target.closest('[data-emoji]');
        if (b) { choice.emoji = b.dataset.emoji; paintChoice(); }
    });
    $('cm-colors').addEventListener('click', e => {
        const b = e.target.closest('[data-color]');
        if (b) { choice.color = b.dataset.color; paintChoice(); }
    });

    function openDialog(cm = null) {
        editing = cm;
        $('cm-dialog-title').textContent = cm ? 'Edit community' : 'Create a community';
        $('cm-save').textContent = cm ? 'Save' : 'Create';
        $('cm-name').value = cm ? cm.name : '';
        $('cm-desc').value = cm ? cm.description : '';
        choice.emoji = cm ? cm.emoji : EMOJIS[Math.floor(Math.random() * EMOJIS.length)];
        choice.color = cm ? cm.color : COLORS[Math.floor(Math.random() * COLORS.length)];
        dialog.querySelectorAll('input[name="cm-vis"]').forEach(r => { r.checked = r.value === (cm ? cm.visibility : 'public'); });
        paintChoice();
        dialog.showModal();
        $('cm-name').focus();
    }

    $('cm-cancel').addEventListener('click', () => dialog.close());
    $('cm-form').addEventListener('submit', async e => {
        e.preventDefault();
        const name = $('cm-name').value.trim();
        if (name.length < 2) {
            $('cm-name').focus();
            return app.showToast('Give your community a name');
        }
        const fields = {
            name: name.slice(0, 60),
            description: $('cm-desc').value.trim().slice(0, 400),
            emoji: choice.emoji,
            color: choice.color,
            visibility: dialog.querySelector('input[name="cm-vis"]:checked').value
        };
        $('cm-save').disabled = true;
        try {
            if (editing) {
                const { data, error } = await client.from('diary_communities').update(fields).eq('id', editing.id)
                    .select('*, members:diary_community_members(count)').single();
                if (error) throw error;
                c.current = data;
                c.list = null;
                dialog.close();
                app.render();
                app.showToast('Community updated');
            } else {
                const { data, error } = await client.rpc('diary_create_community', {
                    p_name: fields.name, p_description: fields.description, p_emoji: fields.emoji,
                    p_color: fields.color, p_visibility: fields.visibility
                });
                if (error) throw error;
                c.memberships.set(data.id, 'owner');
                c.list = null;
                dialog.close();
                app.showToast(`${data.name} is ready — invite some people!`);
                app.setView('community', { communityId: data.id });
            }
        } catch (err) {
            app.showToast(err.message || 'Couldn’t save the community');
        } finally {
            $('cm-save').disabled = false;
        }
    });

    async function join(id, code = null) {
        const { data, error } = await client.rpc('diary_join_community', { p_id: id, p_code: code });
        if (error) return app.showToast(error.message);
        c.memberships.set(data.id, 'member');
        c.list = null;
        app.showToast(`Welcome to ${data.name} 🎉`);
        if (c.current && c.current.id === data.id) {
            c.current = null;
            app.render();
        } else {
            app.setView('community', { communityId: data.id });
        }
    }

    async function leave(cm) {
        const owner = roleOf(cm.id) === 'owner';
        const ok = await app.ask({
            title: `Leave ${cm.name}?`,
            text: owner ? 'You own this community. Ownership passes to the longest-standing member — if you’re the only one, the community is deleted.' : 'You can rejoin later.',
            ok: 'Leave', danger: true
        });
        if (!ok) return;
        const { error } = await client.rpc('diary_leave_community', { p_id: cm.id });
        if (error) return app.showToast('Couldn’t leave the community');
        c.memberships.delete(cm.id);
        c.list = null;
        c.current = null;
        app.setView('communities');
        app.showToast(`You left ${cm.name}`);
    }

    async function destroy(cm) {
        const ok = await app.ask({ title: `Delete ${cm.name}?`, text: 'All posts, comments and photos in it are removed for everyone. This can’t be undone.', ok: 'Delete community', danger: true });
        if (!ok) return;
        const { error } = await client.from('diary_communities').delete().eq('id', cm.id);
        if (error) return app.showToast('Couldn’t delete the community');
        c.memberships.delete(cm.id);
        c.list = null;
        c.current = null;
        app.setView('communities');
        app.showToast('Community deleted');
    }

    async function copyCode(code) {
        try {
            await navigator.clipboard.writeText(code);
            app.showToast('Invite code copied');
        } catch (e) {
            app.showToast(`Invite code: ${code}`);
        }
    }

    // ---------- Actions ----------
    Object.assign(app.actions, {
        'cm-open': el => app.setView('community', { communityId: el.dataset.id }),
        'cm-back': () => app.setView('communities'),
        'cm-create': () => openDialog(),
        'cm-tab': el => {
            c.tab = el.dataset.tab;
            if (c.tab !== 'posts' && !c.members.length) loadMembers();
            app.render();
        },
        'cm-join': (el, e) => {
            e.stopPropagation();
            join(el.dataset.id);
        },
        'cm-join-code': async () => {
            const r = await app.ask({ title: 'Join with an invite code', text: 'Ask a member of the community for its 8-character code.', value: '', placeholder: 'e.g. 4f9a2c1b', ok: 'Join' });
            if (r) join(null, r.value);
        },
        'cm-invite': async () => {
            const cm = c.current;
            const ok = await app.ask({
                title: `Invite people to ${cm.name}`,
                text: cm.visibility === 'public'
                    ? `Anyone can find ${cm.name} under Discover, or join straight away with the code ${cm.invite_code}.`
                    : `Share this code — anyone with it can join: ${cm.invite_code}`,
                ok: 'Copy code'
            });
            if (ok) copyCode(cm.invite_code);
        },
        'cm-copy-code': () => copyCode(c.current.invite_code),
        'cm-settings': el => {
            const cm = c.current;
            const role = roleOf(cm.id);
            const items = [];
            if (isMod(cm.id)) items.push({ label: 'Edit community', icon: 'i-pencil', onClick: () => openDialog(cm) });
            items.push({ label: 'Copy invite code', icon: 'i-link', onClick: () => copyCode(cm.invite_code) });
            items.push({ label: 'Leave community', icon: 'i-logout', danger: true, onClick: () => leave(cm) });
            if (role === 'owner') items.push({ label: 'Delete community', icon: 'i-trash', danger: true, onClick: () => destroy(cm) });
            app.openPopover(el, items);
        },
        'cm-remove-member': async el => {
            const m = c.members.find(x => x.user_id === el.dataset.id);
            const ok = await app.ask({ title: `Remove ${m && m.profile ? m.profile.display_name : 'this member'}?`, text: 'They can rejoin a public community, or with the invite code.', ok: 'Remove', danger: true });
            if (!ok) return;
            const { error } = await client.from('diary_community_members').delete().eq('community_id', c.current.id).eq('user_id', el.dataset.id);
            if (error) return app.showToast('Couldn’t remove that member');
            c.members = c.members.filter(x => x.user_id !== el.dataset.id);
            c.current.members = [{ count: Math.max(0, memberCount(c.current) - 1) }];
            app.render();
        },
        'cm-add-photos': async () => addDraftPhotos(await Media.pickFiles('image/*')),
        'cm-camera': async () => addDraftPhotos(await Media.pickFiles('image/*', false, 'environment')),
        'cm-remove-photo': el => {
            const photo = c.draft.photos.find(p => p.id === el.dataset.id);
            if (photo) URL.revokeObjectURL(photo.preview);
            c.draft.photos = c.draft.photos.filter(p => p.id !== el.dataset.id);
            renderDraftPhotos();
        },
        'cm-share-note': el => pickNoteToShare(el),
        'cm-call': () => {
            if (!window.diaryCalls) return app.showToast('Calls aren’t supported in this browser');
            window.diaryCalls.joinCommunity(c.current);
        },
        'cm-call-member': el => {
            const m = c.members.find(x => x.user_id === el.dataset.id);
            if (m && window.diaryCalls) window.diaryCalls.callUser(m.profile || { id: m.user_id, display_name: 'Member' });
        }
    });

    content.addEventListener('submit', e => {
        const form = e.target.closest('form[data-form="cm-post"]');
        if (!form) return;
        e.preventDefault();
        postUpdate();
    });

    content.addEventListener('input', e => {
        if (e.target.id !== 'cm-text') return;
        c.draft.text = e.target.value;
        e.target.style.height = 'auto';
        e.target.style.height = Math.min(e.target.scrollHeight, 240) + 'px';
    });
});
