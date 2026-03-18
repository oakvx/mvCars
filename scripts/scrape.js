/**
 * MV Cars — Subito.it scraper v3
 * Legge __NEXT_DATA__ dalla pagina shop (come fa il tracker Python allegato)
 * Una sola richiesta HTTP → tutti gli annunci + foto. Niente API, niente CORS.
 */

import fetch from 'node-fetch';
import * as cheerio from 'cheerio';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

/* ── Config ── */
const SHOP_URL  = 'https://www.subito.it/annunci-emilia_romagna/vendita/usato/?shp=57262';
const SHOP_URL2 = 'https://impresapiu.subito.it/shops/57262-mv-cars';
const OUT_JSON  = 'data/subito.json';
const OUT_IMGS  = 'data/imgs';
const MAX_ADS   = 16;
const MAX_IMGS  = 8;
const TIMEOUT   = 25_000;

const HEADERS = {
  'User-Agent'      : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
  'Accept'          : 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language' : 'it-IT,it;q=0.9,en;q=0.8',
  'Accept-Encoding' : 'gzip, deflate, br',
  'Sec-Fetch-Dest'  : 'document',
  'Sec-Fetch-Mode'  : 'navigate',
  'Sec-Fetch-Site'  : 'none',
  'Sec-Fetch-User'  : '?1',
  'Upgrade-Insecure-Requests': '1',
};

/* ── Utility ── */
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log   = (...a) => console.log(new Date().toISOString().slice(11,19), ...a);

async function httpGet(url) {
  const ctrl = new AbortController();
  const tid  = setTimeout(() => ctrl.abort(), TIMEOUT);
  try {
    const res = await fetch(url, { headers: HEADERS, signal: ctrl.signal, redirect: 'follow' });
    clearTimeout(tid);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } catch(e) { clearTimeout(tid); throw e; }
}

