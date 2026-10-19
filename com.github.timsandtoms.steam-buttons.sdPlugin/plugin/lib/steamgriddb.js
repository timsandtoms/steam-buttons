'use strict';
/*
 * SteamGridDB (https://www.steamgriddb.com) client.
 *
 * The API needs a key, which is free and belongs to the person using the plugin
 * (https://www.steamgriddb.com/profile/preferences/api). It lives in the plugin's global
 * settings and is sent with each request from the property inspector; it is never logged.
 *
 * Images are fetched here and handed to the inspector through the local image server,
 * because the inspector's web view can't be relied on to load them directly (and a canvas
 * needs same-origin-safe pixels to build the key icon).
 */
const https = require('https');

const API_HOST = 'www.steamgriddb.com';
const API_BASE = '/api/v2';
const USER_AGENT = 'SteamButtons/1.1 (OpenDeck plugin)';

const ASSET_TYPES = ['grids', 'heroes', 'logos', 'icons'];
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const CACHE_BYTES = 48 * 1024 * 1024;
const CACHE_ITEMS = 300;

class SgdbError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/** Only artwork hosted by SteamGridDB may be fetched on the inspector's behalf. */
function allowedImageUrl(raw) {
  let u;
  try { u = new URL(String(raw)); } catch (e) { return null; }
  if (u.protocol !== 'https:' || u.username || u.password) return null;
  const host = u.hostname.toLowerCase();
  const ok = host === 'steamgriddb.com' || host.endsWith('.steamgriddb.com') ||
    (host === 's3.amazonaws.com' && u.pathname.startsWith('/steamgriddb/'));
  return ok ? u : null;
}

function validKey(key) {
  return typeof key === 'string' && /^[A-Za-z0-9]{8,128}$/.test(key.trim());
}

function toStr(v, max) { return typeof v === 'string' ? v.slice(0, max || 200) : ''; }
function toNum(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }

/** Keeps only what the inspector needs from one API image record. */
function cleanItem(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const url = allowedImageUrl(raw.url);
  if (!url) return null;
  const thumbUrl = allowedImageUrl(raw.thumb) || url;
  return {
    id: toNum(raw.id),
    url: url.toString(),
    thumb: thumbUrl.toString(),
    width: toNum(raw.width),
    height: toNum(raw.height),
    style: toStr(raw.style, 40),
    score: toNum(raw.score),
    upvotes: toNum(raw.upvotes),
    downvotes: toNum(raw.downvotes),
    nsfw: !!raw.nsfw,
    humor: !!raw.humor,
    author: toStr(raw.author && raw.author.name, 60)
  };
}

class SteamGridDb {
  /** @param {{request?: Function}} [opts] request: https.request-compatible, for tests. */
  constructor(opts) {
    this.request = (opts && opts.request) || https.request;
    this.cache = new Map();   // url -> {data, mime}
    this.cacheBytes = 0;
    this.pending = new Map(); // url -> Promise
    this.active = 0;
    this.waiters = [];
  }

  // ------------------------------------------------------------- plumbing

  /** One HTTPS GET. Resolves {status, headers, body}; follows no redirects. */
  _get(host, pathAndQuery, headers, timeoutMs, maxBytes) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (fn, v) => { if (!settled) { settled = true; fn(v); } };
      const req = this.request({ host, path: pathAndQuery, method: 'GET', headers, timeout: timeoutMs }, (res) => {
        const chunks = [];
        let total = 0;
        res.on('data', (c) => {
          total += c.length;
          if (total > maxBytes) { req.destroy(); done(reject, new SgdbError('too_large', 'Response too large')); return; }
          chunks.push(c);
        });
        res.on('end', () => done(resolve, { status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
        res.on('error', (e) => done(reject, new SgdbError('network', e.message)));
      });
      req.on('timeout', () => { req.destroy(); done(reject, new SgdbError('network', 'Timed out talking to SteamGridDB')); });
      req.on('error', (e) => done(reject, new SgdbError('network', e.message)));
      req.end();
    });
  }

  async _json(key, pathAndQuery) {
    if (!validKey(key)) throw new SgdbError('no_key', 'Add your SteamGridDB API key first.');
    const res = await this._get(API_HOST, API_BASE + pathAndQuery, {
      Authorization: 'Bearer ' + key.trim(),
      Accept: 'application/json',
      'User-Agent': USER_AGENT
    }, 12000, 4 * 1024 * 1024);
    if (res.status === 401 || res.status === 403) throw new SgdbError('bad_key', 'SteamGridDB rejected the API key.');
    if (res.status === 429) throw new SgdbError('rate_limited', 'SteamGridDB is rate limiting requests. Try again in a moment.');
    let body = null;
    try { body = JSON.parse(res.body.toString('utf8')); } catch (e) { /* not JSON */ }
    if (res.status === 404) return { notFound: true };
    if (res.status !== 200 || !body || body.success === false) {
      const detail = body && Array.isArray(body.errors) && body.errors.length ? ': ' + body.errors.join(', ') : '';
      throw new SgdbError('api', 'SteamGridDB error (HTTP ' + res.status + ')' + detail);
    }
    return body;
  }

  // ------------------------------------------------------------- queries

