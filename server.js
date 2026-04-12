const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { buildAdminUser, verifyPassword } = require('./lib/auth');
const {
  ADMIN_FILE,
  ROOT_DIR,
  ensureAdminUser,
  ensureCarsFile,
  ensureUploadsDir,
  readAdminUser,
  readCarsStore,
  UPLOADS_DIR,
  writeAdminUser,
  writeCarsStore
} = require('./lib/storage');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const BODY_LIMIT_BYTES = 1024 * 1024;
const UPLOAD_BODY_LIMIT_BYTES = 15 * 1024 * 1024;
const SESSION_COOKIE = 'mvCarsSession';
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const MAX_LOGIN_ATTEMPTS = 5;
const AVAILABLE_STATUSES = new Set(['disponibile', 'in_trattativa', 'venduta']);

const sessions = new Map();
const loginAttempts = new Map();

ensureCarsFile();
ensureAdminUser(console);

function nowIso() {
  return new Date().toISOString();
}

function slugify(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function escapeRegex(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseCookies(cookieHeader = '') {
  return cookieHeader
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .reduce((accumulator, chunk) => {
      const separatorIndex = chunk.indexOf('=');
      if (separatorIndex === -1) {
        return accumulator;
      }

      const key = chunk.slice(0, separatorIndex).trim();
      const value = chunk.slice(separatorIndex + 1).trim();
      accumulator[key] = decodeURIComponent(value);
      return accumulator;
    }, {});
}

function cleanupSessions() {
  const now = Date.now();

  for (const [token, session] of sessions.entries()) {
    if (!session || session.expiresAt <= now) {
      sessions.delete(token);
    }
  }

  for (const [ip, entry] of loginAttempts.entries()) {
    if (!entry || now - entry.firstAttemptAt > LOGIN_WINDOW_MS) {
      loginAttempts.delete(ip);
    }
  }
}

function createSession(username) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, {
    username,
    createdAt: Date.now(),
    expiresAt: Date.now() + SESSION_TTL_MS
  });
  return token;
}

function getSessionFromRequest(request) {
  cleanupSessions();
  const cookies = parseCookies(request.headers.cookie);
  const token = cookies[SESSION_COOKIE];
  if (!token) {
    return null;
  }

  const session = sessions.get(token);
  if (!session) {
    return null;
  }

  if (session.expiresAt <= Date.now()) {
    sessions.delete(token);
    return null;
  }

  return { token, ...session };
}

function clearSession(token) {
  if (token) {
    sessions.delete(token);
  }
}

function jsonHeaders(extraHeaders = {}) {
  return {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
    ...extraHeaders
  };
}

function sendJson(response, statusCode, payload, extraHeaders = {}) {
  response.writeHead(statusCode, jsonHeaders(extraHeaders));
  response.end(JSON.stringify(payload));
}

function sendError(response, statusCode, message) {
  sendJson(response, statusCode, { ok: false, error: message });
}

function sendEmpty(response, statusCode, extraHeaders = {}) {
  response.writeHead(statusCode, {
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders
  });
  response.end();
}

function readRequestBody(request, limitBytes = BODY_LIMIT_BYTES) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let raw = '';

    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      size += Buffer.byteLength(chunk);
      if (size > limitBytes) {
        reject(new Error('Payload troppo grande.'));
        request.destroy();
        return;
      }
      raw += chunk;
    });
    request.on('end', () => {
      if (!raw) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('JSON non valido.'));
      }
    });
    request.on('error', reject);
  });
}

function isAllowedPathUrl(value) {
  return /^(\/|\.\/|\.\.\/)/.test(String(value || ''));
}

function normalizeUrl(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed) {
    return '';
  }

  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }

  if (isAllowedPathUrl(trimmed)) {
    return trimmed;
  }

  return '';
}

function normalizeImageList(value) {
  const source = Array.isArray(value)
    ? value
    : String(value || '')
        .split(/\r?\n/)
        .map((item) => item.trim())
        .filter(Boolean);

  return source
    .map((item) => {
      if (typeof item === 'string') {
        const src = normalizeUrl(item);
        return src ? { src } : null;
      }

      if (!item || typeof item !== 'object') {
        return null;
      }

      const src = normalizeUrl(item.src || item.lightboxSrc || '');
      if (!src) {
        return null;
      }

      const lightboxSrc = normalizeUrl(item.lightboxSrc || '');
      return lightboxSrc && lightboxSrc !== src
        ? { src, lightboxSrc }
        : { src };
    })
    .filter(Boolean);
}

