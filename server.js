// server.js - Final Vercel Optimized (Lightning Edition)
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
app.use(express.static(path.join(__dirname, 'public')));

// ─── Constants & Headers ───────────────────────────────────────────────────────
const BASE_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer': 'https://www.wattpad.com/',
};

// ─── Font Setup (Case sensitive for Linux/Vercel) ─────────────────────────────
const FONTS_DIR = path.join(__dirname, 'fonts');
const FONT_REGULAR = path.join(FONTS_DIR, 'nirmala.ttf');
const FONT_BOLD = path.join(FONTS_DIR, 'nirmala-bold.ttf');

const hasFonts = fs.existsSync(FONT_REGULAR);
if (hasFonts) {
  console.log(`✅ Fonts found: ${fs.readdirSync(FONTS_DIR).filter(f => f.endsWith('.ttf')).join(', ')}`);
} else {
  console.warn('❌ Fonts dir missing or empty at', FONTS_DIR);
}

// ─── Session Manager ───────────────────────────────────────────────────────────
let _sessionCookies = '';

async function refreshSession() {
  try {
    console.log('🔑 Refreshing Wattpad visitor session…');
    const r = await axios.get('https://www.wattpad.com/', { headers: BASE_HEADERS, timeout: 5000 });
    const sc = r.headers['set-cookie'] || [];
    _sessionCookies = sc.map(c => c.split(';')[0]).join('; ');
  } catch (e) {
    console.error('❌ Session acquisition failed:', e.message);
  }
}

// ─── Text Processing ─────────────────────────────────────────────────────────
function htmlToText(html) {
  if (!html || typeof html !== 'string') return '';
  try {
    const $ = cheerio.load(html);
    $('br').replaceWith('\n');
    $('p, div').each((_, el) => {
      const t = $(el).text().trim();
      if (t) $(el).replaceWith(t + '\n\n');
    });
    return $.text().replace(/[ \t]+/g, ' ').replace(/\n{4,}/g, '\n\n\n').trim();
  } catch (e) {
    return String(html).replace(/<[^>]*>/g, '').trim();
  }
}

function parseStoryData(data) {
  if (Array.isArray(data)) {
    return data.map(i => htmlToText(String(typeof i === 'string' ? i : (i.text ?? i.content ?? '')))).filter(Boolean).join('\n\n');
  }
  if (data && typeof data === 'object') return htmlToText(String(data.text ?? data.content ?? ''));
  return htmlToText(String(data));
}

async function fetchChapterContent(id, retry = 1) {
  if (!_sessionCookies) await refreshSession();
  try {
    const { data } = await axios.get(`https://www.wattpad.com/apiv2/storytext?id=${id}`, {
      headers: { ...BASE_HEADERS, Cookie: _sessionCookies, Accept: 'application/json, text/html, */*' },
      timeout: 6000,
      transformResponse: [d => d], // preserve raw string for "Array" check
    });

    if (data.trim() === 'Array' && retry > 0) {
      _sessionCookies = '';
      return fetchChapterContent(id, retry - 1);
    }

    let parsed = data;
    try { if (data.trim().startsWith('[') || data.trim().startsWith('{')) parsed = JSON.parse(data); } catch (_) { }
    return parseStoryData(parsed);
  } catch (e) {
    if (retry > 0) return fetchChapterContent(id, retry - 1);
    return `[Content unavailable: ${e.message}]`;
  }
}

// ─── API Routes ───────────────────────────────────────────────────────────────

app.get('/api/story', async (req, res) => {
  const storyId = (req.query.url || '').match(/story\/(\d+)/)?.[1];
  if (!storyId) return res.status(400).json({ error: 'Valid Wattpad URL required' });
  try {
    const { data } = await axios.get(`https://www.wattpad.com/api/v3/stories/${storyId}?fields=id,title,user(name),description,cover,parts(id,title)`, { headers: BASE_HEADERS, timeout: 5000 });
    res.json({
      title: data.title, author: data.user?.name, cover: data.cover, description: data.description,
      chapters: (data.parts || []).map((p, i) => ({ index: i + 1, id: p.id, title: p.title }))
    });
  } catch (e) {
    res.status(500).json({ error: 'Story fetch failed' });
  }
});

app.post('/api/generate-pdf', async (req, res) => {
  const { title, author, description, chapters } = req.body;
  if (!title || !chapters) return res.status(400).json({ error: 'Missing data' });

  try {
    if (!_sessionCookies) await refreshSession();

    // Step 1: Parallel Batch Fetching (STAY UNDER 10s)
    const BATCH_SIZE = 12;
    const allTexts = [];
    for (let i = 0; i < chapters.length; i += BATCH_SIZE) {
      const batch = chapters.slice(i, i + BATCH_SIZE);
      const batchTexts = await Promise.all(batch.map(ch => fetchChapterContent(ch.id)));
      allTexts.push(...batchTexts);
    }

    // Step 2: Assemble PDF into Buffer
    const doc = new PDFDocument({ size: 'A4', margins: { top: 60, bottom: 60, left: 72, right: 72 } });
    if (hasFonts) {
      doc.registerFont('Regular', FONT_REGULAR);
      doc.registerFont('Bold', FONT_BOLD);
    }

    const pdfBuffer = await new Promise((resolve, reject) => {
      const chunks = [];
      doc.on('data', chunk => chunks.push(chunk));
      doc.on('error', reject);
      doc.on('end', () => resolve(Buffer.concat(chunks)));

      const W = doc.page.width, CW = W - 144;
      const bar = () => doc.rect(0, 0, W, 7).fill('#7c3aed');

      // Title
      bar(); doc.moveDown(4);
      doc.font('Bold').fontSize(22).fillColor('#1a1a2e').text(title, { align: 'center', width: CW });
      doc.moveDown(0.5);
      doc.font('Regular').fontSize(12).fillColor('#7c3aed').text(`by ${author || 'Unknown'}`, { align: 'center' });
      if (description) {
        const dt = htmlToText(description).trim().slice(0, 500);
        doc.moveDown(2); doc.font('Regular').fontSize(10).fillColor('#444').text(dt, { align: 'center', width: CW });
      }

      // Chapters
      chapters.forEach((ch, i) => {
        doc.addPage(); bar(); doc.moveDown(1.5);
        doc.font('Bold').fontSize(9).fillColor('#7c3aed').text(`CHAPTER ${i + 1}`, { align: 'center' });
        doc.font('Bold').fontSize(15).fillColor('#1a1a2e').text(ch.title, { align: 'center', width: CW });
        doc.moveDown(1.5);
        doc.font('Regular').fontSize(11).fillColor('#111').text(allTexts[i] || '[No content]', { align: 'justify', lineGap: 3, paragraphGap: 6 });
      });
      doc.end();
    });

    res.setHeader('Content-Type', 'application/pdf');
    const safeName = title.replace(/[^\x20-\x7E]/g, '').replace(/[\\/:*?"<>|]/g, '_').slice(0, 80) || 'wattpad';
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}.pdf"`);
    res.setHeader('Content-Length', pdfBuffer.length);
    res.send(pdfBuffer);

  } catch (e) {
    console.error('❌ PDF Error:', e.message);
    if (!res.headersSent) res.status(500).json({ error: `Vercel Limit or Error: ${e.message}` });
  }
});

app.listen(PORT, () => console.log(`🚀 Lightning Server on ${PORT}`));