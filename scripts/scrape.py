#!/usr/bin/env python3
"""
MV Cars — Subito.it scraper
Basato sul tracker Python allegato — usa __NEXT_DATA__ quando disponibile,
e fa fallback a richieste browser-like e al Reader proxy di Jina.
Salva data/subito.json e scarica le foto in data/imgs/<id>/
"""

import hashlib
import json
import os
import re
import time
from datetime import datetime
from urllib.parse import urlparse

import requests
from bs4 import BeautifulSoup
from curl_cffi import requests as curl_requests

SHOP_URL = 'https://www.subito.it/annunci-emilia_romagna/vendita/usato/?shp=57262'
SHOP_URL2 = 'https://impresapiu.subito.it/shops/57262-mv-cars'
OUT_JSON = 'data/subito.json'
OUT_IMGS = 'data/imgs'
MAX_ADS = 16
MAX_IMGS = 8
JINA_PROXY_PREFIX = 'https://r.jina.ai/http://'

HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'it-IT,it;q=0.9,en;q=0.8',
    'Accept-Encoding': 'gzip, deflate, br',
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
    'Upgrade-Insecure-Requests': '1',
}

JSON_HEADERS = {
    'User-Agent': HEADERS['User-Agent'],
    'Accept': 'application/json,text/plain;q=0.9,*/*;q=0.8',
    'Accept-Language': HEADERS['Accept-Language'],
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache',
}

DIRECT_TIMEOUT = 25
PROXY_TIMEOUT = 40


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


def jina_proxy_url(url):
    return JINA_PROXY_PREFIX + url.replace('https://', '').replace('http://', '')


def new_requests_session():
    session = requests.Session()
    session.trust_env = False
    return session


def direct_get(url, headers=None, timeout=DIRECT_TIMEOUT):
    last_error = None

    try:
        response = curl_requests.get(
            url,
            headers=headers or HEADERS,
            timeout=timeout,
            impersonate='chrome',
        )
        response.raise_for_status()
        return response.text, 'curl_cffi'
    except Exception as exc:
        last_error = exc

    try:
        response = new_requests_session().get(url, headers=headers or HEADERS, timeout=timeout)
        response.raise_for_status()
        return response.text, 'requests'
    except Exception as exc:
        last_error = exc

    raise last_error


def proxy_get(url, timeout=PROXY_TIMEOUT):
    proxy_url = jina_proxy_url(url)
    response = requests.get(
        proxy_url,
        headers={'Accept': 'text/plain,text/html;q=0.9,*/*;q=0.8', 'User-Agent': HEADERS['User-Agent']},
        timeout=timeout,
    )
    response.raise_for_status()
    return response.text, 'jina'


def fetch_text(url, headers=None):
    try:
        return direct_get(url, headers=headers)
    except Exception as direct_error:
        log(f'  ↪ direct fetch fallita per {url}: {direct_error}')
        try:
            return proxy_get(url)
        except Exception as proxy_error:
            raise RuntimeError(f'direct={direct_error} | proxy={proxy_error}') from proxy_error


def download_image(url, dest_path):
    if os.path.exists(dest_path):
        return True
    try:
        headers = {
            **HEADERS,
            'Accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
            'Referer': 'https://www.subito.it/',
        }
        try:
            response = curl_requests.get(
                url,
                headers=headers,
                timeout=20,
                impersonate='chrome',
            )
            response.raise_for_status()
            data = response.content
        except Exception:
            response = new_requests_session().get(url, headers=headers, timeout=20)
            response.raise_for_status()
            data = response.content
        if len(data) < 4000:
            log(f'  ⚠ IMG troppo piccola ({len(data)}B), skip')
            return False
        os.makedirs(os.path.dirname(dest_path), exist_ok=True)
        with open(dest_path, 'wb') as file_handle:
            file_handle.write(data)
        return True
    except Exception as exc:
        log(f'  ⚠ IMG skip: {exc}')
        return False


def extract_images(product):
    imgs = []
    for img in product.get('images', []):
        scales = img.get('scale', [])
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


def feature_value(features, key, default='—'):
    feature = features.get(key) or features.get(key.lstrip('/'))
    if feature and 'values' in feature and feature['values']:
        return feature['values'][0].get('value', default)
    return default