function normalizeStatus(value, fallbackValue = 'disponibile') {
  const normalized = String(value ?? fallbackValue)
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_');

  return AVAILABLE_STATUSES.has(normalized) ? normalized : fallbackValue;
}

function statusLabel(status) {
  switch (normalizeStatus(status)) {
    case 'in_trattativa':
      return 'In trattativa';
    case 'venduta':
      return 'Venduta';
    default:
      return 'Disponibile';
  }
}

function getManagedUploadFileName(value) {
  const match = String(value || '').match(/^\/data\/uploads\/([^/?#]+)$/i);
  if (!match) {
    return null;
  }

  return decodeURIComponent(match[1]);
}

function collectManagedUploadFileNames(cars) {
  const referencedFiles = new Set();

  (Array.isArray(cars) ? cars : []).forEach((car) => {
    normalizeImageList(car?.images || []).forEach((image) => {
      const fileName = getManagedUploadFileName(image?.src || image?.lightboxSrc || '');
      if (fileName) {
        referencedFiles.add(fileName);
      }
    });
  });

  return referencedFiles;
}

function cleanupUnusedUploads(cars) {
  if (!fs.existsSync(UPLOADS_DIR)) {
    return;
  }

  const referencedFiles = collectManagedUploadFileNames(cars);
  const filesOnDisk = fs.readdirSync(UPLOADS_DIR);

  filesOnDisk.forEach((fileName) => {
    if (referencedFiles.has(fileName)) {
      return;
    }

    const absolutePath = path.join(UPLOADS_DIR, fileName);
    if (fs.existsSync(absolutePath) && fs.statSync(absolutePath).isFile()) {
      fs.unlinkSync(absolutePath);
    }
  });

  const remaining = fs.existsSync(UPLOADS_DIR) ? fs.readdirSync(UPLOADS_DIR) : [];
  if (!remaining.length) {
    fs.rmdirSync(UPLOADS_DIR, { recursive: false });
  }
}

function persistCarsStore(cars) {
  const nextStore = writeCarsStore({ cars });
  cleanupUnusedUploads(nextStore.cars);
  return nextStore;
}

function inferExtension(fileName = '', mimeType = '') {
  const normalizedName = String(fileName || '').toLowerCase();
  const normalizedMime = String(mimeType || '').toLowerCase();

  if (normalizedName.endsWith('.png') || normalizedMime === 'image/png') {
    return '.png';
  }

  if (normalizedName.endsWith('.webp') || normalizedMime === 'image/webp') {
    return '.webp';
  }

  if (normalizedName.endsWith('.gif') || normalizedMime === 'image/gif') {
    return '.gif';
  }

  if (normalizedName.endsWith('.jpeg') || normalizedName.endsWith('.jpg') || normalizedMime === 'image/jpeg') {
    return '.jpg';
  }

  return '.jpg';
}

function saveUploadedImage(file) {
  if (!file || typeof file !== 'object') {
    throw new Error('File immagine non valido.');
  }

  const name = String(file.name || 'foto').trim();
  const mimeType = String(file.type || '').trim();
  const dataUrl = String(file.dataUrl || '').trim();

  if (!/^image\//i.test(mimeType)) {
    throw new Error(`"${name}" non è un file immagine supportato.`);
  }

  const match = dataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
  if (!match) {
    throw new Error(`"${name}" non contiene dati immagine validi.`);
  }

  const payloadMimeType = match[1];
  const base64Content = match[2];
  const buffer = Buffer.from(base64Content, 'base64');

  if (!buffer.length) {
    throw new Error(`"${name}" è vuoto.`);
  }

  if (buffer.length > 5 * 1024 * 1024) {
    throw new Error(`"${name}" supera il limite di 5 MB.`);
  }

  ensureUploadsDir();

  const extension = inferExtension(name, payloadMimeType || mimeType);
  const safeStem = slugify(path.basename(name, path.extname(name))) || 'foto';
  const fileName = `${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}-${safeStem}${extension}`;
  const absolutePath = path.join(UPLOADS_DIR, fileName);

  fs.writeFileSync(absolutePath, buffer);

  return {
    src: `/data/uploads/${fileName}`
  };
}

function normalizeBoolean(value, fallbackValue = false) {
  if (value === undefined) {
    return fallbackValue;
  }

  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'number') {
    return value === 1;
  }

  const normalized = String(value).trim().toLowerCase();
  return ['1', 'true', 'on', 'yes', 'si'].includes(normalized);
}

function clientIp(request) {
  const forwarded = request.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0].trim();
  }

  return request.socket.remoteAddress || 'local';
}

