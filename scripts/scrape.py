#!/usr/bin/env python3
"""
MV Cars — Subito.it scraper
Basato sul tracker Python allegato — usa __NEXT_DATA__ per estrarre annunci e foto.
Salva data/subito.json e scarica le foto in data/imgs/<id>/
"""

import requests
from bs4 import BeautifulSoup
import json
import os
import hashlib
import time
from datetime import datetime

SHOP_URL  = 'https://www.subito.it/annunci-emilia_romagna/vendita/usato/?shp=57262'
SHOP_URL2 = 'https://impresapiu.subito.it/shops/57262-mv-cars'
OUT_JSON  = 'data/subito.json'
OUT_IMGS  = 'data/imgs'
MAX_ADS   = 16
MAX_IMGS  = 8

HEADERS = {
    'User-Agent'      : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
    'Accept'          : 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language' : 'it-IT,it;q=0.9,en;q=0.8',
    'Accept-Encoding' : 'gzip, deflate, br',
    'Sec-Fetch-Dest'  : 'document',
    'Sec-Fetch-Mode'  : 'navigate',
    'Sec-Fetch-Site'  : 'none',
    'Sec-Fetch-User'  : '?1',
    'Upgrade-Insecure-Requests': '1',
}

def log(*args):
    print(datetime.now().strftime('%H:%M:%S'), *args, flush=True)

def img_hash(url):
    return hashlib.md5(url.encode()).hexdigest()[:12]

def img_ext(url):
    url_clean = url.split('?')[0].split('#')[0]
    for ext in ['.jpg', '.jpeg', '.png', '.webp', '.avif']:
        if url_clean.lower().endswith(ext):
            return ext
    return '.jpg'

def download_image(url, dest_path):
    if os.path.exists(dest_path):
        return True
    try:
        headers = {**HEADERS, 'Accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8', 'Referer': 'https://www.subito.it/'}
        r = requests.get(url, headers=headers, timeout=20)
        r.raise_for_status()
        if len(r.content) < 4000:
            log(f'  ⚠ IMG troppo piccola ({len(r.content)}B), skip')
            return False
        os.makedirs(os.path.dirname(dest_path), exist_ok=True)
        with open(dest_path, 'wb') as f:
            f.write(r.content)
        return True
    except Exception as e:
        log(f'  ⚠ IMG skip: {e}')
        return False

def extract_images(product):
    """Estrae le URL delle foto da un prodotto Subito — struttura images[].scale[]"""
    imgs = []
    for img in product.get('images', []):
        scales = img.get('scale', [])
        # Prendi la versione più grande disponibile
        scales_sorted = sorted(scales, key=lambda s: s.get('size', 0), reverse=True)
        uri = next((s.get('uri', '') for s in scales_sorted if s.get('uri', '').startswith('http')), '')
        if not uri:
            uri = img.get('uri', img.get('url', ''))
        if uri.startswith('http'):
            imgs.append(uri.split('?')[0])
        if len(imgs) >= MAX_IMGS:
            break
    return imgs

def clean_price(raw):
    if not raw:
        return '—'
    return str(raw).replace('€', '').replace(' ', '').replace('.', '').strip() or '—'

def normalize_item(product):
    """Normalizza un item Subito in un dict car — stessa logica del tracker Python"""
    if not product:
        return None

    features = product.get('features', {})

    # Prezzo — stesso path del tracker Python: features['/price']['values'][0]['key']
    price_feature = features.get('/price', features.get('price', {}))
    raw_price = None
    if price_feature and 'values' in price_feature:
        raw_price = price_feature['values'][0].get('key') or price_feature['values'][0].get('value')

    def feat(key):
        f = features.get(key) or features.get(key.lstrip('/'))
        if f and 'values' in f:
            return f['values'][0].get('value', '—')
        return '—'

    year  = feat('/anno_immatricolazione') or feat('/anno')
    km    = feat('/chilometraggio') or feat('/km')
    fuel  = feat('/alimentazione') or feat('/carburante')
    gear  = feat('/tipo_di_cambio') or feat('/cambio')
    cat   = (product.get('category') or {}).get('values', [{}])[0].get('value', 'Auto usata')

    url   = product.get('urls', {}).get('default', product.get('url', ''))
    urn   = product.get('urn', '')
    pid   = urn.split(':')[-1] if ':' in urn else str(product.get('id', ''))
    if not pid:
        import uuid
        pid = str(uuid.uuid4())

    name  = product.get('subject', product.get('title', 'Veicolo')).strip()

    return {
        'id'    : pid,
        'name'  : name,
        'cat'   : cat,
        'year'  : year,
        'km'    : km,
        'fuel'  : fuel,
        'gear'  : gear,
        'price' : clean_price(raw_price),
        'url'   : url,
        'images': extract_images(product),
    }

