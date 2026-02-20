// server.js — Wattpad PDF Downloader
const express = require('express');
const cheerio = require('cheerio');
const PDFDocument = require('pdfkit');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const axios = require('axios');

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json({ limit: '200mb' }));
app.use(express.urlencoded({ extended: true, limit: '200mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ─── Font (Nirmala UI supports Sinhala, Devanagari, Tamil …) ──────────────────
const NIRMALA = 'C:\\Windows\\Fonts\\Nirmala.ttf';
const NIRMALA_BOLD = 'C:\\Windows\\Fonts\\NirmalaB.ttf';
const HAS_NIRMALA = fs.existsSync(NIRMALA);

// ─── Wattpad Visitor Session ───────────────────────────────────────────────────
// apiv2/storytext returns the literal string "Array" when no session cookie is
// present. We obtain a guest/visitor session once at startup, then reuse it for
// every chapter request. This resolves the content gate without requiring a login.
let _wattpadCookies = '';

async function getWattpadSession() {
  if (_wattpadCookies) return _wattpadCookies;
  try {
    console.log('🔑 Acquiring Wattpad visitor session…');
    const r = await axios.get('https://www.wattpad.com/', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      timeout: 15000,
      maxRedirects: 5,
    });
    const setCookies = r.headers['set-cookie'] || [];
    _wattpadCookies = setCookies.map(c => c.split(';')[0]).join('; ');
    console.log(`✅ Session acquired (${_wattpadCookies.length} chars)`);
  } catch (err) {
    console.warn('⚠️  Could not acquire session:', err.message);
    _wattpadCookies = '';
  }
  return _wattpadCookies;
}

// Acquire session at startup so first download is fast
getWattpadSession().catch(() => { });

// ─── Shared request headers ────────────────────────────────────────────────────
const BASE_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer': 'https://www.wattpad.com/',
};

// ─── Text helpers ──────────────────────────────────────────────────────────────
function htmlToText(html) {
  if (!html || typeof html !== 'string') return '';
  const $ = cheerio.load(html);
  $('br').replaceWith('\n');
  $('p, div').each((_, el) => {
    const t = $(el).text().trim();
    if (t) $(el).replaceWith(t + '\n\n');
  });
  return $.text().replace(/[ \t]+/g, ' ').replace(/\n{4,}/g, '\n\n\n').trim();
}

// Parse whatever apiv2/storytext returns:
// • JSON array: [{"text":"<p>…</p>","id":"…"}, …]  ← most common
// • JSON object: {"text":"<p>…</p>"}
// • Raw HTML string
function parseStorytextData(data) {
  // axios auto-parses JSON when content-type is application/json
  if (Array.isArray(data)) {
    return data.map(item => {
      const html = typeof item === 'string'
        ? item
        : (item.text ?? item.content ?? item.body ?? item.paragraph ?? '');
      return htmlToText(String(html));
    }).filter(Boolean).join('\n\n');
  }
  if (data && typeof data === 'object') {
    const html = data.text ?? data.content ?? data.body ?? data.data ?? '';
    return htmlToText(String(html));
  }
  if (typeof data === 'string') {
    return htmlToText(data);
  }
  return '';
}

function safeText(str) {
  if (!str || typeof str !== 'string') return '[No content available]';
  const t = str.trim();
  return t.length > 0 ? t : '[No content available]';
}

function toAsciiFilename(str) {
  return str.replace(/[^\x20-\x7E]/g, '').replace(/[\\/:*?"<>|]/g, '_').trim().slice(0, 100) || 'wattpad-story';
}

function extractStoryId(url) {
  const m = url.match(/wattpad\.com\/story\/(\d+)/);
  return m ? m[1] : null;
}

// ─── GET /api/story — story metadata ──────────────────────────────────────────
app.get('/api/story', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'url parameter required' });
  const storyId = extractStoryId(url);
  if (!storyId) return res.status(400).json({ error: 'URL must contain /story/' });

  try {
    const apiUrl = `https://www.wattpad.com/api/v3/stories/${storyId}?fields=id,title,user(name,avatar),description,cover,completed,numParts,parts(id,title,length),views,votes`;
    const { data } = await axios.get(apiUrl, { headers: { ...BASE_HEADERS, Accept: 'application/json' }, timeout: 15000 });
    res.json({
      id: data.id,
      title: data.title || 'Untitled',
      author: data.user?.name || 'Unknown',
      authorAvatar: data.user?.avatar || '',
      cover: data.cover || '',
      description: data.description || '',
      completed: data.completed || false,
      numParts: data.numParts || (data.parts || []).length,
      chapters: (data.parts || []).map((p, i) => ({
        index: i + 1, id: p.id,
        title: p.title || `Chapter ${i + 1}`,
        length: p.length || 0,
      })),
      views: data.views || 0,
      votes: data.votes || 0,
    });
  } catch (err) {
    console.error('Story fetch error:', err.message);
    if (err.response?.status === 404) return res.status(404).json({ error: 'Story not found or private.' });
    res.status(500).json({ error: 'Failed to fetch story: ' + err.message });
  }
});