def normalize_item(product):
    if not product:
        return None

    features = product.get('features', {})
    price_feature = features.get('/price', features.get('price', {}))
    raw_price = None
    if price_feature and 'values' in price_feature and price_feature['values']:
        raw_price = price_feature['values'][0].get('key') or price_feature['values'][0].get('value')

    year = feature_value(features, '/anno_immatricolazione')
    if year == '—':
        year = feature_value(features, '/anno')
    km = feature_value(features, '/chilometraggio')
    if km == '—':
        km = feature_value(features, '/km')
    fuel = feature_value(features, '/alimentazione')
    if fuel == '—':
        fuel = feature_value(features, '/carburante')
    gear = feature_value(features, '/tipo_di_cambio')
    if gear == '—':
        gear = feature_value(features, '/cambio')
    cat = (product.get('category') or {}).get('values', [{}])[0].get('value', 'Auto usata')

    url = product.get('urls', {}).get('default', product.get('url', ''))
    urn = product.get('urn', '')
    pid = urn.split(':')[-1] if ':' in urn else str(product.get('id', ''))
    if not pid:
        pid = hashlib.md5((url or product.get('subject', 'vehicle')).encode()).hexdigest()[:12]

    name = product.get('subject', product.get('title', 'Veicolo')).strip()

    return {
        'id': pid,
        'name': name,
        'cat': cat,
        'year': year,
        'km': km,
        'fuel': fuel,
        'gear': gear,
        'price': clean_price(raw_price),
        'url': url,
        'images': extract_images(product),
    }


def extract_next_data_payload(raw_text):
    soup = BeautifulSoup(raw_text, 'html.parser')
    tag = soup.find('script', id='__NEXT_DATA__')
    if not tag or not tag.string:
        return None
    return json.loads(tag.string)


def get_next_data(url):
    raw_text, source = fetch_text(url, headers=HEADERS)
    payload = extract_next_data_payload(raw_text)
    if payload:
        return payload, source
    raise ValueError(f'__NEXT_DATA__ non trovato ({source})')


def extract_items_from_next_data(payload):
    return (
        payload.get('props', {}).get('pageProps', {}).get('initialState', {}).get('items', {}).get('list')
        or payload.get('props', {}).get('pageProps', {}).get('ads')
        or payload.get('props', {}).get('pageProps', {}).get('items')
        or []
    )


def strategy_shop():
    log('🔍 Strategia 1: pagina shop standard…')
    nd, source = get_next_data(SHOP_URL)
    items_list = extract_items_from_next_data(nd)
    log(f'  → {len(items_list)} item trovati via {source}')
    cars = [normalize_item(wrapper.get('item', wrapper)) for wrapper in items_list]
    cars = [car for car in cars if car and car['url']]
    if not cars:
        raise ValueError('Nessun annuncio normalizzato')
    return cars[:MAX_ADS]


def strategy_impresapiu():
    log('🔍 Strategia 2: impresapiu.subito.it…')
    nd, source = get_next_data(SHOP_URL2)
    items_list = extract_items_from_next_data(nd)
    log(f'  → {len(items_list)} item trovati via {source}')
    cars = [normalize_item(wrapper.get('item', wrapper)) for wrapper in items_list]
    cars = [car for car in cars if car and car['url']]
    if not cars:
        raise ValueError('Nessun annuncio normalizzato')
    return cars[:MAX_ADS]


def strategy_api():
    log('🔍 Strategia 3: API pubblica Subito…')
    url = 'https://api.subito.it/v1/search/ads/?shp=57262&category=4&size=20'
    raw_text, source = fetch_text(url, headers=JSON_HEADERS)
    data = json.loads(raw_text)
    ads = data.get('ads') or data.get('data') or []
    if not ads:
        raise ValueError('API array vuoto')
    log(f'  → {len(ads)} annunci via API ({source})')
    cars = []
    for ad in ads[:MAX_ADS]:
        imgs = []
        for img in ad.get('images', []):
            scales = sorted(img.get('scale', []), key=lambda s: s.get('size', 0), reverse=True)
            uri = next((s.get('uri', '') for s in scales if s.get('uri', '').startswith('http')), '')
            if uri:
                imgs.append(uri.split('?')[0])
        urn = ad.get('urn', '')
        pid = urn.split(':')[-1] if ':' in urn else str(ad.get('id', ''))
        cars.append({
            'id': pid,
            'name': ad.get('subject', 'Veicolo').strip(),
            'cat': 'Auto usata',
            'year': '—',
            'km': '—',
            'fuel': '—',
            'gear': '—',
            'price': clean_price(ad.get('price', {}).get('value')),
            'url': ad.get('urls', {}).get('default', ''),
            'images': imgs[:MAX_IMGS],
        })
    return [car for car in cars if car['url']]


def extract_reader_links(text):
    links = []
    seen = set()
    for match in re.finditer(r'https?://[^\s)\]>]+', text):
        url = match.group(0).rstrip('.,;')
        if '/auto/' not in url:
            continue
        if url in seen:
            continue
        seen.add(url)
        links.append(url)
        if len(links) >= MAX_ADS:
            break
    return links