function isRateLimited(ipAddress) {
  const entry = loginAttempts.get(ipAddress);
  if (!entry) {
    return false;
  }

  if (Date.now() - entry.firstAttemptAt > LOGIN_WINDOW_MS) {
    loginAttempts.delete(ipAddress);
    return false;
  }

  return entry.count >= MAX_LOGIN_ATTEMPTS;
}

function registerFailedLogin(ipAddress) {
  const entry = loginAttempts.get(ipAddress);

  if (!entry || Date.now() - entry.firstAttemptAt > LOGIN_WINDOW_MS) {
    loginAttempts.set(ipAddress, {
      count: 1,
      firstAttemptAt: Date.now()
    });
    return;
  }

  entry.count += 1;
}

function clearFailedLogins(ipAddress) {
  loginAttempts.delete(ipAddress);
}

function formatPublicCar(car) {
  const images = normalizeImageList(car.images);
  const status = normalizeStatus(car.status, 'disponibile');
  const badge = String(car.badge || '').trim() || statusLabel(status);

  return {
    id: String(car.id || '').trim(),
    createdAt: car.createdAt || null,
    updatedAt: car.updatedAt || null,
    published: car.published !== false,
    status,
    badge,
    make: String(car.make || '').trim(),
    title: String(car.title || '').trim(),
    name: String(car.name || '').trim(),
    year: String(car.year || '').trim(),
    km: String(car.km || '').trim(),
    fuel: String(car.fuel || '').trim(),
    gear: String(car.gear || '').trim(),
    price: String(car.price || '').trim(),
    url: normalizeUrl(car.url),
    ctaLabel: String(car.ctaLabel || '').trim(),
    images,
    imgUrl: images[0]?.src || '',
    imgSrcSet: '',
    lightboxSrc: images[0]?.lightboxSrc || ''
  };
}

function getPublicInventory() {
  const store = readCarsStore();
  const cars = store.cars
    .filter((car) => car && car.published !== false)
    .map(formatPublicCar);

  return {
    ok: true,
    updatedAt: store.updatedAt,
    count: cars.length,
    cars
  };
}

function normalizeCarPayload(payload, currentCar = {}) {
  const make = String(payload.make ?? currentCar.make ?? '').trim();
  const title = String(payload.title ?? currentCar.title ?? '').trim();
  const rawName = String(payload.name ?? currentCar.name ?? '').trim();
  const name = rawName || [make, title].filter(Boolean).join(' ').trim();

  if (!name) {
    throw new Error('Inserisci almeno marca e titolo della vettura.');
  }

  const derivedMake = make || name.split(/\s+/)[0] || 'Auto';
  const derivedTitle = title || name.replace(new RegExp(`^${escapeRegex(derivedMake)}\\s*`, 'i'), '').trim() || name;
  const now = nowIso();

  return {
    id: String(currentCar.id || payload.id || `${slugify(name)}-${Date.now().toString(36)}`).trim(),
    createdAt: currentCar.createdAt || now,
    updatedAt: now,
    published: normalizeBoolean(payload.published, currentCar.published !== false),
    status: normalizeStatus(payload.status ?? currentCar.status ?? 'disponibile'),
    badge: String(payload.badge ?? currentCar.badge ?? '').trim(),
    make: derivedMake,
    title: derivedTitle,
    name,
    year: String(payload.year ?? currentCar.year ?? '').trim(),
    km: String(payload.km ?? currentCar.km ?? '').trim(),
    fuel: String(payload.fuel ?? currentCar.fuel ?? '').trim(),
    gear: String(payload.gear ?? currentCar.gear ?? '').trim(),
    price: String(payload.price ?? currentCar.price ?? '').trim(),
    url: normalizeUrl(payload.url ?? currentCar.url ?? ''),
    ctaLabel: String(payload.ctaLabel ?? currentCar.ctaLabel ?? '').trim(),
    privateNotes: String(payload.privateNotes ?? currentCar.privateNotes ?? '').trim(),
    images: normalizeImageList(payload.images ?? currentCar.images ?? [])
  };
}

function getAdminInventory() {
  const store = readCarsStore();
  return {
    ok: true,
    updatedAt: store.updatedAt,
    count: store.cars.length,
    cars: store.cars.map((car) => ({
      ...car,
      status: normalizeStatus(car.status ?? 'disponibile'),
      privateNotes: String(car.privateNotes || '').trim(),
      images: normalizeImageList(car.images)
    }))
  };
}

