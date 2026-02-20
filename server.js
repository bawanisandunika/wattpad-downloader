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
  const url = req.query.url || '';
  const storyId = url.match(/story\/(\d+)/)?.[1] || url.match(/-(\d+)(?:-|$)/)?.[1] || url.match(/(\d+).*/)?.[1];

  console.log('🔍 Fetching Story ID:', storyId, 'from URL:', url);

  if (!storyId || !/^\d+$/.test(storyId)) {
    return res.status(400).json({ error: 'Could not find a valid Story ID in that URL.' });
  }

  try {
    // Try V3 first
    let { data } = await axios.get(`https://www.wattpad.com/api/v3/stories/${storyId}?fields=id,title,user(name),description,cover,parts(id,title)`, {
      headers: BASE_HEADERS,
      timeout: 6000,
      transformResponse: [d => d] // Get raw string for robust parsing
    });

    let storyData = { title: 'Untitled', author: 'Unknown', chapters: [] };

    // Try to parse as JSON first
    try {
      const json = JSON.parse(data);
      if (json.id) {
        storyData.title = json.title;
        storyData.author = json.user?.name;
        storyData.cover = json.cover;
        storyData.description = json.description;
        storyData.chapters = (json.parts || []).map((p, i) => ({ index: i + 1, id: p.id, title: p.title }));
      }
    } catch (e) {
      console.log('⚠️ Story V3 JSON parse failed, attempting regex/legacy parsing...');
    }

    // Fallback: If no chapters found, try to regex the "PHP Array" output
    if (storyData.chapters.length === 0) {
      console.log('🔄 Chapters empty, trying fallback parsing on raw response...');
      const IDs = [...data.matchAll(/'id'\s*=>\s*(\d+)/g)].map(m => m[1]);
      const titles = [...data.matchAll(/'title'\s*=>\s*'(.*?)'/g)].map(m => m[1]);
      if (IDs.length > 0) {
        storyData.chapters = IDs.map((id, i) => ({ index: i + 1, id, title: titles[i] || `Chapter ${i + 1}` }));
        console.log(`✅ Extracted ${IDs.length} chapters via regex fallback.`);
      }
    }

    // NEW METADATA SCRAPING FALLBACK (for Title/Author/Cover)
    if (storyData.title === 'Untitled' || !storyData.cover) {
      console.log('� Metadata missing, scraping story page directly...');
      try {
        const pageRes = await axios.get(url, { headers: BASE_HEADERS, timeout: 5000 });
        const $ = cheerio.load(pageRes.data);

        storyData.title = $('meta[property="og:title"]').attr('content') || $('.story-info__title').text().trim() || storyData.title;
        storyData.author = $('meta[property="og:author"]').attr('content') || $('.author-info__username').text().trim() || storyData.author;
        storyData.cover = $('meta[property="og:image"]').attr('content') || $('.story-cover img').attr('src') || storyData.cover;
        storyData.description = $('meta[property="og:description"]').attr('content') || $('.description-text').text().trim() || storyData.description;

        console.log('✅ Scraped Metadata:', { title: storyData.title, author: storyData.author });
      } catch (scrapeError) {
        console.error('⚠️ Scraping fallback failed:', scrapeError.message);
      }
    }

    console.log('📦 Final Story Metadata Chapters:', storyData.chapters.length);
    res.json(storyData);

  } catch (e) {
    console.error('❌ Story metadata fetch failed:', e.message);
    res.status(500).json({ error: 'Failed to fetch story metadata from Wattpad.' });
  }
});

app.post('/api/generate-pdf', async (req, res) => {
  const { title, author, description, chapters } = req.body;

  // Debug: Log the full body to see what's actually coming through
  console.log('📄 PDF Request Full Body:', JSON.stringify(req.body, null, 2));

  console.log('📄 PDF Request Summary:', { title, author, chaptersCount: chapters?.length });
  if (!title || !chapters || !Array.isArray(chapters)) {
    console.error('❌ Validation Failed:', { title: !!title, chapters: !!chapters, isArray: Array.isArray(chapters) });
    return res.status(400).json({ error: 'Missing or invalid data: title and chapters (array) are required.' });
  }

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

app.listen(PORT, () => {
  console.log(`\n🚀 Server is running locally!`);
  console.log(`🔗 Open in browser: \x1b[36mhttp://localhost:${PORT}\x1b[0m\n`);
});