// app.js (Production Edition)
let currentStory = null;

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

function escapeHtml(str) {
    const d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
}

// ─── Metadata Fetch ───────────────────────────────────────────────────────────
async function fetchStory() {
    const urlInput = $('storyUrl').value.trim();
    if (!urlInput) { showBanner('error', 'Paste a Wattpad URL.'); return; }

    const btn = $('fetchBtn');
    btn.disabled = true;
    hide('storyCard'); hide('progressCard'); hide('statusBanner');

    try {
        const res = await fetch(`/api/story?url=${encodeURIComponent(urlInput)}`);
        const data = await res.json();
        if (!res.ok) { showBanner('error', data.error || 'Failed to load.'); return; }

        currentStory = data;
        renderStoryCard(data);
        show('storyCard');
        showBanner('success', `Found ${data.chapters.length} chapters.`);
    } catch (err) {
        showBanner('error', 'Connection error.');
    } finally {
        btn.disabled = false;
    }
}

function renderStoryCard(data) {
    const fb = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="150" height="220"%3E%3Crect width="150" height="220" fill="%237c3aed" rx="8"/%3E%3Ctext x="75" y="115" text-anchor="middle" fill="white" font-size="40"%3E%F0%9F%93%96%3C/text%3E%3C/svg%3E';
    $('storyCover').src = data.cover || fb;
    $('storyTitle').textContent = data.title;
    $('storyAuthor').textContent = data.author;
    $('storyChapterCount').textContent = `${data.chapters.length} Chapters`;

    const tmp = document.createElement('div');
    tmp.innerHTML = data.description || '';
    $('storyDesc').textContent = (tmp.textContent || tmp.innerText || '').slice(0, 300) + '...';

    const list = $('chapterList');
    list.innerHTML = '';
    data.chapters.forEach(ch => {
        const li = document.createElement('li');
        li.className = 'chapter-item';
        li.innerHTML = `<span class="chapter-num">${ch.index}</span><span class="chapter-name">${escapeHtml(ch.title)}</span>`;
        list.appendChild(li);
    });
}

// ─── Download PDF ──────────────────────────────────────────────────────────────
async function downloadPDF() {
    if (!currentStory) return;

    const dlBtn = $('downloadBtn');
    dlBtn.disabled = true;
    dlBtn.innerHTML = '<span class="spinning">⚙️</span><span>Building PDF...</span>';
    show('progressCard');
    hide('statusBanner');

    let prog = 10;
    setProgress(prog);
    $('progressSubtitle').textContent = 'Server is fetching content and building PDF...';

    // "Crawling" progress bar to show life while server works
    const progInterval = setInterval(() => {
        if (prog < 85) {
            prog += Math.random() * 5;
            setProgress(prog);
        }
    }, 600);

    try {
        const res = await fetch('/api/generate-pdf', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                title: currentStory.title,
                author: currentStory.author,
                description: currentStory.description,
                chapters: currentStory.chapters.map(c => ({ id: c.id, title: c.title }))
            }),
        });

        clearInterval(progInterval);

        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.error || 'Server limit reached.');
        }

        setProgress(95);
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${currentStory.title.replace(/[\\/:*?"<>|]/g, '_')}.pdf`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        setProgress(100);
        $('progressSubtitle').textContent = '✅ Download complete!';
        showBanner('success', 'PDF saved successfully.');
    } catch (err) {
        clearInterval(progInterval);
        showBanner('error', `${err.message} (Stories > 80 chapters often exceed Vercel's 10s limit)`);
        hide('progressCard');
    } finally {
        dlBtn.disabled = false;
        dlBtn.innerHTML = '<span class="btn-icon">📄</span><span>Download as PDF</span>';
    }
}

function setProgress(pct) { $('progressBar').style.width = `${Math.min(100, pct)}%`; }

document.addEventListener('DOMContentLoaded', () => {
    $('storyUrl').addEventListener('keydown', e => { if (e.key === 'Enter') fetchStory(); });
});