// ─── GET /api/chapter?id=PARTID — fetch chapter text (server-side proxy) ───────
//
// WHY server-side?
//   • apiv2/storytext returns the literal string "Array" when no Wattpad
//     session cookie is present. Browser fetches with credentials:'omit' have
//     no cookies → always get "Array".
//   • credentials:'include' triggers a CORS error (Wattpad returns '*' in
//     Access-Control-Allow-Origin which browsers forbid with credentials).
//   • We solve this by having the SERVER fetch with a visitor session cookie.
//
app.get('/api/chapter', async (req, res) => {
  const { id } = req.query;
  if (!id) return res.status(400).json({ error: 'id required' });

  try {
    const cookies = await getWattpadSession();
    const url = `https://www.wattpad.com/apiv2/storytext?id=${id}`;

    const { data } = await axios.get(url, {
      headers: {
        ...BASE_HEADERS,
        'Accept': 'application/json, text/html, */*',
        ...(cookies ? { Cookie: cookies } : {}),
      },
      timeout: 20000,
      // Don't let axios auto-transform — we'll handle it ourselves
      transformResponse: [d => d], // keep as raw string
    });

    // `data` is now a raw string — parse it properly
    let rawText = '';

    if (typeof data === 'string') {
      const s = data.trim();

      // Check if Wattpad returned the "Array" gate response
      if (s === 'Array') {
        console.warn(`⚠️  Chapter ${id}: got "Array" — session may have expired, refreshing…`);
        _wattpadCookies = ''; // invalidate cached session
        const freshCookies = await getWattpadSession();
        if (freshCookies) {
          const retry = await axios.get(url, {
            headers: { ...BASE_HEADERS, Accept: 'application/json, text/html, */*', Cookie: freshCookies },
            timeout: 20000,
            transformResponse: [d => d],
          });
          rawText = typeof retry.data === 'string' ? retry.data.trim() : '';
        }
      } else {
        rawText = s;
      }

      // Now parse appropriately
      let parsed;
      if (rawText.startsWith('[') || rawText.startsWith('{')) {
        try { parsed = JSON.parse(rawText); } catch (_) { }
      }
      const text = parsed ? parseStorytextData(parsed) : htmlToText(rawText);
      console.log(`Ch ${id}: ${text.length} chars — ${text.slice(0, 60)}`);
      res.json({ text });
    } else {
      // axios parsed it as JSON automatically despite transformResponse override — handle it
      const text = parseStorytextData(data);
      res.json({ text });
    }
  } catch (err) {
    console.error(`Chapter ${id} error:`, err.message);
    res.status(500).json({ error: err.message, text: '' });
  }
});