function imgHash(url) {
  return crypto.createHash('md5').update(url).digest('hex').slice(0, 12);
}
function imgExt(url) {
  const m = url.replace(/[?#].*/, '').match(/\.(jpe?g|png|webp|avif)$/i);
  return m ? m[0].toLowerCase() : '.jpg';
}

async function downloadImage(url, destPath) {
  if (fs.existsSync(destPath)) { log('  ↩ Già scaricata:', path.basename(destPath)); return true; }
  try {
    const ctrl = new AbortController();
    const tid  = setTimeout(() => ctrl.abort(), TIMEOUT);
    const res  = await fetch(url, {
      headers: { ...HEADERS, Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8', Referer: 'https://www.subito.it/' },
      signal: ctrl.signal,
    });
    clearTimeout(tid);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 4_000) throw new Error(`Troppo piccola: ${buf.length}B`);
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.writeFileSync(destPath, buf);
    return true;
  } catch(e) {
    log('  ⚠ IMG skip:', e.message);
    return false;
  }
}

function cleanPrice(raw) {
  if (raw == null) return '—';
  return String(raw).replace(/[€\s]/g,'').replace(/\.(?=\d{3})/g,'').trim() || '—';
}

/* ────────────────────────────────────────
   Estrai __NEXT_DATA__ da una pagina HTML
   (identico all'approccio del tracker Python)
   ──────────────────────────────────────── */
function parseNextData(html) {
  const $ = cheerio.load(html);
  const tag = $('script#__NEXT_DATA__');
  if (!tag.length) throw new Error('__NEXT_DATA__ non trovato');
  return JSON.parse(tag.html());
}

/* ────────────────────────────────────────
   Estrai immagini da un prodotto Subito
   I dati sono dentro product.images[] con
   scale[] per le varie dimensioni
   ──────────────────────────────────────── */
function extractImages(product) {
  const imgs = [];

  // Struttura principale: product.images[].scale[].uri
  const rawImages = product.images ?? product.photos ?? [];
  for (const img of rawImages) {
    const scales = img.scale ?? img.sizes ?? [];
    // Prendi la dimensione più grande
    const best = scales.sort((a,b) => (b.size||0) - (a.size||0))[0];
    const uri  = best?.uri || best?.url || img.uri || img.url || '';
    if (uri.startsWith('http')) imgs.push(uri.split('?')[0]);
    if (imgs.length >= MAX_IMGS) break;
  }

  // Fallback: immagine singola
  if (!imgs.length) {
    const single = product.image || product.thumbnail || '';
    if (single.startsWith('http')) imgs.push(single.split('?')[0]);
  }

  return imgs;
}

/* ────────────────────────────────────────
   Normalizza un item Subito → car object
   ──────────────────────────────────────── */
function normalizeItem(product) {
  if (!product) return null;

  // Stessa struttura usata dal tracker Python
  const features = product.features ?? {};

  // Prezzo
  const priceFeature = features['/price'] ?? features['price'];
  const rawPrice = priceFeature?.values?.[0]?.key ?? priceFeature?.values?.[0]?.value;

  // Features auto
  const feat = key => {
    const f = features[key] || features[key.replace('/','')];
    return f?.values?.[0]?.value ?? '—';
  };

  const year  = feat('/anno_immatricolazione') || feat('/anno') || '—';
  const km    = feat('/chilometraggio') || feat('/km') || '—';
  const fuel  = feat('/alimentazione') || feat('/carburante') || '—';
  const gear  = feat('/tipo_di_cambio') || feat('/cambio') || '—';
  const cat   = product.category?.values?.[0]?.value || 'Auto usata';

  const url  = product.urls?.default || product.url || '';
  const id   = product.urn?.split(':').pop() || String(product.id || crypto.randomUUID());
  const name = (product.subject || product.title || 'Veicolo')
    .replace(/\s*[|·\-]\s*Subito.*$/i,'').trim();

  return {
    id, name, cat, year, km, fuel, gear,
    price: cleanPrice(rawPrice),
    url,
    images: extractImages(product),
  };
}

/* ════════════════════════════════════════
   STRATEGIA 1 — Pagina shop standard
   (www.subito.it con ?shp=57262)
   ════════════════════════════════════════ */
async function strategyShopPage() {
  log('🔍 Strategia 1: pagina shop standard…');
  const html = await httpGet(SHOP_URL);
  const nd   = parseNextData(html);

  // Stesso path usato dal tracker Python
  const list = nd?.props?.pageProps?.initialState?.items?.list ?? [];
  log(`  → ${list.length} item in initialState.items.list`);

  if (!list.length) throw new Error('Lista vuota in __NEXT_DATA__');

  const cars = list
    .map(wrapper => normalizeItem(wrapper?.item ?? wrapper))
    .filter(c => c && c.url);

  if (!cars.length) throw new Error('Nessun annuncio normalizzato');
  return cars.slice(0, MAX_ADS);
}

/* ════════════════════════════════════════
   STRATEGIA 2 — Pagina impresapiu
   ════════════════════════════════════════ */
async function strategyImpresapiu() {
  log('🔍 Strategia 2: impresapiu.subito.it…');
  const html = await httpGet(SHOP_URL2);
  const nd   = parseNextData(html);

  // Prova vari path comuni di Next.js
  const list =
    nd?.props?.pageProps?.initialState?.items?.list ??
    nd?.props?.pageProps?.ads ??
    nd?.props?.pageProps?.items ??
    [];

  log(`  → ${list.length} item trovati`);
  if (!list.length) throw new Error('Lista vuota');

  const cars = list
    .map(wrapper => normalizeItem(wrapper?.item ?? wrapper))
    .filter(c => c && c.url);

  if (!cars.length) throw new Error('Nessun annuncio normalizzato');
  return cars.slice(0, MAX_ADS);
}

/* ════════════════════════════════════════
   STRATEGIA 3 — API pubblica Subito
   ════════════════════════════════════════ */
async function strategyAPI() {
  log('🔍 Strategia 3: API pubblica…');
  const url = 'https://api.subito.it/v1/search/ads/?shp=57262&category=4&size=20';
  const res  = await fetch(url, { headers: { 'User-Agent': HEADERS['User-Agent'], Accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  const ads  = json?.ads ?? json?.data ?? [];
  if (!ads.length) throw new Error('API array vuoto');
  log(`  → ${ads.length} annunci via API`);

  return ads.slice(0, MAX_ADS).map(ad => {
    const images = (ad.images ?? [])
      .flatMap(img => (img.scale ?? []).sort((a,b)=>(b.size||0)-(a.size||0)).slice(0,1).map(s=>s.uri||''))
      .filter(u => u.startsWith('http'))
      .slice(0, MAX_IMGS);

    return {
      id   : String(ad.urn?.split(':').pop() || ad.id || crypto.randomUUID()),
      name : (ad.subject || 'Veicolo').trim(),
      cat  : ad.category?.values?.[0]?.value || 'Auto usata',
      year : '—', km: '—', fuel: '—', gear: '—',
      price: cleanPrice(ad.price?.value),
      url  : ad.urls?.default || '',
      images,
    };
  }).filter(c => c.url);
}

/* ════════════════════════════════════════
   MAIN
   ════════════════════════════════════════ */
async function main() {
  log('🚗 MV Cars scraper v3');
  fs.mkdirSync('data', { recursive: true });

  let rawCars = [];
  for (const [label, fn] of [
    ['Shop standard', strategyShopPage],
    ['Impresapiu',    strategyImpresapiu],
    ['API pubblica',  strategyAPI],
  ]) {
    try {
      rawCars = await fn();
      log(`✓ "${label}" OK — ${rawCars.length} annunci`);
      break;
    } catch(e) {
      log(`✗ "${label}" fallita: ${e.message}`);
    }
  }

  if (!rawCars.length) {
    log('❌ Tutte le strategie fallite');
    process.exit(1);
  }

  // Scarica foto localmente (niente hotlink block su GitHub Pages)
  const cars = [];
  for (const car of rawCars) {
    const localImgs = [];
    for (const imgUrl of car.images) {
      const filename = imgHash(imgUrl) + imgExt(imgUrl);
      const dest     = path.join(OUT_IMGS, car.id, filename);
      const ok       = await downloadImage(imgUrl, dest);
      if (ok) localImgs.push(`data/imgs/${car.id}/${filename}`);
      await sleep(150);
    }
    log(`  ✓ ${car.name} — ${localImgs.length} foto — ${car.price}€`);
    cars.push({ ...car, images: localImgs });
  }

  fs.writeFileSync(OUT_JSON, JSON.stringify({
    updatedAt: new Date().toISOString(),
    count: cars.length,
    cars,
  }, null, 2), 'utf8');

  log(`\n✅ ${cars.length} annunci salvati → ${OUT_JSON}`);
}

main().catch(e => { console.error('💥', e.message); process.exit(1); });
