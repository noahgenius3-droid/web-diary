// Rich text: formatting toolbar for contenteditable fields, HTML sanitising and text conversion.
// Shared by the journal editor and the chat composer.
window.Rich = (() => {
    const ALLOWED_TAGS = ['b', 'strong', 'i', 'em', 'u', 's', 'strike', 'del', 'code', 'pre', 'blockquote',
        'a', 'br', 'p', 'div', 'ul', 'ol', 'li'];
    const BLOCKS = new Set(['P', 'DIV', 'LI', 'PRE', 'BLOCKQUOTE', 'UL', 'OL']);
    let hooked = false;

    function escapeHTML(str) {
        return String(str).replace(/[&<>'"]/g, c =>
            ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));
    }

    // Everything user-written passes through here before it reaches innerHTML
    function sanitize(html) {
        if (!html) return '';
        if (!window.DOMPurify) return escapeHTML(toText(html)).replace(/\n/g, '<br>');
        if (!hooked) {
            window.DOMPurify.addHook('afterSanitizeAttributes', node => {
                if (node.tagName !== 'A') return;
                const href = node.getAttribute('href') || '';
                if (!/^(https?:|mailto:)/i.test(href)) node.removeAttribute('href');
                node.setAttribute('target', '_blank');
                node.setAttribute('rel', 'noopener noreferrer nofollow');
            });
            hooked = true;
        }
        return window.DOMPurify.sanitize(html, {
            ALLOWED_TAGS,
            ALLOWED_ATTR: ['href', 'target', 'rel'],
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
        return `<button type="button" class="tb-btn" data-cmd="${def.cmd}" title="${def.label}" aria-label="${def.label}"${def.state ? ' aria-pressed="false"' : ''}>${inner}</button>`;
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
        const defs = [...FORMAT_BUTTONS, ...(extra.length ? [{ sep: true }, ...extra] : []),
            ...(opts.history === false ? [] : HISTORY_BUTTONS)];
        toolbar.innerHTML = defs.map(button).join('');
        const changed = () => opts.onChange && opts.onChange();

        // Keep focus (and the selection) in the editor while clicking toolbar buttons
        toolbar.addEventListener('mousedown', e => {
            if (e.target.closest('.tb-btn')) e.preventDefault();
        });

        toolbar.addEventListener('click', async e => {
            const btn = e.target.closest('.tb-btn');
            if (!btn) return;
            const cmd = btn.dataset.cmd;
            const custom = extra.find(x => x.cmd === cmd);
            if (custom) return custom.run(btn);
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

        toolbar.refresh = () => {
            const active = document.activeElement === editable || editable.contains(document.activeElement);
            toolbar.querySelectorAll('[aria-pressed]').forEach(b => {
                let on = false;
                try { on = active && document.queryCommandState(b.dataset.cmd); } catch (err) {}
                b.setAttribute('aria-pressed', String(on));
            });
        };
        toolbars.add(toolbar);
        return toolbar;
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
