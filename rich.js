// Rich text: formatting toolbar for contenteditable fields, HTML sanitising and text conversion.
// Shared by the journal editor and the chat composer.
window.Rich = (() => {
    const ALLOWED_TAGS = ['b', 'strong', 'i', 'em', 'u', 's', 'strike', 'del', 'code', 'pre', 'blockquote',
        'a', 'br', 'p', 'div', 'ul', 'ol', 'li', 'mark', 'h1', 'h2', 'h3'];
    const HIGHLIGHTS = ['yellow', 'green', 'pink', 'blue', 'orange', 'purple'];
    const BLOCKS = new Set(['P', 'DIV', 'LI', 'PRE', 'BLOCKQUOTE', 'UL', 'OL', 'H1', 'H2', 'H3']);
    // Text styles for notes (like Apple Notes): each is a kind of line
    const TEXT_STYLES = [['title', 'Title', 'H1'], ['heading', 'Heading', 'H2'], ['subheading', 'Subheading', 'H3'], ['body', 'Body', ''], ['mono', 'Monostyle', 'PRE']];
    let hooked = false;

    function escapeHTML(str) {
        return String(str).replace(/[&<>'"]/g, c =>
            ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));
    }

    // Everything user-written passes through here before it reaches innerHTML.
    // allowMedia keeps in-note pictures, which only ever reference this device's photo store
    // (<img data-media="id">) — never a src, so nothing external can load.
    function sanitize(html, { allowMedia = false } = {}) {
        if (!html) return '';
        if (!window.DOMPurify) return escapeHTML(toText(html)).replace(/\n/g, '<br>');
        if (!hooked) {
            window.DOMPurify.addHook('afterSanitizeAttributes', node => {
                if (node.tagName === 'MARK') {
                    const colour = (node.getAttribute('class') || '').replace(/^hl-/, '');
                    node.setAttribute('class', `hl-${HIGHLIGHTS.includes(colour) ? colour : 'yellow'}`);
                    return;
                }
                if (node.tagName !== 'IMG' && node.hasAttribute('class')) node.removeAttribute('class');
                if (node.tagName === 'IMG') {
                    const id = node.getAttribute('data-media') || '';
                    if (!/^[a-z0-9]{4,40}$/i.test(id)) {
                        node.remove();
                        return;
                    }
                    node.setAttribute('class', 'inline-img');
                    node.setAttribute('alt', '');
                    return;
                }
                if (node.tagName !== 'A') return;
                const href = node.getAttribute('href') || '';
                if (!/^(https?:|mailto:)/i.test(href)) node.removeAttribute('href');
                node.setAttribute('target', '_blank');
                node.setAttribute('rel', 'noopener noreferrer nofollow');
            });
            hooked = true;
        }
        return window.DOMPurify.sanitize(html, {
            ALLOWED_TAGS: allowMedia ? [...ALLOWED_TAGS, 'img'] : ALLOWED_TAGS,
            ALLOWED_ATTR: allowMedia ? ['href', 'target', 'rel', 'data-media', 'class', 'alt'] : ['href', 'target', 'rel', 'class'],
            ALLOW_DATA_ATTR: false
        });
    }

    // Plain text with line breaks, for previews, search and the AI. DOMParser documents are inert.
    function toText(html) {
        if (!html) return '';
        const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
        let out = '';
        const walk = node => {
            node.childNodes.forEach(child => {
                if (child.nodeType === Node.TEXT_NODE) {
                    out += child.textContent;
                } else if (child.nodeType === Node.ELEMENT_NODE) {
                    if (child.tagName === 'BR') { out += '\n'; return; }
                    const block = BLOCKS.has(child.tagName);
                    if (block && out && !out.endsWith('\n')) out += '\n';
                    if (child.tagName === 'LI') out += '• ';
                    walk(child);
                    if (block && !out.endsWith('\n')) out += '\n';
                }
            });
        };
        walk(doc.body);
        return out.replace(/​/g, '').replace(/\n{3,}/g, '\n\n').trim();
    }

    function textToHTML(text) {
        return escapeHTML(text || '').replace(/\n/g, '<br>');
    }

    // ---------- Selection memory (so dialogs and emoji pickers can insert at the caret) ----------
    const lastRanges = new WeakMap();
    document.addEventListener('selectionchange', () => {
        const sel = document.getSelection();
        if (!sel.rangeCount) return;
        const range = sel.getRangeAt(0);
        const host = (range.commonAncestorContainer.nodeType === 1
            ? range.commonAncestorContainer
            : range.commonAncestorContainer.parentElement)?.closest('[contenteditable="true"]');
        if (host) lastRanges.set(host, range.cloneRange());
        toolbars.forEach(t => t.isConnected ? t.refresh() : toolbars.delete(t));
    });

    function restoreSelection(editable) {
        editable.focus();
        const range = lastRanges.get(editable);
        if (!range || !editable.contains(range.commonAncestorContainer)) {
            placeCaretAtEnd(editable);
            return;
        }
        const sel = document.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
    }

    function placeCaretAtEnd(editable) {
        const range = document.createRange();
        range.selectNodeContents(editable);
        range.collapse(false);
        const sel = document.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
    }

    function insertText(editable, text) {
        restoreSelection(editable);
        document.execCommand('insertText', false, text);
    }

    // ---------- Toolbar ----------
    const FORMAT_BUTTONS = [
        { cmd: 'bold', label: 'Bold (Ctrl+B)', html: '<b>B</b>', state: true },
        { cmd: 'italic', label: 'Italic (Ctrl+I)', html: '<i>I</i>', state: true },
        { cmd: 'underline', label: 'Underline (Ctrl+U)', html: '<u>U</u>', state: true },
        { cmd: 'strikeThrough', label: 'Strikethrough', html: '<s>S</s>', state: true },
        { cmd: 'highlight', label: 'Highlighter: select text to mark it, or tap for colours and the highlighter pen', html: '<svg class="i"><use href="#i-marker"/></svg><span class="hl-pen-dot" aria-hidden="true"></span>' },
        { sep: true },
        { cmd: 'code', label: 'Inline code', icon: 'i-code' },
        { cmd: 'codeblock', label: 'Code block', icon: 'i-codeblock' },
        { cmd: 'quote', label: 'Quote', icon: 'i-quote' },
        { cmd: 'link', label: 'Link (Ctrl+K)', icon: 'i-link' },
        { cmd: 'list', label: 'Bulleted list', icon: 'i-list' }
    ];
    const HISTORY_BUTTONS = [
        { sep: true },
        { cmd: 'undo', label: 'Undo (Ctrl+Z)', icon: 'i-undo' },
        { cmd: 'redo', label: 'Redo (Ctrl+Y)', icon: 'i-redo' }
    ];

    const toolbars = new Set();

    function button(def) {
        if (def.sep) return '<span class="tb-sep" aria-hidden="true"></span>';
        const inner = def.icon ? `<svg class="i"><use href="#${def.icon}"/></svg>` : def.html;
        return `<button type="button" class="tb-btn" data-cmd="${def.cmd}" title="${def.label}" aria-label="${def.label}"${def.state ? ' data-state aria-pressed="false"' : ''}>${inner}</button>`;
    }

    /**
     * Wire a toolbar element to a contenteditable.
     * opts.extra: [{ cmd, label, icon, run }] extra buttons (attachments etc.)
     * opts.askLink: async (currentUrl) => url | null
     * opts.onFiles: (File[]) => void for pasted / dropped files
     * opts.onChange: () => void after any edit
     * opts.history: include undo/redo buttons (default true)
     */
    function attach(toolbar, editable, opts = {}) {
        const extra = opts.extra || [];
        const defs = [...(opts.styles ? [{ cmd: 'pstyle', label: 'Text style — title, heading, subheading, body or monostyle', html: '<span class="tb-pstyle-name">Body</span><svg class="i" aria-hidden="true"><use href="#i-chevron-down"/></svg>' }] : []),
            ...FORMAT_BUTTONS, ...(extra.length ? [{ sep: true }, ...extra] : []),
            ...(opts.history === false ? [] : HISTORY_BUTTONS)];
        toolbar.innerHTML = (opts.styles ? `<div class="tb-styles" role="radiogroup" aria-label="Text style">${TEXT_STYLES.map(([k, name]) =>
            `<button type="button" role="radio" aria-checked="false" class="tb-style s-${k}" data-pstyle="${k}">${name}</button>`).join('')}</div>` : '') + defs.map(button).join('');
        const changed = () => opts.onChange && opts.onChange();

        // Keep focus (and the selection) in the editor while clicking toolbar buttons
        toolbar.addEventListener('mousedown', e => {
            if (e.target.closest('.tb-btn')) e.preventDefault();
        });

        toolbar.addEventListener('mousedown', e => { if (e.target.closest('[data-pstyle]')) e.preventDefault(); });
        toolbar.addEventListener('click', async e => {
            const st = e.target.closest('[data-pstyle]');
            if (st) { applyStyle(editable, st.dataset.pstyle); changed(); toolbar.refresh(); return; }
            const btn = e.target.closest('.tb-btn');
            if (!btn) return;
            if (btn.dataset.cmd === 'pstyle') { styleMenu(btn, editable, () => { changed(); toolbar.refresh(); }); return; }
            const cmd = btn.dataset.cmd;
            const custom = extra.find(x => x.cmd === cmd);
            if (custom) return custom.run(btn);
            if (cmd === 'highlight') {
                // With text selected: mark it now. Otherwise: colours, pen mode and remove
                const sel = document.getSelection();
                const hasText = sel.rangeCount && !sel.getRangeAt(0).collapsed && editable.contains(sel.getRangeAt(0).commonAncestorContainer);
                if (hasText) {
                    highlight(editable);
                    changed();
                } else {
                    openPalette(btn, editable, changed);
                }
                return;
            }
            await run(cmd, editable, opts);
            changed();
            toolbar.refresh();
        });

        editable.addEventListener('keydown', async e => {
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
                e.preventDefault();
                await run('link', editable, opts);
                changed();
            }
            // Enter at the end of a title or heading: the next line is body text again
            if (e.key === 'Enter' && !e.shiftKey && opts.styles) {
                const h = currentBlock(editable, ['H1', 'H2', 'H3']);
                const sel = document.getSelection();
                if (h && sel.rangeCount && sel.isCollapsed) {
                    const after = document.createRange();
                    after.selectNodeContents(h);
                    after.setStart(sel.getRangeAt(0).endContainer, sel.getRangeAt(0).endOffset);
                    if (!after.toString().length) {
                        e.preventDefault();
                        const line = document.createElement('div');
                        line.innerHTML = '<br>';
                        h.after(line);
                        const r2 = document.createRange();
                        r2.setStart(line, 0);
                        r2.collapse(true);
                        sel.removeAllRanges();
                        sel.addRange(r2);
                        changed();
                        return;
                    }
                }
            }
            // Leave a code block or quote with Enter on an empty last line
            if (e.key === 'Enter' && !e.shiftKey) {
                const block = currentBlock(editable, ['PRE', 'BLOCKQUOTE']);
                if (block && block.tagName === 'PRE' && !e.ctrlKey) {
                    e.preventDefault();
                    document.execCommand('insertText', false, '\n');
                }
            }
        });

        editable.addEventListener('paste', e => {
            const files = [...(e.clipboardData?.files || [])];
            if (files.length && opts.onFiles) {
                e.preventDefault();
                opts.onFiles(files);
                return;
            }
            const html = e.clipboardData?.getData('text/html');
            const text = e.clipboardData?.getData('text/plain') || '';
            e.preventDefault();
            if (html) document.execCommand('insertHTML', false, sanitize(html));
            else document.execCommand('insertText', false, text);
            changed();
        });

        editable.addEventListener('dragover', e => {
            if (opts.onFiles && e.dataTransfer?.types.includes('Files')) e.preventDefault();
        });
        editable.addEventListener('drop', e => {
            const files = [...(e.dataTransfer?.files || [])];
            if (files.length && opts.onFiles) {
                e.preventDefault();
                opts.onFiles(files);
            }
        });

        editable.addEventListener('input', () => {
            // A cleared editor keeps a stray <br>; drop it so the placeholder shows again
            if (editable.innerHTML === '<br>' || editable.innerHTML === '<div><br></div>') editable.innerHTML = '';
        });

        // Highlighter pen: while it's on, whatever you select gets marked (like a real highlighter)
        const penButton = toolbar.querySelector('[data-cmd="highlight"]');
        const paintPen = () => {
            if (!penButton) return;
            penButton.dataset.colour = lastColour;
            penButton.classList.toggle('pen-on', !!editable._pen);
            penButton.setAttribute('aria-pressed', String(!!editable._pen));
        };
        editable._paintPen = paintPen;
        paintPen();
        const penMark = () => {
            if (!editable._pen) return;
            const sel = document.getSelection();
            if (!sel.rangeCount || sel.getRangeAt(0).collapsed || !editable.contains(sel.getRangeAt(0).commonAncestorContainer)) return;
            highlight(editable);
            changed();
        };
        editable.addEventListener('pointerup', e => { if (e.pointerType === 'mouse') setTimeout(penMark, 0); });
        editable.addEventListener('keyup', e => { if (e.shiftKey && e.key.startsWith('Arrow')) return; if (e.key === 'Shift') penMark(); });
        // Touch: wait until the selection handles settle
        let settle = null;
        document.addEventListener('selectionchange', () => {
            if (!editable._pen) return;
            clearTimeout(settle);
            settle = setTimeout(penMark, 700);
        });

        toolbar.refresh = () => {
            const active = document.activeElement === editable || editable.contains(document.activeElement);
            if (opts.styles) {
                const now = active ? styleAt(editable) : 'body';
                const name = (TEXT_STYLES.find(x => x[0] === now) || TEXT_STYLES[3])[1];
                const label = toolbar.querySelector('.tb-pstyle-name');
                if (label) label.textContent = name;
                toolbar.querySelectorAll('[data-pstyle]').forEach(b => b.setAttribute('aria-checked', String(b.dataset.pstyle === now)));
            }
            toolbar.querySelectorAll('[data-state]').forEach(b => {
                let on = false;
                try { on = active && document.queryCommandState(b.dataset.cmd); } catch (err) {}
                b.setAttribute('aria-pressed', String(on));
            });
        };
        toolbars.add(toolbar);
        return toolbar;
    }

    // ---------- Highlighter ----------
    // Select text and tap: it's marked in the last colour used. Tap inside a highlight to cycle
    // yellow → green → pink → blue → none.
    let lastColour = (() => { try { return HIGHLIGHTS.includes(localStorage.getItem('diaryHighlighter')) ? localStorage.getItem('diaryHighlighter') : 'yellow'; } catch (e) { return 'yellow'; } })();
    const HL_NAMES = { yellow: 'Yellow', green: 'Green', pink: 'Pink', blue: 'Blue', orange: 'Orange', purple: 'Purple' };

    function setColour(c) {
        lastColour = c;
        try { localStorage.setItem('diaryHighlighter', c); } catch (e) {}
    }

    // Take the highlight off whatever is selected (or the highlight the cursor is in)
    function removeHighlight(editable) {
        const sel = document.getSelection();
        if (!sel.rangeCount) return false;
        const range = sel.getRangeAt(0);
        const marks = [...editable.querySelectorAll('mark')].filter(m => range.intersectsNode(m));
        const inside = currentBlock(editable, ['MARK']);
        if (inside && !marks.includes(inside)) marks.push(inside);
        marks.forEach(unwrap);
        return marks.length > 0;
    }

    // The small sheet under the highlighter button: colours, pen mode, remove
    function openPalette(btn, editable, changed) {
        document.querySelectorAll('.hl-palette').forEach(p => p.remove());
        const host = btn.closest('dialog') || document.body;
        const pal = document.createElement('div');
        pal.className = 'hl-palette';
        pal.setAttribute('role', 'dialog');
        pal.setAttribute('aria-label', 'Highlighter');
        const inMark = !!currentBlock(editable, ['MARK']);
        pal.innerHTML = `
            <div class="hl-swatches" role="radiogroup" aria-label="Highlighter colour">
                ${HIGHLIGHTS.map(c => `<button type="button" class="hl-swatch hl-${c}" role="radio" aria-checked="${c === lastColour}" data-colour="${c}" aria-label="${HL_NAMES[c]}"></button>`).join('')}
            </div>
            <button type="button" class="hl-opt" data-pen aria-pressed="${!!editable._pen}">
                <svg class="i"><use href="#i-marker"/></svg>
                <span><strong>Highlighter pen</strong><small>${editable._pen ? 'On — select text to mark it' : 'Turn on, then select text to mark it'}</small></span>
                <span class="hl-switch" aria-hidden="true"></span>
            </button>
            <button type="button" class="hl-opt" data-remove${inMark ? '' : ' disabled'}>
                <svg class="i"><use href="#i-eraser"/></svg>
                <span><strong>Remove highlight</strong><small>${inMark ? 'From where the cursor is' : 'Put the cursor in a highlight first'}</small></span>
            </button>`;
        host.append(pal);
        const r = btn.getBoundingClientRect();
        const w = pal.offsetWidth;
        pal.style.left = `${Math.max(8, Math.min(r.left + r.width / 2 - w / 2, window.innerWidth - w - 8))}px`;
        const below = r.bottom + 8 + pal.offsetHeight < window.innerHeight;
        pal.style.top = `${below ? r.bottom + 8 : Math.max(8, r.top - pal.offsetHeight - 8)}px`;
        pal.querySelector('[aria-checked="true"]').focus();

        const close = () => {
            pal.remove();
            document.removeEventListener('pointerdown', outside, true);
            document.removeEventListener('keydown', esc, true);
        };
        const outside = e => { if (!pal.contains(e.target) && e.target !== btn && !btn.contains(e.target)) close(); };
        const esc = e => { if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); close(); btn.focus(); } };
        setTimeout(() => {
            document.addEventListener('pointerdown', outside, true);
            document.addEventListener('keydown', esc, true);
        }, 0);
        pal.addEventListener('mousedown', e => e.preventDefault()); // keep the editor's cursor where it is
        pal.addEventListener('click', e => {
            const sw = e.target.closest('[data-colour]');
            if (sw) {
                setColour(sw.dataset.colour);
                // The cursor is inside a highlight: recolour it too
                const inside = currentBlock(editable, ['MARK']);
                if (inside) { inside.className = `hl-${lastColour}`; changed(); }
                editable._paintPen && editable._paintPen();
                close();
                editable.focus();
                return;
            }
            if (e.target.closest('[data-pen]')) {
                editable._pen = !editable._pen;
                editable._paintPen && editable._paintPen();
                close();
                editable.focus();
                return;
            }
            if (e.target.closest('[data-remove]')) {
                if (removeHighlight(editable)) changed();
                close();
                editable.focus();
            }
        });
    }

    function highlight(editable) {
        const sel = document.getSelection();
        if (!sel.rangeCount) return;
        const range = sel.getRangeAt(0);
        if (!editable.contains(range.commonAncestorContainer)) return;
        const inside = currentBlock(editable, ['MARK']);
        if (range.collapsed || (inside && inside.contains(range.endContainer) && inside.contains(range.startContainer))) {
            if (!inside) return;
            const now = (inside.className || '').replace('hl-', '');
            const next = HIGHLIGHTS[HIGHLIGHTS.indexOf(now) + 1];
            if (next) {
                inside.className = `hl-${next}`;
                setColour(next);
                if (editable._paintPen) editable._paintPen();
            } else {
                unwrap(inside);
            }
            return;
        }
        // Wrap every piece of selected text (selections can cross bold, links and paragraphs)
        const texts = [];
        const walker = document.createTreeWalker(range.commonAncestorContainer.nodeType === 1 ? range.commonAncestorContainer : range.commonAncestorContainer.parentNode, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
            const t = walker.currentNode;
            if (range.intersectsNode(t) && t.textContent.trim()) texts.push(t);
        }
        const marks = [];
        texts.forEach(t => {
            let node = t;
            if (node === range.endContainer && range.endOffset < node.length) node.splitText(range.endOffset);
            if (node === range.startContainer && range.startOffset > 0) node = node.splitText(range.startOffset);
            const existing = node.parentElement.closest('mark');
            if (existing && editable.contains(existing)) {
                existing.className = `hl-${lastColour}`;
                return;
            }
            const mark = document.createElement('mark');
            mark.className = `hl-${lastColour}`;
            node.replaceWith(mark);
            mark.append(node);
            marks.push(mark);
        });
        if (marks.length) {
            const after = document.createRange();
            after.setStartAfter(marks[marks.length - 1]);
            after.collapse(true);
            sel.removeAllRanges();
            sel.addRange(after);
        }
    }

    function unwrap(el) {
        const parent = el.parentNode;
        while (el.firstChild) parent.insertBefore(el.firstChild, el);
        el.remove();
        parent.normalize();
    }

    function currentBlock(editable, tags) {
        const sel = document.getSelection();
        if (!sel.rangeCount) return null;
        let node = sel.getRangeAt(0).startContainer;
        while (node && node !== editable) {
            if (node.nodeType === 1 && tags.includes(node.tagName)) return node;
            node = node.parentNode;
        }
        return null;
    }

    function styleAt(editable) {
        const block = currentBlock(editable, ['H1', 'H2', 'H3', 'PRE']);
        return block ? (TEXT_STYLES.find(x => x[2] === block.tagName) || TEXT_STYLES[3])[0] : 'body';
    }
    function applyStyle(editable, key) {
        const def = TEXT_STYLES.find(x => x[0] === key);
        if (!def) return;
        editable.focus();
        const now = styleAt(editable);
        const tag = key === 'body' || now === key ? 'div' : def[2].toLowerCase();
        // Lists can't hold headings: the line leaves the list first
        if (tag !== 'div' && currentBlock(editable, ['LI'])) document.execCommand('insertUnorderedList');
        document.execCommand('formatBlock', false, `<${tag}>`);
    }
    // Desktop: a small menu under the style button, each style shown in its own look
    function styleMenu(anchor, editable, done) {
        document.querySelectorAll('.tb-style-menu').forEach(m => m.remove());
        const now = styleAt(editable);
        const menu = document.createElement('div');
        menu.className = 'tb-style-menu';
        menu.setAttribute('role', 'menu');
        menu.innerHTML = TEXT_STYLES.map(([k, name]) => `<button type="button" role="menuitemradio" aria-checked="${k === now}" class="tb-style s-${k}" data-pstyle="${k}">${name}</button>`).join('');
        (anchor.closest('dialog[open]') || document.body).append(menu);
        const rect = anchor.getBoundingClientRect();
        menu.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - menu.offsetWidth - 8))}px`;
        const below = rect.bottom + 6 + menu.offsetHeight < window.innerHeight;
        menu.style.top = `${below ? rect.bottom + 6 : rect.top - menu.offsetHeight - 6}px`;
        menu.style.transformOrigin = below ? 'top left' : 'bottom left';
        const close = () => { menu.remove(); document.removeEventListener('pointerdown', outside, true); document.removeEventListener('keydown', key, true); };
        const outside = e => { if (!menu.contains(e.target) && e.target !== anchor && !anchor.contains(e.target)) close(); };
        const key = e => { if (e.key === 'Escape') { e.stopPropagation(); close(); editable.focus(); } };
        menu.addEventListener('mousedown', e => e.preventDefault());
        menu.addEventListener('click', e => {
            const b = e.target.closest('[data-pstyle]');
            if (!b) return;
            applyStyle(editable, b.dataset.pstyle);
            close();
            done();
        });
        setTimeout(() => { document.addEventListener('pointerdown', outside, true); document.addEventListener('keydown', key, true); }, 0);
        menu.querySelector('[aria-checked="true"]')?.focus({ preventScroll: true });
    }

    async function run(cmd, editable, opts) {
        editable.focus();
        switch (cmd) {
            case 'bold':
            case 'italic':
            case 'underline':
            case 'strikeThrough':
            case 'undo':
            case 'redo':
                document.execCommand(cmd);
                break;
            case 'list':
                document.execCommand('insertUnorderedList');
                break;
            case 'highlight':
                highlight(editable);
                break;
            case 'code': {
                const text = document.getSelection().toString() || 'code';
                document.execCommand('insertHTML', false, `<code>${escapeHTML(text)}</code>&#8203;`);
                break;
            }
            case 'codeblock':
                document.execCommand('formatBlock', false, currentBlock(editable, ['PRE']) ? 'div' : 'pre');
                break;
            case 'quote':
                document.execCommand('formatBlock', false, currentBlock(editable, ['BLOCKQUOTE']) ? 'div' : 'blockquote');
                break;
            case 'link': {
                const range = lastRanges.get(editable);
                const selected = document.getSelection().toString();
                const existing = currentBlock(editable, ['A']);
                const url = opts.askLink ? await opts.askLink(existing ? existing.getAttribute('href') : '') : null;
                if (url === null || url === undefined) return;
                if (range) {
                    editable.focus();
                    const sel = document.getSelection();
                    sel.removeAllRanges();
                    sel.addRange(range);
                }
                if (!url) {
                    document.execCommand('unlink');
                    return;
                }
                const href = /^(https?:|mailto:)/i.test(url) ? url : `https://${url}`;
                if (selected || existing) document.execCommand('createLink', false, href);
                else document.execCommand('insertHTML', false, `<a href="${escapeHTML(href)}">${escapeHTML(url)}</a>&nbsp;`);
                break;
            }
        }
    }

    return { sanitize, toText, textToHTML, escapeHTML, attach, insertText, restoreSelection, placeCaretAtEnd };
})();