  /** @returns {Promise<{id: number, name: string, verified: boolean}[]>} */
  async search(key, term) {
    const t = String(term || '').trim().slice(0, 100);
    if (!t) return [];
    const body = await this._json(key, '/search/autocomplete/' + encodeURIComponent(t));
    const list = body.notFound || !Array.isArray(body.data) ? [] : body.data;
    return list.slice(0, 15).map((g) => ({ id: toNum(g.id), name: toStr(g.name, 120), verified: !!g.verified }))
      .filter((g) => g.id > 0 && g.name);
  }

  /** SteamGridDB's own game record for a Steam app id, or null when it has none. */
  async gameForSteamApp(key, appid) {
    if (!/^\d{1,10}$/.test(String(appid))) return null;
    const body = await this._json(key, '/games/steam/' + appid);
    if (body.notFound || !body.data) return null;
    const id = toNum(body.data.id);
    return id > 0 ? { id, name: toStr(body.data.name, 120) } : null;
  }

  /**
   * One page of artwork for a game.
   * @param {string} key
   * @param {{gameId: number, type: string, styles?: string[], dimensions?: string[], page?: number,
   *          nsfw?: boolean, humor?: boolean}} q
   */
  async assets(key, q) {
    if (!ASSET_TYPES.includes(q.type)) throw new SgdbError('api', 'Unknown artwork type.');
    const gameId = toNum(q.gameId);
    if (!(gameId > 0)) throw new SgdbError('api', 'No game selected.');
    const safe = (list) => (Array.isArray(list) ? list : []).map(String).filter((s) => /^[A-Za-z0-9_x]{1,24}$/.test(s)).slice(0, 12);
    const page = Math.max(0, Math.min(500, Math.floor(toNum(q.page))));
    const params = [];
    const styles = safe(q.styles), dims = safe(q.dimensions);
    if (styles.length) params.push('styles=' + styles.join(','));
    if (dims.length) params.push('dimensions=' + dims.join(','));
    // Still images only: a key icon is a single frame.
    params.push('types=static');
    params.push('nsfw=' + (q.nsfw ? 'any' : 'false'));
    params.push('humor=' + (q.humor ? 'any' : 'false'));
    params.push('epilepsy=false');
    if (page) params.push('page=' + page);
    const body = await this._json(key, '/' + q.type + '/game/' + gameId + '?' + params.join('&'));
    const raw = body.notFound || !Array.isArray(body.data) ? [] : body.data;
    const items = raw.map(cleanItem).filter(Boolean);
    const limit = toNum(body.limit) || 50;
    const total = toNum(body.total);
    const hasMore = total ? (page + 1) * limit < total : raw.length >= limit;
    return { page, total, hasMore, items };
  }

  // -------------------------------------------------------------- images

  async _slot() {
    if (this.active >= 6) await new Promise((r) => this.waiters.push(r));
    this.active++;
  }
  _release() {
    this.active--;
    const next = this.waiters.shift();
    if (next) next();
  }

  _remember(url, value) {
    if (this.cache.has(url)) { this.cacheBytes -= this.cache.get(url).data.length; this.cache.delete(url); }
    this.cache.set(url, value);
    this.cacheBytes += value.data.length;
    while (this.cache.size > CACHE_ITEMS || this.cacheBytes > CACHE_BYTES) {
      const oldest = this.cache.keys().next().value;
      this.cacheBytes -= this.cache.get(oldest).data.length;
      this.cache.delete(oldest);
    }
  }

  /** @returns {Promise<{data: Buffer, mime: string} | null>} null for anything not fetchable */
  fetchImage(rawUrl) {
    let u = allowedImageUrl(rawUrl);
    if (!u) return Promise.resolve(null);
    const first = u.toString();
    if (this.cache.has(first)) {
      const hit = this.cache.get(first);
      this.cache.delete(first); this.cache.set(first, hit); // most recently used
      return Promise.resolve(hit);
    }
    if (this.pending.has(first)) return this.pending.get(first);

    const job = (async () => {
      await this._slot();
      try {
        for (let hop = 0; hop < 4; hop++) {
          let res;
          try {
            res = await this._get(u.hostname, u.pathname + u.search, { 'User-Agent': USER_AGENT, Accept: 'image/*' }, 15000, MAX_IMAGE_BYTES);
          } catch (e) { return null; }
          if (res.status >= 300 && res.status < 400 && res.headers.location) {
            const next = allowedImageUrl(new URL(res.headers.location, u).toString());
            if (!next) return null;
            u = next;
            continue;
          }
          if (res.status !== 200 || !res.body.length) return null;
          const mime = sniffMime(res.body);
          if (!mime) return null; // not an image we can decode
          const value = { data: res.body, mime };
          this._remember(first, value);
          return value;
        }
        return null;
      } finally { this._release(); }
    })();
    this.pending.set(first, job);
    const cleanup = () => { if (this.pending.get(first) === job) this.pending.delete(first); };
    job.then(cleanup, cleanup);
    return job;
  }

  async imageDataUrl(rawUrl) {
    const r = await this.fetchImage(rawUrl);
    return r ? 'data:' + r.mime + ';base64,' + r.data.toString('base64') : null;
  }
}

function sniffMime(buf) {
  if (buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (buf.toString('ascii', 0, 3) === 'GIF') return 'image/gif';
  if (buf[0] === 0 && buf[1] === 0 && buf[2] === 1 && buf[3] === 0) return 'image/x-icon';
  return null;
}

module.exports = { SteamGridDb, SgdbError, allowedImageUrl, validKey, cleanItem, sniffMime, ASSET_TYPES };