function requireAuth(request, response) {
  const session = getSessionFromRequest(request);
  if (!session) {
    sendError(response, 401, 'Accesso richiesto.');
    return null;
  }

  const user = readAdminUser();
  if (!user || user.username !== session.username) {
    clearSession(session.token);
    sendError(response, 401, 'Sessione non valida.');
    return null;
  }

  return { session, user };
}

function getMimeType(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  switch (extension) {
    case '.html':
      return 'text/html; charset=utf-8';
    case '.js':
      return 'application/javascript; charset=utf-8';
    case '.json':
      return 'application/json; charset=utf-8';
    case '.css':
      return 'text/css; charset=utf-8';
    case '.svg':
      return 'image/svg+xml';
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.webp':
      return 'image/webp';
    case '.ico':
      return 'image/x-icon';
    default:
      return 'application/octet-stream';
  }
}

function resolveStaticPath(urlPath) {
  let requestedPath = decodeURIComponent(urlPath.split('?')[0]);

  if (requestedPath === '/') {
    requestedPath = '/index.html';
  } else if (requestedPath === '/admin' || requestedPath === '/admin/') {
    requestedPath = '/admin.html';
  }

  const safeRelativePath = path.normalize(requestedPath).replace(/^(\.\.[/\\])+/, '');
  const resolvedPath = path.join(ROOT_DIR, safeRelativePath);

  if (!resolvedPath.startsWith(ROOT_DIR)) {
    return null;
  }

  if (resolvedPath === ADMIN_FILE) {
    return null;
  }

  return resolvedPath;
}

function serveStaticFile(request, response) {
  const filePath = resolveStaticPath(request.url || '/');
  if (!filePath) {
    sendError(response, 404, 'Risorsa non trovata.');
    return;
  }

  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    sendError(response, 404, 'Pagina non trovata.');
    return;
  }

  response.writeHead(200, {
    'Content-Type': getMimeType(filePath),
    'X-Content-Type-Options': 'nosniff'
  });

  fs.createReadStream(filePath).pipe(response);
}

