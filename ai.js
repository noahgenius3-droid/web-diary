// AI writing assistant (inside the editor) and the Companion chat panel.
// Both stream from the diary-ai Supabase Edge Function, which holds the Claude API key.
document.addEventListener('DOMContentLoaded', () => {
    const app = window.diaryApp;
    const social = window.diarySocial;
    const cfg = window.DIARY_CONFIG;
    const $ = id => document.getElementById(id);
    const esc = app.escapeHTML;

    async function streamAI(payload, onText, signal) {
        const token = await social.accessToken();
        if (!token) throw new Error('Please sign in again.');
        const res = await fetch(`${cfg.supabaseUrl}/functions/v1/diary-ai`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${token}`,
                apikey: cfg.supabaseKey
            },
            body: JSON.stringify(payload),
            signal
        });
        if (!res.ok) {
            let message = 'The assistant is unavailable right now.';
            try { message = (await res.json()).error || message; } catch (e) {}
            throw new Error(message);
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let text = '';
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            text += decoder.decode(value, { stream: true });
            onText(text);
        }
        return text;
    }

    // ---------- Editor assistant ----------
    const editor = $('editor');
    const edTitle = $('editor-title');
    const edText = $('editor-text');
    const panel = $('ai-panel');
    const output = $('ai-output');
    const actionsEl = $('ai-actions');
    let controller = null;

    const TASKS = {
        prompt: { label: 'Give me a writing prompt', icon: 'i-bulb', working: 'Finding a prompt…' },
        continue: { label: 'Continue writing', icon: 'i-pencil', working: 'Continuing your entry…' },
        improve: { label: 'Polish my wording', icon: 'i-sparkle', working: 'Polishing…' },
        title: { label: 'Suggest a title', icon: 'i-tag', working: 'Thinking of a title…' },
        reflect: { label: 'Reflect on this entry', icon: 'i-heart', working: 'Reflecting…' }
    };

    $('editor-ai').addEventListener('click', e => {
        if (!social.requireSignIn('Sign in to use the AI writing assistant.')) return;
        app.openPopover(e.currentTarget, Object.entries(TASKS).map(([task, t]) =>
            ({ label: t.label, icon: t.icon, onClick: () => runTask(task) })));
    });

    async function runTask(task) {
        const title = edTitle.value;
        const text = edText.value;
        if (task !== 'prompt' && !title.trim() && !text.trim()) {
            app.showToast('Write a few words first');
            return;
        }

        if (controller) controller.abort();
        const current = controller = new AbortController();
        panel.hidden = false;
        $('ai-panel-label').textContent = TASKS[task].working;
        output.textContent = '';
        output.classList.add('streaming');
        setActions([{ label: 'Stop', onClick: () => current.abort() }]);

        let result = '';
        try {
            result = await streamAI({ mode: 'assist', task, title, text }, t => { output.textContent = t; }, current.signal);
        } catch (err) {
            if (err.name !== 'AbortError') {
                output.classList.remove('streaming');
                output.textContent = err.message;
                $('ai-panel-label').textContent = 'Something went wrong';
                setActions([{ label: 'Close', onClick: hidePanel }]);
                return;
            }
            result = output.textContent;
        }
        if (controller !== current) return; // superseded by a newer request
        output.classList.remove('streaming');
        finish(task, result.trim());
    }

    function finish(task, result) {
        if (!result) return hidePanel();
        $('ai-panel-label').textContent = TASKS[task].label;

        const apply = {
            continue: ['Add to entry', () => setText(joinText(edText.value, result))],
            improve: ['Replace my entry', () => setText(result)],
            title: ['Use this title', () => {
                edTitle.value = result.replace(/^["'“]+|["'”]+$/g, '').slice(0, 120);
                edTitle.dispatchEvent(new Event('input'));
            }],
            prompt: ['Start with this', () => setText(joinText(edText.value, result))],
            reflect: null
        }[task];

        const buttons = [];
        if (apply) buttons.push({ label: apply[0], primary: true, onClick: () => { apply[1](); hidePanel(); edText.focus(); } });
        buttons.push({ label: 'Try again', onClick: () => runTask(task) });
        buttons.push({ label: apply ? 'Discard' : 'Close', onClick: hidePanel });
        setActions(buttons);
    }

    function joinText(existing, addition) {
        const base = existing.replace(/\s+$/, '');
        return base ? `${base}\n\n${addition}` : addition;
    }

    function setText(value) {
        edText.value = value;
        edText.dispatchEvent(new Event('input'));
    }

    function setActions(buttons) {
        actionsEl.innerHTML = '';
        buttons.forEach(b => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = b.primary ? 'primary-btn' : 'chip';
            btn.textContent = b.label;
            btn.addEventListener('click', b.onClick);
            actionsEl.append(btn);
        });
    }

    function hidePanel() {
        if (controller) controller.abort();
        controller = null;
        panel.hidden = true;
        output.textContent = '';
    }

    editor.addEventListener('close', hidePanel);

    // ---------- Companion chat ----------
    const companion = $('companion');
    const thread = $('companion-thread');
    const input = $('companion-input');
    const sendBtn = $('companion-send');
    const contextToggle = $('companion-context');
    const SUGGESTIONS = [
        'Help me reflect on my day',
        'Give me a journaling prompt',
        'I’m feeling stressed — can we talk it through?',
        'How can I make journaling a habit?'
    ];

    let chat = loadChat();
    let chatController = null;

    function loadChat() {
        try { return JSON.parse(sessionStorage.getItem('diaryCompanion')) || []; } catch (e) { return []; }
    }

    function saveChat() {
        try { sessionStorage.setItem('diaryCompanion', JSON.stringify(chat)); } catch (e) {}
    }

    try { contextToggle.checked = localStorage.getItem('diaryCompanionContext') === '1'; } catch (e) {}
    contextToggle.addEventListener('change', () => {
        try { localStorage.setItem('diaryCompanionContext', contextToggle.checked ? '1' : '0'); } catch (e) {}
    });

    function openCompanion() {
        companion.hidden = false;
        document.body.classList.add('companion-open');
        renderChat();
        input.focus();
    }

    function closeCompanion() {
        companion.hidden = true;
        document.body.classList.remove('companion-open');
    }

    $('companion-btn').addEventListener('click', () => (companion.hidden ? openCompanion() : closeCompanion()));
    $('companion-nav').addEventListener('click', openCompanion);
    $('companion-close').addEventListener('click', closeCompanion);
    $('companion-new').addEventListener('click', () => {
        if (chatController) chatController.abort();
        chat = [];
        saveChat();
        renderChat();
        input.focus();
    });
    companion.addEventListener('keydown', e => {
        if (e.key === 'Escape') {
            closeCompanion();
            $('companion-btn').focus();
        }
    });

    function renderChat() {
        if (!chat.length) {
            thread.innerHTML = `
                <div class="companion-intro">
                    <p class="companion-hello">Hi${app.hooks.displayName && app.hooks.displayName() ? ` ${esc(app.hooks.displayName().split(' ')[0])}` : ''} 👋</p>
                    <p>I’m here to help you reflect, find words, or just think out loud. What’s on your mind?</p>
                    <div class="suggestions">${SUGGESTIONS.map(t => `<button class="chip" data-suggest="${esc(t)}">${esc(t)}</button>`).join('')}</div>
                </div>`;
            return;
        }
        thread.innerHTML = chat.map(m => `<div class="bubble${m.role === 'user' ? ' mine' : ' ai'}"><p>${format(m.content)}</p></div>`).join('');
        thread.scrollTop = thread.scrollHeight;
    }

    thread.addEventListener('click', e => {
        const chip = e.target.closest('[data-suggest]');
        if (chip) send(chip.dataset.suggest);
    });

    // Escape first, then allow **bold** — the only markdown worth rendering in a chat bubble
    function format(text) {
        return esc(text).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    }

    function recentEntries() {
        return app.getNotes()
            .filter(n => !n.trashedAt && !n.archived)
            .slice(0, 10)
            .map(n => `${new Date(n.createdAt).toDateString()} — ${n.title || 'Untitled'}\n${n.text}`)
            .join('\n\n---\n\n')
            .slice(0, 12000);
    }

    async function send(text) {
        text = text.trim();
        if (!text || chatController) return;
        if (!social.requireSignIn('Sign in to chat with your writing companion.')) return;

        input.value = '';
        autoGrow();
        const history = chat.slice();
        chat.push({ role: 'user', content: text });
        const reply = { role: 'assistant', content: '' };
        chat.push(reply);
        renderChat();
        const bubbleEl = thread.lastElementChild;
        bubbleEl.classList.add('streaming');

        chatController = new AbortController();
        sendBtn.innerHTML = '<svg class="i"><use href="#i-close"/></svg>';
        sendBtn.setAttribute('aria-label', 'Stop');

        try {
            await streamAI({
                mode: 'chat',
                messages: [...history, { role: 'user', content: text }],
                context: contextToggle.checked ? recentEntries() : ''
            }, t => {
                reply.content = t;
                bubbleEl.firstElementChild.innerHTML = format(t);
                thread.scrollTop = thread.scrollHeight;
            }, chatController.signal);
        } catch (err) {
            if (err.name !== 'AbortError') {
                // Drop the failed exchange so the history stays valid, and give the text back
                chat = history;
                input.value = text;
                autoGrow();
                app.showToast(err.message);
            }
        } finally {
            // Stopped before any reply arrived: undo the exchange as if it was never sent
            if (chat.includes(reply) && !reply.content.trim()) {
                chat = history;
                input.value = text;
                autoGrow();
            }
            chatController = null;
            sendBtn.innerHTML = '<svg class="i"><use href="#i-send"/></svg>';
            sendBtn.setAttribute('aria-label', 'Send');
            saveChat();
            renderChat();
        }
    }

    $('companion-form').addEventListener('submit', e => {
        e.preventDefault();
        if (chatController) {
            chatController.abort();
            return;
        }
        send(input.value);
    });

    input.addEventListener('keydown', e => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            $('companion-form').requestSubmit();
        }
    });
    input.addEventListener('input', autoGrow);

    function autoGrow() {
        input.style.height = 'auto';
        input.style.height = Math.min(input.scrollHeight, 140) + 'px';
    }
});