def extract_reader_images(text):
    images = []
    seen = set()
    for match in re.finditer(r'https?://[^\s)\]>]+(?:jpg|jpeg|png|webp|avif)(?:\?[^\s)\]>]+)?', text, re.IGNORECASE):
        url = match.group(0).rstrip('.,;')
        if url in seen:
            continue
        seen.add(url)
        images.append(url)
        if len(images) >= MAX_IMGS:
            break
    return images


def infer_price(text):
    match = re.search(r'\b\d{1,3}(?:[\.,]\d{3})+(?:,\d{2})?\s*€', text)
    if match:
        return clean_price(match.group(0))
    return '—'


def infer_year(text):
    match = re.search(r'\b(19\d{2}|20\d{2})\b', text)
    return match.group(1) if match else '—'


def infer_km(text):
    match = re.search(r'\b\d{1,3}(?:[\.,]\d{3})+\s*km\b', text, re.IGNORECASE)
    return match.group(0) if match else '—'


def infer_fuel(text):
    match = re.search(r'Diesel|Benzina|GPL|Metano|Ibrida|Elettrica', text, re.IGNORECASE)
    return match.group(0) if match else '—'


def infer_gear(text):
    match = re.search(r'Manuale|Automatico|Semiautomatico', text, re.IGNORECASE)
    return match.group(0) if match else '—'


def infer_title(text, url):
    parsed = urlparse(url)
    slug = parsed.path.rsplit('/', 1)[-1].replace('.htm', '')
    slug = re.sub(r'-\d+$', '', slug).replace('-', ' ').strip()
    for line in text.splitlines():
        candidate = line.strip(' #-*\t')
        if len(candidate) < 12:
            continue
        if 'subito' in candidate.lower():
            continue
        if parsed.netloc in candidate:
            continue
        return candidate
    return slug.title() or 'Veicolo'


def reader_car_from_text(url, text):
    return {
        'id': re.search(r'(\d+)\.htm', url).group(1) if re.search(r'(\d+)\.htm', url) else hashlib.md5(url.encode()).hexdigest()[:12],
        'name': infer_title(text, url),
        'cat': 'Auto usata',
        'year': infer_year(text),
        'km': infer_km(text),
        'fuel': infer_fuel(text),
        'gear': infer_gear(text),
        'price': infer_price(text),
        'url': url,
        'images': extract_reader_images(text),
    }


def strategy_reader_proxy():
    log('🔍 Strategia 4: Reader proxy (r.jina.ai)…')
    shop_text, _ = proxy_get(SHOP_URL2)
    ad_links = extract_reader_links(shop_text)
    log(f'  → {len(ad_links)} link annunci trovati via reader proxy')
    if not ad_links:
        raise ValueError('Nessun link annuncio trovato nel reader proxy')

    cars = []
    for ad_url in ad_links[:MAX_ADS]:
        try:
            ad_text, _ = proxy_get(ad_url)
            car = reader_car_from_text(ad_url, ad_text)
            if car['url']:
                cars.append(car)
        except Exception as exc:
            log(f'  ⚠ Annuncio saltato {ad_url}: {exc}')

    cars = [car for car in cars if car and car['url']]
    if not cars:
        raise ValueError('Reader proxy senza annunci validi')
    return cars[:MAX_ADS]


def main():
    log('🚗 MV Cars scraper Python — avvio')
    os.makedirs('data', exist_ok=True)

    raw_cars = []
    strategies = [
        ('Shop standard', strategy_shop),
        ('Impresapiu', strategy_impresapiu),
        ('API', strategy_api),
        ('Reader proxy', strategy_reader_proxy),
    ]

    for label, func in strategies:
        try:
            raw_cars = func()
            log(f'✓ "{label}" OK — {len(raw_cars)} annunci')
            break
        except Exception as exc:
            log(f'✗ "{label}" fallita: {exc}')

    if not raw_cars:
        log('❌ Tutte le strategie fallite')
        raise SystemExit(1)

    cars = []
    for car in raw_cars:
        local_imgs = []
        for img_url in car['images']:
            filename = img_hash(img_url) + img_ext(img_url)
            dest_path = os.path.join(OUT_IMGS, car['id'], filename)
            ok = download_image(img_url, dest_path)
            if ok:
                local_imgs.append(f'data/imgs/{car["id"]}/{filename}')
            time.sleep(0.2)
        log(f'  ✓ {car["name"]} — {len(local_imgs)} foto — {car["price"]}€')
        cars.append({**car, 'images': local_imgs})

    payload = {'updatedAt': datetime.utcnow().isoformat() + 'Z', 'count': len(cars), 'cars': cars}
    with open(OUT_JSON, 'w', encoding='utf-8') as file_handle:
        json.dump(payload, file_handle, ensure_ascii=False, indent=2)

    log(f'\n✅ {len(cars)} annunci salvati → {OUT_JSON}')


if __name__ == '__main__':
    main()