def get_next_data(url):
    """Scarica la pagina e legge __NEXT_DATA__ — identico al tracker Python"""
    r = requests.get(url, headers=HEADERS, timeout=25)
    r.raise_for_status()
    soup = BeautifulSoup(r.text, 'html.parser')
    tag = soup.find('script', id='__NEXT_DATA__')
    if not tag:
        raise ValueError('__NEXT_DATA__ non trovato')
    return json.loads(tag.string)

def strategy_shop():
    log('🔍 Strategia 1: pagina shop standard…')
    nd = get_next_data(SHOP_URL)
    # Stesso path del tracker Python
    items_list = nd['props']['pageProps']['initialState']['items']['list']
    log(f'  → {len(items_list)} item trovati')
    cars = [normalize_item(w.get('item', w)) for w in items_list]
    cars = [c for c in cars if c and c['url']]
    if not cars:
        raise ValueError('Nessun annuncio normalizzato')
    return cars[:MAX_ADS]

def strategy_impresapiu():
    log('🔍 Strategia 2: impresapiu.subito.it…')
    nd = get_next_data(SHOP_URL2)
    # Prova vari path
    items_list = (
        nd.get('props', {}).get('pageProps', {}).get('initialState', {}).get('items', {}).get('list') or
        nd.get('props', {}).get('pageProps', {}).get('ads') or
        nd.get('props', {}).get('pageProps', {}).get('items') or
        []
    )
    log(f'  → {len(items_list)} item trovati')
    cars = [normalize_item(w.get('item', w)) for w in items_list]
    cars = [c for c in cars if c and c['url']]
    if not cars:
        raise ValueError('Nessun annuncio normalizzato')
    return cars[:MAX_ADS]

def strategy_api():
    log('🔍 Strategia 3: API pubblica Subito…')
    url = 'https://api.subito.it/v1/search/ads/?shp=57262&category=4&size=20'
    r = requests.get(url, headers={'User-Agent': HEADERS['User-Agent'], 'Accept': 'application/json'}, timeout=20)
    r.raise_for_status()
    data = r.json()
    ads = data.get('ads') or data.get('data') or []
    if not ads:
        raise ValueError('API array vuoto')
    log(f'  → {len(ads)} annunci via API')
    cars = []
    for ad in ads[:MAX_ADS]:
        imgs = []
        for img in ad.get('images', []):
            scales = sorted(img.get('scale', []), key=lambda s: s.get('size', 0), reverse=True)
            uri = next((s.get('uri','') for s in scales if s.get('uri','').startswith('http')), '')
            if uri:
                imgs.append(uri.split('?')[0])
        urn = ad.get('urn', '')
        pid = urn.split(':')[-1] if ':' in urn else str(ad.get('id', ''))
        cars.append({
            'id'    : pid,
            'name'  : ad.get('subject', 'Veicolo').strip(),
            'cat'   : 'Auto usata',
            'year'  : '—', 'km': '—', 'fuel': '—', 'gear': '—',
            'price' : clean_price(ad.get('price', {}).get('value')),
            'url'   : ad.get('urls', {}).get('default', ''),
            'images': imgs[:MAX_IMGS],
        })
    return [c for c in cars if c['url']]

def main():
    log('🚗 MV Cars scraper Python — avvio')
    os.makedirs('data', exist_ok=True)

    raw_cars = []
    for label, fn in [('Shop standard', strategy_shop), ('Impresapiu', strategy_impresapiu), ('API', strategy_api)]:
        try:
            raw_cars = fn()
            log(f'✓ "{label}" OK — {len(raw_cars)} annunci')
            break
        except Exception as e:
            log(f'✗ "{label}" fallita: {e}')

    if not raw_cars:
        log('❌ Tutte le strategie fallite')
        exit(1)

    # Scarica foto localmente
    cars = []
    for car in raw_cars:
        local_imgs = []
        for img_url in car['images']:
            filename  = img_hash(img_url) + img_ext(img_url)
            dest_path = os.path.join(OUT_IMGS, car['id'], filename)
            ok = download_image(img_url, dest_path)
            if ok:
                local_imgs.append(f"data/imgs/{car['id']}/{filename}")
            time.sleep(0.2)
        log(f"  ✓ {car['name']} — {len(local_imgs)} foto — {car['price']}€")
        cars.append({**car, 'images': local_imgs})

    payload = {'updatedAt': datetime.utcnow().isoformat() + 'Z', 'count': len(cars), 'cars': cars}
    with open(OUT_JSON, 'w', encoding='utf-8') as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)

    log(f'\n✅ {len(cars)} annunci salvati → {OUT_JSON}')

if __name__ == '__main__':
    main()