async function handleApiRequest(request, response) {
  const requestUrl = new URL(request.url, `http://${request.headers.host || `${HOST}:${PORT}`}`);
  const { pathname } = requestUrl;

  if (request.method === 'GET' && pathname === '/api/cars') {
    sendJson(response, 200, getPublicInventory());
    return;
  }

  if (request.method === 'GET' && pathname === '/api/auth/session') {
    const auth = requireAuth(request, response);
    if (!auth) {
      return;
    }

    sendJson(response, 200, {
      ok: true,
      authenticated: true,
      username: auth.user.username,
      mustChangePassword: Boolean(auth.user.mustChangePassword)
    });
    return;
  }

  if (request.method === 'POST' && pathname === '/api/auth/login') {
    const ipAddress = clientIp(request);
    if (isRateLimited(ipAddress)) {
      sendError(response, 429, 'Troppi tentativi. Riprova tra qualche minuto.');
      return;
    }

    let body;
    try {
      body = await readRequestBody(request);
    } catch (error) {
      sendError(response, 400, error.message);
      return;
    }

    const user = readAdminUser();
    const username = String(body.username || '').trim().toLowerCase();
    const password = String(body.password || '');

    if (!user || username !== user.username || !verifyPassword(password, user)) {
      registerFailedLogin(ipAddress);
      sendError(response, 401, 'Credenziali non valide.');
      return;
    }

    clearFailedLogins(ipAddress);
    const token = createSession(user.username);
    const secureFlag = process.env.NODE_ENV === 'production' ? '; Secure' : '';

    sendJson(
      response,
      200,
      {
        ok: true,
        authenticated: true,
        username: user.username,
        mustChangePassword: Boolean(user.mustChangePassword)
      },
      {
        'Set-Cookie': `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(
          SESSION_TTL_MS / 1000
        )}${secureFlag}`
      }
    );
    return;
  }

  if (request.method === 'POST' && pathname === '/api/auth/logout') {
    const session = getSessionFromRequest(request);
    if (session) {
      clearSession(session.token);
    }

    sendEmpty(response, 204, {
      'Set-Cookie': `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`
    });
    return;
  }

  if (request.method === 'GET' && pathname === '/api/admin/cars') {
    const auth = requireAuth(request, response);
    if (!auth) {
      return;
    }

    sendJson(response, 200, getAdminInventory());
    return;
  }

  if (request.method === 'POST' && pathname === '/api/admin/uploads') {
    const auth = requireAuth(request, response);
    if (!auth) {
      return;
    }

    try {
      const body = await readRequestBody(request, UPLOAD_BODY_LIMIT_BYTES);
      const files = Array.isArray(body.files) ? body.files : [];

      if (!files.length) {
        sendError(response, 400, 'Seleziona almeno una foto da caricare.');
        return;
      }

      const images = files.map(saveUploadedImage);
      sendJson(response, 201, {
        ok: true,
        message: 'Foto caricate.',
        images
      });
    } catch (error) {
      sendError(response, 400, error.message);
    }
    return;
  }

  if (request.method === 'POST' && pathname === '/api/admin/cars') {
    const auth = requireAuth(request, response);
    if (!auth) {
      return;
    }

    let body;
    try {
      body = await readRequestBody(request);
      const store = readCarsStore();
      const newCar = normalizeCarPayload(body);
      const nextStore = persistCarsStore([newCar, ...store.cars]);

      sendJson(response, 201, {
        ok: true,
        message: 'Auto aggiunta.',
        updatedAt: nextStore.updatedAt,
        car: formatPublicCar(newCar),
        cars: nextStore.cars
      });
    } catch (error) {
      sendError(response, 400, error.message);
    }
    return;
  }

  if (request.method === 'PUT' && pathname.startsWith('/api/admin/cars/')) {
    const auth = requireAuth(request, response);
    if (!auth) {
      return;
    }

    const carId = decodeURIComponent(pathname.replace('/api/admin/cars/', ''));
    const store = readCarsStore();
    const index = store.cars.findIndex((car) => car.id === carId);

    if (index === -1) {
      sendError(response, 404, 'Auto non trovata.');
      return;
    }

    try {
      const body = await readRequestBody(request);
      const updatedCar = normalizeCarPayload(body, store.cars[index]);
      const nextCars = [...store.cars];
      nextCars[index] = updatedCar;
      const nextStore = persistCarsStore(nextCars);

      sendJson(response, 200, {
        ok: true,
        message: 'Auto aggiornata.',
        updatedAt: nextStore.updatedAt,
        car: formatPublicCar(updatedCar),
        cars: nextStore.cars
      });
    } catch (error) {
      sendError(response, 400, error.message);
    }
    return;
  }

  if (request.method === 'DELETE' && pathname.startsWith('/api/admin/cars/')) {
    const auth = requireAuth(request, response);
    if (!auth) {
      return;
    }

    const carId = decodeURIComponent(pathname.replace('/api/admin/cars/', ''));
    const store = readCarsStore();
    const nextCars = store.cars.filter((car) => car.id !== carId);

    if (nextCars.length === store.cars.length) {
      sendError(response, 404, 'Auto non trovata.');
      return;
    }

    const nextStore = persistCarsStore(nextCars);
    sendJson(response, 200, {
      ok: true,
      message: 'Auto eliminata.',
      updatedAt: nextStore.updatedAt,
      cars: nextStore.cars
    });
    return;
  }

  if (request.method === 'PUT' && pathname === '/api/admin/account/password') {
    const auth = requireAuth(request, response);
    if (!auth) {
      return;
    }

    try {
      const body = await readRequestBody(request);
      const currentPassword = String(body.currentPassword || '');
      const newPassword = String(body.newPassword || '');

      if (!verifyPassword(currentPassword, auth.user)) {
        sendError(response, 401, 'La password attuale non coincide.');
        return;
      }

      const updatedUser = {
        ...buildAdminUser(auth.user.username, newPassword, auth.user),
        mustChangePassword: false
      };

      writeAdminUser(updatedUser);

      sendJson(response, 200, {
        ok: true,
        message: 'Password aggiornata.',
        username: updatedUser.username,
        mustChangePassword: false
      });
    } catch (error) {
      sendError(response, 400, error.message);
    }
    return;
  }

  sendError(response, 404, 'Endpoint non trovato.');
}

const server = http.createServer(async (request, response) => {
  try {
    if ((request.url || '').startsWith('/api/')) {
      await handleApiRequest(request, response);
      return;
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      sendError(response, 405, 'Metodo non supportato.');
      return;
    }

    if (request.method === 'HEAD') {
      response.writeHead(200, { 'X-Content-Type-Options': 'nosniff' });
      response.end();
      return;
    }

    serveStaticFile(request, response);
  } catch (error) {
    console.error('[MV Cars] Errore server:', error);
    sendError(response, 500, 'Errore interno del server.');
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[MV Cars] Server attivo su http://${HOST}:${PORT}`);
  console.log('[MV Cars] Vetrina pubblica: /');
  console.log('[MV Cars] Gestionale admin: /admin.html');
});
