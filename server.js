// server.js — Wattpad PDF Downloader (Optimized for Vercel)
const express = require('express');
const cheerio = require('cheerio');
const PDFDocument = require('pdfkit');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ─── Font Setup (Nirmala UI supports Sinhala, Devanagari, Tamil etc.) ─────────
// Using relative paths for portability (Vercel deployment)
const NIRMALA = path.join(__dirname, 'fonts', 'nirmala.ttf');
const NIRMALA_BOLD = path.join(__dirname, 'fonts', 'nirmala-bold.ttf');
const HAS_NIRMALA = fs.existsSync(NIRMALA);

console.log(HAS_NIRMALA
  ? '✅ Ported Unicode font: Nirmala UI found in fonts/ directory'
  : '⚠️  Nirmala.ttf not found in fonts/ folder — PDF will use Helvetica (Latin only)');

// ─── Wattpad Visitor Session ───────────────────────────────────────────────────
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
      timeout: 10000,
      maxRedirects: 3,
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

function parseStorytextData(data) {
  if (Array.isArray(data)) {
    return data.map(item => {
      const html = typeof item === 'string' ? item : (item.text ?? item.content ?? item.body ?? '');
      return htmlToText(String(html));
    }).filter(Boolean).join('\n\n');
  }
  if (data && typeof data === 'object') {
    const html = data.text ?? data.content ?? data.body ?? '';
    return htmlToText(String(html));
  }
  return htmlToText(data);
}

// ─── Chapter Content Fetcher (Server-side) ───────────────────────────────────
async function fetchChapterContent(id) {
  try {
    const cookies = await getWattpadSession();
    const url = `https://www.wattpad.com/apiv2/storytext?id=${id}`;
    const { data } = await axios.get(url, {
      headers: { ...BASE_HEADERS, Cookie: cookies },
      timeout: 15000,
    });

    if (data === 'Array') {
      // Session might be stale, refresh once
      _wattpadCookies = '';
      const freshCookies = await getWattpadSession();
      const retry = await axios.get(url, {
        headers: { ...BASE_HEADERS, Cookie: freshCookies },
        timeout: 15000,
      });
      return parseStorytextData(retry.data);
    }
    return parseStorytextData(data);
  } catch (err) {
    console.error(`Error fetching chapter ${id}:`, err.message);
    return '[Chapter content unavailable due to fetch error]';
  }
}

// ─── Routes ───────────────────────────────────────────────────────────────────

function extractStoryId(url) {
  const m = url.match(/wattpad\.com\/story\/(\d+)/);
  return m ? m[1] : null;
}

app.get('/api/story', async (req, res) => {
  const { url } = req.query;
  const storyId = extractStoryId(url || '');
  if (!storyId) return res.status(400).json({ error: 'Valid Wattpad story URL required' });

  try {
    const apiUrl = `https://www.wattpad.com/api/v3/stories/${storyId}?fields=id,title,user(name,avatar),description,cover,completed,numParts,parts(id,title,length),views,votes`;
    const { data } = await axios.get(apiUrl, { headers: { ...BASE_HEADERS, Accept: 'application/json' }, timeout: 10000 });
    res.json({
      id: data.id,
      title: data.title,
      author: data.user?.name,
      cover: data.cover,
      description: data.description,
      completed: data.completed,
      numParts: data.numParts,
      chapters: (data.parts || []).map((p, i) => ({ index: i + 1, id: p.id, title: p.title })),
      views: data.views,
      votes: data.votes
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch story metadata' });
  }
});

// Optimized PDF Generation Path
// To avoid 413 Payload Too Large, the browser sends chapter IDs, NOT the text.
app.post('/api/generate-pdf', async (req, res) => {
  try {
    const { title, author, description, chapters } = req.body;
    if (!title || !Array.isArray(chapters)) return res.status(400).json({ error: 'Invalid data' });

    console.log(`\n📄 Starting PDF generation for: "${title}" (${chapters.length} chapters)`);

    res.setHeader('Content-Type', 'application/pdf');
    const safeTitle = title.replace(/[^\x20-\x7E]/g, '').replace(/[\\/:*?"<>|]/g, '_').trim() || 'story';
    res.setHeader('Content-Disposition', `attachment; filename="${safeTitle}.pdf"`);

    const doc = new PDFDocument({ size: 'A4', margins: { top: 60, bottom: 60, left: 72, right: 72 } });
    if (HAS_NIRMALA) {
      doc.registerFont('Regular', NIRMALA);
      doc.registerFont('Bold', NIRMALA_BOLD);
    }
    doc.pipe(res);

    const W = doc.page.width, CW = W - 144;
    const bar = () => doc.rect(0, 0, W, 7).fill('#7c3aed');

    // Title Page
    bar(); doc.moveDown(4);
    doc.font('Bold').fontSize(24).fillColor('#1a1a2e').text(title, { align: 'center', width: CW });
    doc.moveDown(0.5);
    doc.font('Regular').fontSize(14).fillColor('#7c3aed').text(`by ${author || 'Unknown'}`, { align: 'center' });
    doc.moveDown(2);
    if (description) {
      const dText = cheerio.load(description).text().replace(/\s+/g, ' ').trim().slice(0, 500);
      doc.font('Regular').fontSize(10).fillColor('#555').text(dText, { align: 'center', width: CW });
    }
    doc.moveDown(3);
    doc.fontSize(9).fillColor('#aaa').text(`Generated on ${new Date().toLocaleDateString()}`, { align: 'center' });

    // Table of Contents
    doc.addPage(); bar(); doc.moveDown(2);
    doc.font('Bold').fontSize(18).fillColor('#1a1a2e').text('Table of Contents', { align: 'center' });
    doc.moveDown(1);
    chapters.forEach((ch, i) => {
      doc.font('Regular').fontSize(11).fillColor('#333').text(`${i + 1}.  ${ch.title}`, { indent: 20 });
      doc.moveDown(0.2);
    });

    // Content Pages
    // We fetch and add chapters one by one to avoid memory spikes and long stalls
    for (let i = 0; i < chapters.length; i++) {
      const ch = chapters[i];
      const text = await fetchChapterContent(ch.id);

      doc.addPage(); bar(); doc.moveDown(1.5);
      doc.font('Bold').fontSize(10).fillColor('#7c3aed').text(`CHAPTER ${i + 1}`, { align: 'center' });
      doc.font('Bold').fontSize(16).fillColor('#1a1a2e').text(ch.title, { align: 'center', width: CW });
      doc.moveDown(1.5);
      doc.font('Regular').fontSize(11).fillColor('#111').text(text || '[Empty]', { align: 'justify', lineGap: 3, paragraphGap: 6 });
    }

    doc.end();
    console.log(`✅ Completed: "${title}"`);
  } catch (err) {
    console.error('PDF error:', err.message);
    if (!res.headersSent) res.status(500).json({ error: 'PDF Generation failed' });
  }
});

app.listen(PORT, () => console.log(`🚀 Server on port ${PORT}`));