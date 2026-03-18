/**
 * MV Cars — Subito.it scraper
 * Gira via GitHub Actions, salva:
 *   data/subito.json   → dati annunci
 *   data/imgs/<id>/    → foto scaricate localmente (niente hotlink block)
 */

import fetch from 'node-fetch';
import * as cheerio from 'cheerio';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

/* ── Configurazione ── */
const SHOP_URL   = 'https://impresapiu.subito.it/shops/57262-mv-cars';
const OUT_JSON   = 'data/subito.json';
const OUT_IMGS   = 'data/imgs';
const MAX_ADS    = 14;
const MAX_PHOTOS = 10;
const TIMEOUT_MS = 20_000;

const HEADERS = {
  'User-Agent'     : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  'Accept'         : 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'it-IT,it;q=0.9,en;q=0.8',
  'Referer'        : 'https://www.subito.it/',
};

/* ── Utility ── */
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function get(url) {
  const ctrl = new AbortController();
  const tid  = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: HEADERS, signal: ctrl.signal, redirect: 'follow' });
    clearTimeout(tid);
    if (!res.ok) throw new Error(`HTTP ${res.status} — ${url}`);
    return await res.text();
  } catch (err) {
    clearTimeout(tid);
    throw err;
  }
}

async function downloadImage(url, destPath) {
  if (fs.existsSync(destPath)) return true; // già scaricata
  try {
    const ctrl = new AbortController();
    const tid  = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    const res  = await fetch(url, {
      headers: { ...HEADERS, Referer: 'https://www.subito.it/' },
      signal: ctrl.signal,
    });
    clearTimeout(tid);
    if (!res.ok) throw new Error(`IMG HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 8_000) throw new Error('File troppo piccolo, probabilmente un placeholder');
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.writeFileSync(destPath, buf);
    return true;
  } catch (err) {
    console.warn('  ⚠ Immagine non scaricata:', url, '—', err.message);
    return false;
  }
}

function imgHash(url) {
  return crypto.createHash('md5').update(url).digest('hex').slice(0, 12);
}

function ext(url) {
  const m = url.replace(/[?#].*/, '').match(/\.(jpe?g|png|webp|avif)$/i);
  return m ? m[0] : '.jpg';
}

/* ── Estrai link annunci dalla pagina shop ── */
function extractAdLinks(html) {
  const $ = cheerio.load(html);
  const links = new Set();
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href') || '';
    if (href.match(/subito\.it\/auto\/.+-\d+\.htm/)) links.add(href.split('?')[0]);
    if (links.size >= MAX_ADS) return false;
  });
  return [...links];
}

/* ── Estrai dati da una pagina annuncio ── */
function extractCarData(html, url) {
  const $ = cheerio.load(html);

  // JSON-LD
  let ld = {};
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const parsed = JSON.parse($(el).html());
      const arr = Array.isArray(parsed) ? parsed : [parsed];
      const product = arr.find(o => ['Product','Car','Vehicle'].includes(o?.['@type']));
      if (product) ld = product;
    } catch {}
  });

  const meta = prop => $(`meta[property="${prop}"],meta[name="${prop}"]`).attr('content')?.trim() || '';
  const body = $('body').text();

  // Titolo
  const name = (ld.name || meta('og:title') || $('h1').first().text() || 'Veicolo')
    .replace(/\s*[|·\-]\s*Subito.*$/i, '').trim();

  // Anno
  const year = ld.productionDate
    || body.match(/\b(20\d{2}|199\d)\b/)?.[0]
    || '—';

  // Prezzo
  const rawPrice = ld.offers?.price
    || meta('product:price:amount')
    || body.match(/[\d.,]+\s*€/)?.[0]?.replace(/[€\s.]/g, '').replace(',','.')
    || '—';
  const price = String(rawPrice).replace(/[€\s\.]/g,'').replace(',','.').trim();

  // Carburante
  const fuel = ld.vehicleEngine?.fuelType
    || body.match(/Diesel|Benzina|GPL|Metano|Ibrida\s+Plug[- ]in|Ibrida|Elettrica/i)?.[0]
    || '—';

  // Cambio
  const gear = body.match(/Automatico|Semiautomatico|Manuale/i)?.[0] || '—';

  // Km
  const km = body.match(/\d{1,3}(?:[.,]\d{3})+\s*km/i)?.[0] || '—';

  // Categoria
  const cat = $('[class*="category"],[class*="categoria"]').first().text().trim()
    || meta('og:description').match(/SUV|berlina|familiare|citycar|cabrio|furgone/i)?.[0]
    || 'Auto usata';

  // Immagini — priorità a og:image, poi gallery
  const rawImgs = new Set();
  const ogImg = meta('og:image');
  if (ogImg) rawImgs.add(ogImg);

  // Subito mette le foto in tag <img> con data-src o src
  $('img').each((_, el) => {
    for (const attr of ['data-src','src','data-lazy','data-original']) {
      const v = $(el).attr(attr) || '';
      if (v.includes('sbito.it') || v.includes('subito.it')) rawImgs.add(v.split('?')[0]);
    }
  });

  // Filtra placeholder / icone
  const images = [...rawImgs]
    .filter(u => u.startsWith('http') && !u.match(/logo|icon|avatar|sprite|profile|placeholder|1x1/i))
    .slice(0, MAX_PHOTOS);

  const id = url.match(/(\d+)\.htm/)?.[1] || crypto.randomUUID();

  return { id, name, cat, year, km, fuel, gear, price, url, images };
}

/* ── Main ── */
async function main() {
  console.log('🚗 MV Cars scraper — avvio');
  fs.mkdirSync('data', { recursive: true });

  // 1. Pagina shop
  console.log('📄 Scarico pagina shop…');
  const shopHtml = await get(SHOP_URL);
  const adLinks  = extractAdLinks(shopHtml);
  console.log(`🔗 Trovati ${adLinks.length} annunci`);

  if (!adLinks.length) {
    console.error('❌ Nessun link trovato — interrompo');
    process.exit(1);
  }

  const cars = [];

  for (const url of adLinks) {
    console.log(`  → ${url}`);
    try {
      await sleep(800 + Math.random() * 600); // sii gentile con il server
      const html = await get(url);
      const car  = extractCarData(html, url);

      // 2. Scarica foto localmente
      const localImages = [];
      for (const imgUrl of car.images) {
        const filename = imgHash(imgUrl) + ext(imgUrl);
        const destPath = path.join(OUT_IMGS, car.id, filename);
        const ok = await downloadImage(imgUrl, destPath);
        if (ok) localImages.push(`data/imgs/${car.id}/${filename}`);
      }

      if (!localImages.length) {
        console.warn(`  ⚠ Nessuna foto valida per ${car.name}`);
      }

      cars.push({ ...car, images: localImages });
      console.log(`  ✓ ${car.name} — ${localImages.length} foto — ${car.price}€`);
    } catch (err) {
      console.warn(`  ✗ Saltato: ${err.message}`);
    }
  }

  if (!cars.length) {
    console.error('❌ Nessun annuncio salvato');
    process.exit(1);
  }

  // 3. Scrivi JSON
  const payload = {
    updatedAt: new Date().toISOString(),
    count: cars.length,
    cars,
  };
  fs.writeFileSync(OUT_JSON, JSON.stringify(payload, null, 2), 'utf8');
  console.log(`\n✅ Salvati ${cars.length} annunci in ${OUT_JSON}`);
}

main().catch(err => {
  console.error('💥 Errore fatale:', err);
  process.exit(1);
});
