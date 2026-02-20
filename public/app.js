// ─── State ─────────────────────────────────────────────────────────────────────
let currentStory = null;

// ─── DOM Helpers ──────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const show = id => $(id).classList.remove('hidden');
const hide = id => $(id).classList.add('hidden');

function showBanner(type, msg) {
    const banner = $('statusBanner');
    banner.className = `status-banner ${type}`;
    const icons = { error: '❌', success: '✅', info: 'ℹ️', warning: '⚠️' };
    banner.innerHTML = `<span>${icons[type] || ''}</span><span>${msg}</span>`;
    show('statusBanner');
}

function formatNumber(n) {
    if (!n) return '0';
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
    if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
    return String(n);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function escapeHtml(str) {
    const d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
}

// ─── Strip HTML tags → plain text ─────────────────────────────────────────────
function htmlToPlain(html) {
    if (!html || typeof html !== 'string') return '';
    const d = document.createElement('div');
    d.innerHTML = html;
    // Replace <br> with newline
    d.querySelectorAll('br').forEach(el => el.replaceWith(document.createTextNode('\n')));
    // Walk all text nodes
    const walker = document.createTreeWalker(d, NodeFilter.SHOW_TEXT);
    const parts = [];
    let n;
    while ((n = walker.nextNode())) {
        const t = n.textContent;
        if (t && t.trim()) parts.push(t.trim());
    }
    return parts.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// ─── Parse any Wattpad storytext response ─────────────────────────────────────
//
// The apiv2/storytext endpoint returns a JSON ARRAY of paragraph objects:
//   [{"id":"abc","text":"<p>paragraph text</p>","length":42}, ...]
//
// We must JSON.parse it first, then extract the HTML from the "text" field
// of each paragraph, strip tags, and join into plain text paragraphs.
//
function parseStoryTextResponse(raw) {
    if (!raw || !raw.trim()) return '';
    const s = raw.trim();

    // ── JSON Array format (most common) ────────────────────────────────────────
    if (s.startsWith('[')) {
        try {
            const arr = JSON.parse(s);
            if (Array.isArray(arr) && arr.length > 0) {
                const paragraphs = [];
                for (const item of arr) {
                    // item may be a string of HTML directly, or an object with a text field
                    let html = '';
                    if (typeof item === 'string') {
                        html = item;
                    } else if (item && typeof item === 'object') {
                        // Try known field names
                        html = item.text ?? item.content ?? item.body ?? item.paragraph ?? '';
                        // If still empty, pick the longest string value in the object
                        if (!html) {
                            for (const v of Object.values(item)) {
                                if (typeof v === 'string' && v.length > html.length) html = v;
                            }
                        }
                    }
                    const text = htmlToPlain(String(html));
                    if (text) paragraphs.push(text);
                }
                return paragraphs.join('\n\n');
            }
        } catch (_) { /* Not valid JSON — fall through */ }
    }

    // ── JSON Object format (alternate) ─────────────────────────────────────────
    if (s.startsWith('{')) {
        try {
            const obj = JSON.parse(s);
            const html = obj.text ?? obj.content ?? obj.body ?? obj.data ?? '';
            if (html) return htmlToPlain(String(html));
        } catch (_) { }
    }

    // ── Raw HTML fallback ───────────────────────────────────────────────────────
    return htmlToPlain(s);
}

// ─── Fetch One Chapter via Server Proxy ───────────────────────────────────────
//
// apiv2/storytext returns "Array" when no Wattpad session cookie is present.
// Browser fetches with credentials:'omit' have no cookies → always "Array".
// credentials:'include' would work but causes a CORS wildcard error.
// SOLUTION: The server holds a visitor session cookie and proxies requests.
//
async function fetchChapterText(partId) {
    const res = await fetch(`/api/chapter?id=${partId}`);
    if (!res.ok) throw new Error(`Server error ${res.status}`);
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    return data.text || '';
}

// ─── Fetch Story Metadata ──────────────────────────────────────────────────────
async function fetchStory() {
    const urlInput = $('storyUrl').value.trim();
    if (!urlInput) { showBanner('error', 'Please paste a Wattpad story URL.'); return; }
    if (!urlInput.includes('wattpad.com/story/')) {
        showBanner('error', 'Please use the main story URL — must contain /story/ e.g. https://www.wattpad.com/story/123456789');
        return;
    }

    const btn = $('fetchBtn');
    btn.disabled = true;
    btn.innerHTML = '<span class="btn-text">Fetching…</span><span class="spinning">⚙️</span>';
    hide('storyCard'); hide('progressCard'); hide('statusBanner');

    try {
        const res = await fetch(`/api/story?url=${encodeURIComponent(urlInput)}`);
        const data = await res.json();
        if (!res.ok) { showBanner('error', data.error || 'Failed to load story.'); return; }

        currentStory = data;
        renderStoryCard(data);
        show('storyCard');
        showBanner('success', `Found "${data.title}" — ${data.chapters.length} chapters. Ready to download!`);
    } catch (err) {
        showBanner('error', 'Network error. Is the server running at localhost:3000?');
        console.error(err);
    } finally {
        btn.disabled = false;
        btn.innerHTML = '<span class="btn-text">Fetch Story</span><span class="btn-icon">✨</span>';
    }
}

function renderStoryCard(data) {
    const fallback = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="150" height="220"%3E%3Crect width="150" height="220" fill="%237c3aed" rx="8"/%3E%3Ctext x="75" y="115" text-anchor="middle" fill="white" font-size="40"%3E%F0%9F%93%96%3C/text%3E%3C/svg%3E';
    const cover = $('storyCover');
    cover.src = data.cover || fallback;
    cover.onerror = () => { cover.src = fallback; };

    const badge = $('storyStatus');
    badge.textContent = data.completed ? '✅ Completed' : '🔄 Ongoing';
    badge.className = data.completed ? 'badge' : 'badge ongoing';

    $('storyChapterCount').textContent = `${data.numParts} Chapter${data.numParts !== 1 ? 's' : ''}`;
    $('storyTitle').textContent = data.title;
    $('storyAuthor').textContent = data.author;

    const tmp = document.createElement('div');
    tmp.innerHTML = data.description || '';
    $('storyDesc').textContent = (tmp.textContent || tmp.innerText || 'No description.').slice(0, 400);

    $('storyViews').textContent = formatNumber(data.views);
    $('storyVotes').textContent = formatNumber(data.votes);

    const list = $('chapterList');
    list.innerHTML = '';
    data.chapters.forEach(ch => {
        const li = document.createElement('li');
        li.className = 'chapter-item';
        li.innerHTML = `<span class="chapter-num">${ch.index}</span><span class="chapter-name" title="${escapeHtml(ch.title)}">${escapeHtml(ch.title)}</span>`;
        list.appendChild(li);
    });
}

// ─── Download PDF ──────────────────────────────────────────────────────────────
async function downloadPDF() {
    if (!currentStory) return;

    const dlBtn = $('downloadBtn');
    dlBtn.disabled = true;
    dlBtn.innerHTML = '<span class="spinning">⚙️</span><span class="btn-text">Downloading…</span>';
    show('progressCard'); hide('statusBanner');

    const chapters = currentStory.chapters;
    const total = chapters.length;
    const assembled = [];
    let failCount = 0;

    setProgress(0);
    updateStatus(`Starting — fetching ${total} chapters from Wattpad…`);

    // ── Phase 1: Browser fetches each chapter text from Wattpad ─────────────────
    for (let i = 0; i < total; i++) {
        const ch = chapters[i];
        updateStatus(`📖 Chapter ${i + 1} / ${total}: "${ch.title}"…`);
        setProgress(Math.round((i / total) * 70));

        let text = '';
        for (let attempt = 1; attempt <= 3; attempt++) {
            try {
                text = await fetchChapterText(ch.id);
                // Log result to browser console for debugging
                console.log(`Ch ${i + 1} [id=${ch.id}]: ${text.length} chars — ${text.slice(0, 60)}`);
                break;
            } catch (err) {
                console.warn(`Ch ${i + 1} attempt ${attempt} failed: ${err.message}`);
                if (attempt < 3) await sleep(1000 * attempt);
                else { failCount++; text = ''; }
            }
        }

        assembled.push({ title: ch.title, text });
        if (i < total - 1) await sleep(200); // polite delay
    }

    setProgress(73);
    updateStatus(`Building PDF — ${total} chapters, ${failCount} failed…`);

    // ── Phase 2: POST to server → generate PDF ───────────────────────────────────
    try {
        const res = await fetch('/api/generate-pdf', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                title: currentStory.title,
                author: currentStory.author,
                description: currentStory.description,
                chapters: assembled,
            }),
        });

        if (!res.ok) {
            let msg = `Server error ${res.status}`;
            try { const j = await res.json(); msg = j.error || msg; } catch (_) { }
            throw new Error(msg);
        }

        setProgress(98);
        updateStatus('Saving PDF…');
        const blob = await res.blob();
        setProgress(100);

        const a = document.createElement('a');
        const blobUrl = URL.createObjectURL(blob);
        a.href = blobUrl;
        a.download = `${currentStory.title.replace(/[\\/:*?"<>|]/g, '_')}.pdf`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(blobUrl), 15000);

        updateStatus('✅ Complete!');
        showBanner(failCount > 0 ? 'warning' : 'success',
            failCount > 0
                ? `PDF downloaded — ${failCount} chapter(s) were empty (shown as placeholders in PDF).`
                : `"${currentStory.title}.pdf" saved to Downloads! 🎉`
        );
    } catch (err) {
        showBanner('error', `Download failed: ${err.message}`);
        hide('progressCard');
        console.error(err);
    } finally {
        dlBtn.disabled = false;
        dlBtn.innerHTML = '<span class="btn-icon">📄</span><span class="btn-text">Download as PDF</span>';
    }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function setProgress(pct) {
    $('progressBar').style.width = `${Math.min(100, Math.max(0, pct))}%`;
}
function updateStatus(msg) {
    $('progressSubtitle').textContent = msg;
}

// ─── Keyboard shortcut ────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    $('storyUrl').addEventListener('keydown', e => { if (e.key === 'Enter') fetchStory(); });
});