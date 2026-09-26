// Dilute & Pairing — runs entirely on this device, so private notes never leave it.
//
// Dilute: every note is split into sentences and each sentence gets a rank (most essential first).
// The ranks and a one-line essence are computed when the note is saved and stored with it, so moving
// the strength slider is instant and the full text is never touched.
//
// Pairing: each note also keeps its most characteristic words; the editor suggests the single other
// note that overlaps most with the one you're reading.
window.Dilute = (() => {
    const VERSION = 2;
    const STOP = new Set(`a about above after again against all also am an and any are aren't as at be because been before
        being below between both but by can can't cannot could couldn't did didn't do does doesn't doing don't down during each
        few for from further get got had hadn't has hasn't have haven't having he he'd he'll he's her here here's hers herself him
        himself his how how's i i'd i'll i'm i've if in into is isn't it it's its itself just let's like me more most mustn't my
        myself no nor not now of off on once only or other ought our ours ourselves out over own really same shan't she she'd
        she'll she's should shouldn't so some still such than that that's the their theirs them themselves then there there's
        these they they'd they'll they're they've this those through to too today under until up us very was wasn't we we'd
        we'll we're we've were weren't what what's when when's where where's which while who who's whom why why's will with
        won't would wouldn't yet you you'd you'll you're you've your yours yourself yourselves im ive dont didnt cant thats
        went go going got getting make made one two much many lot lots thing things something anything everything day time
        feel felt think thought know knew want wanted need maybe also even back way well good great little bit`.split(/\s+/));
    // Words that usually mark a decision, a lesson or an action — the parts worth keeping
    const CUES = /\b(decided|decide|decision|important|remember|learned|learnt|lesson|realised|realized|must|need to|going to|plan|goal|deadline|action|agreed|next step|finally|because|so that|promise|never|always|key|main|priority|todo|to-do)\b/i;

    function hash(str) {
        let h = 5381;
        for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
        return (h >>> 0).toString(36);
    }

    // The text a note is diluted from: body, reflection sections and goals
    function source(n) {
        const parts = [n.text || ''];
        Object.values(n.sections || {}).forEach(v => { if (v && v.trim()) parts.push(v.trim()); });
        (n.goals || []).forEach(g => { if (g.text && g.text.trim()) parts.push(`${g.done ? '✓' : '○'} ${g.text.trim()}`); });
        return parts.join('\n').replace(/\r/g, '');
    }

    function stem(w) {
        if (w.length > 5 && w.endsWith('ing')) return w.slice(0, -3);
        if (w.length > 4 && w.endsWith('ed')) return w.slice(0, -2);
        if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
        return w;
    }

    function words(text) {
        return (text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) || []).map(w => w.replace(/’/g, "'"));
    }

    function contentWords(text) {
        return words(text).filter(w => w.length > 2 && !STOP.has(w) && !/^\d+$/.test(w)).map(stem);
    }

    // Sentences as [start, end) offsets into the source; list items and short lines count as sentences
    function split(src) {
        const units = [];
        const re = /[^\n.!?…]+(?:[.!?…]+["”’')\]]*)?/g;
        let lineStart = 0;
        src.split('\n').forEach(line => {
            let m;
            re.lastIndex = 0;
            while ((m = re.exec(line))) {
                const raw = m[0];
                const lead = raw.length - raw.trimStart().length;
                const text = raw.trim();
                if (text.replace(/[^\p{L}\p{N}]/gu, '').length >= 2) {
                    const start = lineStart + m.index + lead;
                    units.push([start, start + text.length]);
                }
            }
            lineStart += line.length + 1;
        });
        return units;
    }

    // Highlighted passages (from the note's formatting) are always kept first
    function highlighted(html) {
        if (!html || !html.includes('<mark')) return [];
        const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
        return [...doc.querySelectorAll('mark')].map(m => m.textContent.trim().toLowerCase()).filter(t => t.length > 2);
    }

    const memo = new Map();

    function signature(n) {
        return hash(`${VERSION}|${n.title || ''}|${source(n)}|${n.html && n.html.includes('<mark') ? hash(n.html) : ''}`);
    }

    // Stored analysis if it's current, otherwise computed (and remembered for this session)
    function analyse(n) {
        const sig = signature(n);
        if (n.dilute && n.dilute.sig === sig) return n.dilute;
        const cached = memo.get(n.id);
        if (cached && cached.sig === sig) return cached;
        const result = compute(n, sig);
        if (n.id) memo.set(n.id, result);
        return result;
    }

    function compute(n, sig) {
        const src = source(n);

        const units = split(src);
        const tf = new Map();
        const perUnit = units.map(([a, b]) => {
            const w = contentWords(src.slice(a, b));
            w.forEach(x => tf.set(x, (tf.get(x) || 0) + 1));
            return w;
        });
        const marks = highlighted(n.html);
        const titleWords = new Set(contentWords(n.title || ''));

        const scores = units.map(([a, b], i) => {
            const text = src.slice(a, b);
            const w = perUnit[i];
            const all = words(text).length || 1;
            let score = [...new Set(w)].reduce((sum, x) => sum + (tf.get(x) || 0) + (titleWords.has(x) ? 2 : 0), 0) / Math.sqrt(all + 3);
            if (i === 0) score *= 1.3;                                   // openings usually set the topic
            if (CUES.test(text)) score += 2.5;
            if (/\d/.test(text)) score += 0.6;                           // dates, amounts, times
            if (/^[✓○•\-*]/.test(text) || /^\d+[.)]\s/.test(text)) score += 0.4;
            if (all < 4) score *= 0.6;
            const lower = text.toLowerCase();
            if (marks.some(m => lower.includes(m) || m.includes(lower))) score += 100;
            return score;
        });

        const order = scores.map((s, i) => [s, i]).sort((x, y) => y[0] - x[0] || x[1] - y[1]).map(x => x[1]);
        const rank = new Array(units.length);
        order.forEach((unitIndex, r) => { rank[unitIndex] = r; });

        return {
            sig,
            units: units.map((u, i) => [u[0], u[1], rank[i]]),
            words: words(src).length,
            essence: essence(units.length ? src.slice(units[order[0]][0], units[order[0]][1]) : src.trim()),
            terms: topTerms(tf, titleWords)
        };
    }

    // One line: the most essential sentence with the filler squeezed out
    function essence(sentence) {
        let t = sentence
            .replace(/\s*\([^)]*\)/g, '')
            .replace(/\b(really|very|just|actually|basically|literally|honestly|kind of|sort of|a bit|pretty much|I think that|I feel like)\b\s*/gi, '')
            .replace(/\s{2,}/g, ' ')
            .trim();
        const w = t.split(' ');
        if (w.length > 16) t = `${w.slice(0, 16).join(' ').replace(/[,;:]$/, '')}…`;
        return t.charAt(0).toUpperCase() + t.slice(1);
    }

    function topTerms(tf, titleWords) {
        titleWords.forEach(w => tf.set(w, (tf.get(w) || 0) + 2));
        return Object.fromEntries([...tf.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30));
    }

    /**
     * The note at a strength between 10 and 100 (percent of its words).
     * Lowest strength: { essence: true, text }. Otherwise { lines: [{ text, gapBefore }], tail, total, shown }
     * with the kept sentences in the note's own order; gapBefore/tail mark where sentences were left out.
     */
    function pour(n, level) {
        const a = analyse(n);
        const src = source(n);
        if (level <= 15 || a.units.length <= 1) return { essence: true, text: a.essence };
        const target = Math.max(1, Math.round(a.words * level / 100));
        const keep = new Set();
        let shown = 0;
        a.units
            .map((u, i) => [u, i])
            .sort((x, y) => x[0][2] - y[0][2])
            .some(([u, i]) => {
                if (shown >= target && keep.size) return true;
                keep.add(i);
                shown += words(src.slice(u[0], u[1])).length;
                return false;
            });
        const lines = [];
        let cur = null;
        let prev = -1;
        a.units.forEach((u, i) => {
            if (!keep.has(i)) return;
            const gap = i !== prev + 1;
            const newLine = prev < 0 || gap || src.slice(a.units[prev][1], u[0]).includes('\n');
            if (newLine) {
                cur = { text: '', gapBefore: gap && (prev >= 0 || i > 0) };
                lines.push(cur);
            }
            cur.text += (cur.text ? ' ' : '') + src.slice(u[0], u[1]);
            prev = i;
        });
        return { lines, tail: prev < a.units.length - 1, total: a.words, shown };
    }

    function canDilute(n) {
        const a = analyse(n);
        return a.units.length >= 3 && a.words >= 40;
    }

    // ---------- Pairing ----------
    /**
     * The single note that overlaps most with `note`, or null.
     * candidates: notes allowed to appear; skip: ids you dismissed for this note.
     */
    function pair(note, candidates, skip = []) {
        const mine = analyse(note).terms;
        const myKeys = Object.keys(mine);
        if (myKeys.length < 3) return null;

        const pool = candidates.filter(c => c.id !== note.id && !skip.includes(c.id));
        if (!pool.length) return null;
        const vectors = pool.map(c => analyse(c).terms);
        // Words that appear in many notes say little about any one of them
        const df = new Map();
        [mine, ...vectors].forEach(t => Object.keys(t).forEach(w => df.set(w, (df.get(w) || 0) + 1)));
        const N = vectors.length + 1;
        const idf = w => Math.log(1 + N / (df.get(w) || 1));
        const weigh = t => {
            const v = new Map();
            let norm = 0;
            Object.entries(t).forEach(([w, f]) => {
                const x = (1 + Math.log(f)) * idf(w);
                v.set(w, x);
                norm += x * x;
            });
            return { v, norm: Math.sqrt(norm) || 1 };
        };
        const me = weigh(mine);

        let best = null;
        pool.forEach((c, i) => {
            const other = weigh(vectors[i]);
            let dot = 0;
            const shared = [];
            me.v.forEach((x, w) => {
                const y = other.v.get(w);
                if (y) {
                    dot += x * y;
                    shared.push([w, x * y]);
                }
            });
            let score = dot / (me.norm * other.norm);
            if (note.folderId && c.folderId === note.folderId) score += 0.04;
            score += (note.emotions || []).filter(e => (c.emotions || []).includes(e)).length * 0.02;
            if (shared.length >= 2 && score > 0.14 && (!best || score > best.score)) {
                best = { note: c, score, shared: shared.sort((a, b) => b[1] - a[1]).slice(0, 3).map(x => x[0]) };
            }
        });
        return best;
    }

    return { analyse, signature, pour, canDilute, pair, source, VERSION };
})();