// ─── POST /api/generate-pdf — PDF generation ──────────────────────────────────
app.post('/api/generate-pdf', (req, res) => {
  try {
    const { title, author, description, chapters } = req.body;
    if (!title || !Array.isArray(chapters) || chapters.length === 0)
      return res.status(400).json({ error: 'Invalid payload' });

    const storyTitle = String(title).trim() || 'Wattpad Story';
    const storyAuthor = String(author || 'Unknown').trim();
    console.log(`\n📄 "${storyTitle}" — ${chapters.length} chapters`);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${toAsciiFilename(storyTitle)}.pdf"`);

    const doc = new PDFDocument({
      size: 'A4', margins: { top: 60, bottom: 60, left: 72, right: 72 },
      info: { Title: storyTitle, Author: storyAuthor, Creator: 'Wattpad PDF Downloader' },
    });

    if (HAS_NIRMALA) {
      doc.registerFont('Regular', NIRMALA);
      doc.registerFont('Bold', NIRMALA_BOLD);
    } else {
      doc.registerFont('Regular', 'Helvetica');
      doc.registerFont('Bold', 'Helvetica-Bold');
    }

    doc.on('error', e => console.error('PDFKit:', e.message));
    doc.pipe(res);

    const W = doc.page.width, CW = W - 144;
    const bar = () => doc.rect(0, 0, W, 7).fill('#7c3aed');

    // Title page
    bar(); doc.moveDown(3.5);
    doc.font('Bold').fontSize(22).fillColor('#1a1a2e').text(storyTitle, { align: 'center', width: CW });
    doc.moveDown(0.6);
    doc.font('Regular').fontSize(13).fillColor('#7c3aed').text(`by ${storyAuthor}`, { align: 'center' });
    doc.moveDown(1.5);
    doc.moveTo(72, doc.y).lineTo(W - 72, doc.y).strokeColor('#ddd6fe').lineWidth(1).stroke();
    doc.moveDown(1.5);
    if (description) {
      try {
        const desc = cheerio.load(description).text().replace(/\s+/g, ' ').trim().slice(0, 400);
        if (desc) { doc.font('Regular').fontSize(10).fillColor('#555').text(desc, { align: 'center', width: CW }); doc.moveDown(1); }
      } catch (_) { }
    }
    doc.moveDown(2);
    doc.font('Regular').fontSize(10).fillColor('#888').text(`${chapters.length} Chapters  •  Wattpad PDF Downloader`, { align: 'center' });
    doc.moveDown(0.5);
    doc.fontSize(9).fillColor('#aaa').text(new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }), { align: 'center' });

    // Table of Contents
    doc.addPage(); bar(); doc.moveDown(2);
    doc.font('Bold').fontSize(17).fillColor('#1a1a2e').text('Table of Contents', { align: 'center' });
    doc.moveDown(1);
    doc.moveTo(72, doc.y).lineTo(W - 72, doc.y).strokeColor('#ddd6fe').lineWidth(1).stroke();
    doc.moveDown(0.8);
    chapters.forEach((ch, i) => {
      doc.font('Regular').fontSize(10).fillColor('#333')
        .text(`${i + 1}.  ${String(ch.title || `Chapter ${i + 1}`).trim()}`, { indent: 10 });
      doc.moveDown(0.2);
    });

    // Chapter pages
    chapters.forEach((ch, i) => {
      const chTitle = String(ch.title || `Chapter ${i + 1}`).trim();
      const chText = safeText(ch.text);
      doc.addPage(); bar(); doc.moveDown(1.5);
      doc.font('Bold').fontSize(9).fillColor('#7c3aed').text(`CHAPTER ${i + 1}`, { align: 'center' });
      doc.moveDown(0.3);
      doc.font('Bold').fontSize(14).fillColor('#1a1a2e').text(chTitle, { align: 'center', width: CW });
      doc.moveDown(0.8);
      doc.moveTo(72, doc.y).lineTo(W - 72, doc.y).strokeColor('#ddd6fe').lineWidth(1).stroke();
      doc.moveDown(1.2);
      doc.font('Regular').fontSize(11).fillColor('#111').text(chText, { align: 'justify', lineGap: 3, paragraphGap: 6 });
    });

    // End page
    doc.addPage(); bar(); doc.moveDown(8);
    doc.font('Bold').fontSize(15).fillColor('#7c3aed').text('— End of Story —', { align: 'center' });
    doc.moveDown(1);
    doc.font('Regular').fontSize(10).fillColor('#aaa').text(`"${storyTitle}" by ${storyAuthor}`, { align: 'center' });
    doc.moveDown(0.5);
    doc.fontSize(9).fillColor('#ccc').text('For personal use only', { align: 'center' });

    doc.end();
    console.log(`✅ PDF complete: "${storyTitle}"`);
  } catch (err) {
    console.error('PDF error:', err.message);
    if (!res.headersSent) res.status(500).json({ error: 'PDF failed: ' + err.message });
  }
});

app.get('/favicon.ico', (_req, res) => res.status(204).end());

app.listen(PORT, () => {
  console.log(HAS_NIRMALA
    ? '✅ Font: Nirmala UI (Sinhala/Devanagari/Tamil supported)'
    : '⚠️  Font: Helvetica (Latin only — install Nirmala.ttf for Unicode)');
  console.log(`\n🚀 Wattpad PDF Downloader  →  http://localhost:${PORT}\n`);
});