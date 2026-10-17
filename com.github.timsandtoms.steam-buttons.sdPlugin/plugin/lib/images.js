'use strict';
/*
 * Artwork for the property inspector.
 *
 * The inspector runs in a web view and cannot read Steam's files, so the plugin
 * serves artwork on 127.0.0.1 (random port + random path token). If the web
 * view can't reach that server the inspector asks for base64 over the plugin
 * socket instead (see resolveDataUrl).
 */
const fs = require('fs');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const https = require('https');

const MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.ico': 'image/x-icon' };

// Which artwork to try, in order, for each requested kind.
const CHAINS = {
  thumb: ['icon', 'header', 'portrait'],
  portrait: ['portrait', 'header', 'icon'],
  icon: ['icon', 'portrait', 'header']
};

const CDN = {
  portrait: (id) => [
    'https://cdn.cloudflare.steamstatic.com/steam/apps/' + id + '/library_600x900.jpg',
    'https://steamcdn-a.akamaihd.net/steam/apps/' + id + '/library_600x900.jpg'
  ],
  header: (id) => [
    'https://cdn.cloudflare.steamstatic.com/steam/apps/' + id + '/header.jpg',
    'https://steamcdn-a.akamaihd.net/steam/apps/' + id + '/header.jpg'
  ]
};

/** Trust the bytes over the file name (Steam sometimes stores PNG data as .jpg). */
function sniffMime(buf, fallback) {
  if (buf.length > 4) {
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
    if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
    if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
    if (buf[0] === 0 && buf[1] === 0 && buf[2] === 1 && buf[3] === 0) return 'image/x-icon';
  }
  return fallback;
}

function fetchBuffer(url) {
  return new Promise((resolve) => {
    try {
      const req = https.get(url, { timeout: 7000, headers: { 'User-Agent': 'SteamButtons/1.0' } }, (res) => {
        if (res.statusCode !== 200) { res.resume(); resolve(null); return; }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const data = Buffer.concat(chunks);
          resolve({ data, mime: sniffMime(data, res.headers['content-type'] || 'image/jpeg') });
        });
        res.on('error', () => resolve(null));
      });
      req.on('timeout', () => { req.destroy(); resolve(null); });
      req.on('error', () => resolve(null));
    } catch (e) { resolve(null); }
  });
}

class ArtService {
  constructor() {
    this.library = null; // { byKey: Map, ctx }
    this.extras = new Map(); // custom AppIDs typed in by the user: key -> game
    this.allowCdn = true;
    this.cache = new Map(); // "key|kind" -> {data, mime} | null
    this.active = 0;
    this.waiters = [];
  }

  setLibrary(byKey, ctx) {
    this.library = { byKey, ctx };
    // Missing artwork may appear after a rescan, so forget negative results.
    for (const [k, v] of this.cache) if (v === null) this.cache.delete(k);
  }

  addExtra(game) {
    this.extras.set(game.key, game);
  }

  async slot() {
    if (this.active >= 4) await new Promise((r) => this.waiters.push(r));
    this.active++;
  }
  release() {
    this.active--;
    const next = this.waiters.shift();
    if (next) next();
  }

  /** @returns {Promise<{data: Buffer, mime: string} | null>} */
  async resolve(key, kind) {
    const chain = CHAINS[kind];
    if (!chain) return null;
    const game = (this.library && this.library.byKey.get(key)) || this.extras.get(key);
    if (!game) return null;

    const ck = key + '|' + kind;
    if (this.cache.has(ck)) return this.cache.get(ck);

    let out = null;
    // Local files first, across the whole chain
    const ctx = this.library && this.library.ctx;
    for (const k of chain) {
      const file = ctx && ctx.findLocal(game, k, game.icon);
      if (file) {
        try {
          const data = await fs.promises.readFile(file);
          out = { data, mime: sniffMime(data, MIME[path.extname(file).toLowerCase()] || 'image/jpeg') };
          break;
        } catch (e) { /* try next */ }
      }
    }
    // Then Steam's CDN (Steam apps only; the icon size has no stable URL)
    if (!out && this.allowCdn && game.kind === 'steam') {
      await this.slot();
      try {
        for (const k of chain) {
          if (!CDN[k]) continue;
          for (const url of CDN[k](game.appid)) {
            out = await fetchBuffer(url);
            if (out) break;
          }
          if (out) break;
        }
      } finally { this.release(); }
    }

    if (this.cache.size > 400) this.cache.delete(this.cache.keys().next().value);
    this.cache.set(ck, out);
    return out;
  }

  async resolveDataUrl(key, kind) {
    const r = await this.resolve(key, kind);
    return r ? 'data:' + r.mime + ';base64,' + r.data.toString('base64') : null;
  }
}

class ImageServer {
  constructor(art) {
    this.art = art;
    this.token = crypto.randomBytes(12).toString('hex');
    this.port = 0;
    this.server = null;
    this.starting = null;
  }

  /** Idempotent: resolves with the base URL, starting the server on first use. */
  start() {
    if (this.starting) return this.starting;
    this.starting = new Promise((resolve, reject) => {
      this.server = http.createServer(async (req, res) => {
        const headers = {
          'Access-Control-Allow-Origin': '*',
          'Cross-Origin-Resource-Policy': 'cross-origin',
          'Cache-Control': 'private, max-age=120'
        };
        try {
          const url = new URL(req.url, 'http://127.0.0.1');
          const parts = url.pathname.split('/').filter(Boolean);
          if (parts[0] !== this.token) { res.writeHead(404, headers); res.end(); return; }
          if (parts[1] === 'ping') { res.writeHead(200, headers); res.end('ok'); return; }
          if (parts[1] === 'img' && parts.length === 4) {
            const r = await this.art.resolve(decodeURIComponent(parts[2]), parts[3]);
            if (!r) { res.writeHead(404, headers); res.end(); return; }
            res.writeHead(200, Object.assign({ 'Content-Type': r.mime, 'Content-Length': r.data.length }, headers));
            res.end(r.data);
            return;
          }
          res.writeHead(404, headers); res.end();
        } catch (e) {
          res.writeHead(500, headers); res.end();
        }
      });
      this.server.on('error', reject);
      this.server.listen(0, '127.0.0.1', () => {
        this.port = this.server.address().port;
        resolve(this.base());
      });
    });
    return this.starting;
  }

  base() { return 'http://127.0.0.1:' + this.port + '/' + this.token; }
}

module.exports = { ArtService, ImageServer };
