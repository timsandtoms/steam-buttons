'use strict';
/*
 * Finds the Steam install and builds a list of everything launchable:
 *   - installed games/programs   steamapps/appmanifest_*.acf (every library folder)
 *   - owned but not installed    appinfo.vdf names for ids found in Steam's local caches
 *                                (+ optionally the public Steam Community profile)
 *   - non-Steam shortcuts        userdata/<id>/config/shortcuts.vdf
 *
 * Only ONE Steam account is read: the one that signed in most recently
 * (loginusers.vdf, MostRecent=1). That account's shortcuts, collections and
 * artwork are used, and its SteamID64 is what the optional profile lookup sends.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { execFileSync } = require('child_process');
const vdf = require('./vdf');

const { ci, ciPath } = vdf;
const STEAMID64_BASE = 76561197960265728n;

const ALLOWED_TYPES = new Set(['game', 'application', 'demo', 'beta', 'mod']);
const EXCLUDED_IDS = new Set([228980]); // Steamworks Common Redistributables
const EXCLUDED_NAMES = /^(proton(\b|-)|steam linux runtime|steamworks common redistributables|steam controller configs|steamvr media player)/i;
const IMAGE_EXT = ['.jpg', '.jpeg', '.png', '.webp'];

// ----------------------------------------------------------------- helpers

function exists(p) { try { fs.accessSync(p); return true; } catch (e) { return false; } }
function isDir(p) { try { return fs.statSync(p).isDirectory(); } catch (e) { return false; } }
function mtime(p) { try { return fs.statSync(p).mtimeMs; } catch (e) { return 0; } }
function readdir(p) { try { return fs.readdirSync(p); } catch (e) { return []; } }
function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; } }

function regQuery(key, name) {
  try {
    const out = execFileSync('reg', ['query', key, '/v', name], {
      encoding: 'utf8', timeout: 3000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore']
    });
    const m = /\sREG_SZ\s+(.+?)\r?$/m.exec(out);
    return m ? m[1].trim() : null;
  } catch (e) { return null; }
}

function httpGet(url, timeoutMs, redirects) {
  return new Promise((resolve) => {
    try {
      const req = https.get(url, { timeout: timeoutMs || 8000, headers: { 'User-Agent': 'SteamButtons/1.0' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && (redirects || 0) < 3) {
          res.resume();
          resolve(httpGet(new URL(res.headers.location, url).toString(), timeoutMs, (redirects || 0) + 1));
          return;
        }
        if (res.statusCode !== 200) { res.resume(); resolve(null); return; }
        const chunks = [];
        let total = 0;
        res.on('data', (c) => {
          total += c.length;
          if (total > 12 * 1024 * 1024) { req.destroy(); resolve(null); return; }
          chunks.push(c);
        });
        res.on('end', () => resolve({ data: Buffer.concat(chunks), type: res.headers['content-type'] || '' }));
        res.on('error', () => resolve(null));
      });
      req.on('timeout', () => { req.destroy(); resolve(null); });
      req.on('error', () => resolve(null));
    } catch (e) { resolve(null); }
  });
}

// --------------------------------------------------------- locating Steam

function candidateRoots() {
  const home = os.homedir();
  const c = [];
  if (process.platform === 'win32') {
    for (const key of ['HKCU\\Software\\Valve\\Steam', 'HKLM\\SOFTWARE\\WOW6432Node\\Valve\\Steam', 'HKLM\\SOFTWARE\\Valve\\Steam']) {
      const v = regQuery(key, 'SteamPath') || regQuery(key, 'InstallPath');
      if (v) c.push(path.normalize(v));
    }
    for (const base of [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, 'C:\\Program Files (x86)', 'C:\\Program Files']) {
      if (base) c.push(path.join(base, 'Steam'));
    }
  } else if (process.platform === 'darwin') {
    c.push(path.join(home, 'Library', 'Application Support', 'Steam'));
  } else {
    c.push(
      path.join(home, '.local', 'share', 'Steam'),
      path.join(home, '.steam', 'steam'),
      path.join(home, '.steam', 'root'),
      path.join(home, '.steam', 'debian-installation'),
      path.join(home, '.var', 'app', 'com.valvesoftware.Steam', '.local', 'share', 'Steam'),
      path.join(home, '.var', 'app', 'com.valvesoftware.Steam', 'data', 'Steam'),
      path.join(home, 'snap', 'steam', 'common', '.local', 'share', 'Steam')
    );
  }
  return c;
}

function looksLikeSteam(p) {
  return isDir(p) && (isDir(path.join(p, 'steamapps')) || exists(path.join(p, 'config', 'loginusers.vdf')) || isDir(path.join(p, 'userdata')));
}

function locateSteam(customPath) {
  const custom = String(customPath || '').trim();
  if (custom) {
    if (looksLikeSteam(custom)) return custom;
    return null;
  }
  const seen = new Set();
  const found = [];
  for (const p of candidateRoots()) {
    let real = p;
    try { real = fs.realpathSync(p); } catch (e) { continue; }
    if (seen.has(real) || !looksLikeSteam(real)) continue;
    seen.add(real);
    found.push({ p: real, score: Math.max(mtime(path.join(real, 'config', 'loginusers.vdf')), mtime(path.join(real, 'steamapps'))) });
  }
  found.sort((a, b) => b.score - a.score);
  return found.length ? found[0].p : null;
}

function findUser(root) {
  const userdata = path.join(root, 'userdata');
  const dirs = readdir(userdata).filter((d) => /^\d+$/.test(d) && d !== '0' && isDir(path.join(userdata, d)));
  let best = null;
  try {
    const users = ci(vdf.readTextFile(path.join(root, 'config', 'loginusers.vdf')), 'users') || {};
    for (const [sid, u] of Object.entries(users)) {
      if (!/^\d{17}$/.test(sid)) continue;
      const accountId = String(BigInt(sid) - STEAMID64_BASE);
      const score = (ci(u, 'MostRecent') === '1' ? 1e13 : 0) + Number(ci(u, 'Timestamp') || 0);
      if (dirs.includes(accountId) && (!best || score > best.score)) {
        best = { score, accountId, steamId64: sid, name: ci(u, 'PersonaName') || '' };
      }
    }
  } catch (e) { /* no loginusers.vdf */ }
  if (!best && dirs.length) {
    dirs.sort((a, b) => mtime(path.join(userdata, b, 'config', 'localconfig.vdf')) - mtime(path.join(userdata, a, 'config', 'localconfig.vdf')));
    best = { accountId: dirs[0], steamId64: String(BigInt(dirs[0]) + STEAMID64_BASE), name: '' };
  }
  if (!best) return null;
  best.dir = path.join(userdata, best.accountId);
  return best;
}

function libraryFolders(root) {
  const set = new Set([root]);
  for (const name of ['steamapps', 'SteamApps']) {
    try {
      const v = vdf.readTextFile(path.join(root, name, 'libraryfolders.vdf'));
      const lf = ci(v, 'libraryfolders') || v;
      for (const [k, val] of Object.entries(lf)) {
        if (!/^\d+$/.test(k)) continue;
        const p = typeof val === 'string' ? val : ci(val, 'path');
        if (p) set.add(p);
      }
      break;
    } catch (e) { /* try next */ }
  }
  return [...set];
}

// ---------------------------------------------------------- data sources

function readInstalled(libs) {
  const out = new Map();
  for (const lib of libs) {
    for (const sa of ['steamapps', 'SteamApps']) {
      const dir = path.join(lib, sa);
      if (!isDir(dir)) continue;
      for (const f of readdir(dir)) {
        const m = /^appmanifest_(\d+)\.acf$/i.exec(f);
        if (!m) continue;
        try {
          const st = ci(vdf.readTextFile(path.join(dir, f)), 'AppState');
          if (!st) continue;
          const id = Number(ci(st, 'appid') || m[1]);
          const flags = Number(ci(st, 'StateFlags') || 0);
          const name = ci(st, 'name') || ciPath(st, 'UserConfig', 'name') || ci(st, 'installdir') || '';
          out.set(id, { id, name, installed: (flags & 4) === 4 });
        } catch (e) { /* damaged manifest */ }
      }
    }
  }
  return out;
}

function crc32(str) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[i] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  const buf = Buffer.from(str, 'utf8');
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function readShortcuts(userDir) {
  const out = [];
  if (!userDir) return out;
  const file = path.join(userDir, 'config', 'shortcuts.vdf');
  try {
    const root = vdf.parseBinary(fs.readFileSync(file), 0).value;
    const list = ci(root, 'shortcuts') || root;
    for (const entry of Object.values(list)) {
      if (!entry || typeof entry !== 'object') continue;
      const name = ci(entry, 'AppName');
      const exe = ci(entry, 'Exe') || '';
      if (!name) continue;
      if (Number(ci(entry, 'IsHidden') || 0) === 1) continue;
      let appid = ci(entry, 'appid');
      appid = appid === undefined ? (crc32(exe + name) | 0x80000000) >>> 0 : Number(appid) >>> 0;
      out.push({ appid, name, icon: ci(entry, 'icon') || '' });
    }
  } catch (e) { /* no shortcuts */ }
  return out;
}

/** 64-bit game id used by steam://rungameid/ for non-Steam shortcuts. */
function shortcutGameId(appid32) {
  return ((BigInt(appid32) << 32n) | 0x02000000n).toString();
}

/**
 * App ids that the signed-in user's own config files mention: per-app library
 * cache, collections and localconfig.vdf. Used to find owned-but-not-installed titles.
 */
function scanUserAppIds(userDir) {
  const appIds = new Set();
  if (!userDir) return appIds;

  // 1. Collections (cloud-synced)
  const cloudDir = path.join(userDir, 'config', 'cloudstorage');
  for (const f of readdir(cloudDir)) {
    if (!/^cloud-storage-namespace-\d+\.json$/i.test(f)) continue;
    const arr = readJson(path.join(cloudDir, f));
    if (!Array.isArray(arr)) continue;
    for (const item of arr) {
      if (!Array.isArray(item) || item.length < 2) continue;
      const entry = item[1] || {};
      if (entry.is_deleted || !/^user-collections\./i.test(String(item[0])) || typeof entry.value !== 'string') continue;
      try {
        const col = JSON.parse(entry.value);
        if (col && Array.isArray(col.added)) col.added.forEach((id) => appIds.add(Number(id)));
      } catch (e) { /* skip */ }
    }
  }

  // 2. Per-app JSON cache
  for (const f of readdir(path.join(userDir, 'config', 'librarycache'))) {
    const m = /^(\d+)\.json$/i.exec(f);
    if (m) appIds.add(Number(m[1]));
  }

  // 3. localconfig.vdf (per-app settings)
  try {
    const lc = vdf.readTextFile(path.join(userDir, 'config', 'localconfig.vdf'));
    const apps = ciPath(lc, 'UserLocalConfigStore', 'Software', 'Valve', 'Steam', 'apps');
    if (apps && typeof apps === 'object') {
      for (const id of Object.keys(apps)) if (/^\d+$/.test(id)) appIds.add(Number(id));
    }
  } catch (e) { /* no localconfig */ }

  return appIds;
}

async function fetchProfileGames(steamId64) {
  const res = await httpGet('https://steamcommunity.com/profiles/' + steamId64 + '/games?tab=all&xml=1', 10000);
  if (!res) return { games: [], error: 'Could not reach steamcommunity.com' };
  const xml = res.data.toString('utf8');
  const games = [];
  const re = /<game>\s*<appID>(\d+)<\/appID>\s*<name>(?:<!\[CDATA\[([\s\S]*?)\]\]>|([^<]*))<\/name>/g;
  let m;
  while ((m = re.exec(xml))) games.push({ id: Number(m[1]), name: (m[2] !== undefined ? m[2] : m[3] || '').trim() });
  if (!games.length) return { games, error: 'Steam profile game list is empty or private' };
  return { games };
}

// --------------------------------------------------------------- artwork

function imageSize(buf) {
  if (buf.length > 24 && buf[0] === 0x89 && buf.toString('ascii', 1, 4) === 'PNG') {
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  }
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let p = 2;
    while (p + 9 < buf.length) {
      if (buf[p] !== 0xff) { p++; continue; }
      const m = buf[p + 1];
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7) || m === 0xff) { p += m === 0xff ? 1 : 2; continue; }
      const len = buf.readUInt16BE(p + 2);
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
        return { h: buf.readUInt16BE(p + 5), w: buf.readUInt16BE(p + 7) };
      }
      p += 2 + len;
    }
  }
  return null;
}

function sizeOfFile(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const b = Buffer.alloc(256 * 1024);
    const n = fs.readSync(fd, b, 0, b.length, 0);
    return imageSize(b.subarray(0, n));
  } catch (e) { return null; } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch (e) { /* ignore */ }
  }
}

function classify(size) {
  if (!size) return null;
  const { w, h } = size;
  if (Math.max(w, h) <= 128) return 'icon';
  if (w >= 200 && h / w >= 1.3 && h / w <= 1.7) return 'portrait';
  if (w >= 300 && w / h >= 1.9 && w / h <= 2.4) return 'header';
  return null;
}

const NAMED = {
  portrait: ['library_600x900', 'library_capsule', 'portrait'],
  header: ['header', 'library_header'],
  icon: ['icon']
};

function walkImages(dir, depth) {
  const out = [];
  for (const name of readdir(dir)) {
    const full = path.join(dir, name);
    const ext = path.extname(name).toLowerCase();
    if (IMAGE_EXT.includes(ext)) out.push({ name, base: path.basename(name, ext).toLowerCase(), full });
    else if (depth > 0 && isDir(full)) out.push(...walkImages(full, depth - 1));
  }
  return out;
}

function makeArtFinder(root, userDir) {
  const cacheDir = path.join(root, 'appcache', 'librarycache');
  const gridDir = userDir ? path.join(userDir, 'config', 'grid') : null;
  let flat = null;
  let grid = null;
  const dimMemo = new Map();

  const flatSet = () => flat || (flat = new Set(readdir(cacheDir)));
  const gridSet = () => grid || (grid = new Set(gridDir ? readdir(gridDir) : []));

  return function findLocal(game, kind, extraIcon) {
    const id = game.appid;

    // 1. User-set custom artwork (Steam's grid folder)
    if (gridDir) {
      const suffix = { portrait: 'p', header: '', icon: '_icon' }[kind];
      for (const ext of ['.png', '.jpg', '.jpeg', '.webp']) {
        const name = id + suffix + ext;
        if (gridSet().has(name)) return path.join(gridDir, name);
      }
    }

    // 2. Older flat layout: <appid>_library_600x900.jpg
    const flatNames = {
      portrait: ['_library_600x900.jpg', '_library_600x900.png'],
      header: ['_header.jpg', '_library_header.jpg', '_header.png'],
      icon: ['_icon.jpg', '_icon.png']
    }[kind];
    for (const suffix of flatNames) if (flatSet().has(id + suffix)) return path.join(cacheDir, id + suffix);

    // 3. Newer layout: librarycache/<appid>/ (files may be named or hashed)
    const dir = path.join(cacheDir, String(id));
    if (isDir(dir)) {
      const files = walkImages(dir, 2);
      for (const f of files) if (NAMED[kind].includes(f.base)) return f.full;
      for (const f of files) {
        if (!/^[0-9a-f]{20,}$/.test(f.base)) continue;
        if (!dimMemo.has(f.full)) dimMemo.set(f.full, classify(sizeOfFile(f.full)));
        if (dimMemo.get(f.full) === kind) return f.full;
      }
    }

    // 4. The shortcut's own icon path
    if (kind === 'icon' && extraIcon && IMAGE_EXT.includes(path.extname(extraIcon).toLowerCase()) && exists(extraIcon)) return extraIcon;
    return null;
  };
}

// -------------------------------------------------------------- scanning

/**
 * @param {{steamPath?: string, useProfile?: boolean}} options
 */
async function scanLibrary(options) {
  options = options || {};
  const warnings = [];
  const root = locateSteam(options.steamPath);
  if (!root) {
    return {
      games: [],
      meta: { error: options.steamPath ? 'not_found_custom' : 'not_found', warnings },
      ctx: null
    };
  }

  const user = findUser(root);
  if (!user) warnings.push('No Steam user profile found under userdata/. Non-Steam games and custom names are unavailable.');

  const libs = libraryFolders(root);
  const installed = readInstalled(libs);
  const userAppIds = scanUserAppIds(user && user.dir);
  const shortcuts = readShortcuts(user && user.dir);

  // Candidate owned ids (installed + anything the local caches mention)
  const cacheIds = new Set(userAppIds);
  // Manifests that aren't fully installed (queued, paused, updating) are still owned.
  for (const app of installed.values()) if (!app.installed) cacheIds.add(app.id);
  for (const name of readdir(path.join(root, 'appcache', 'librarycache'))) {
    const m = /^(\d+)(?:_|$|\.)/.exec(name);
    if (m) cacheIds.add(Number(m[1]));
  }
  let profileGames = [];
  if (options.useProfile && user) {
    const r = await fetchProfileGames(user.steamId64);
    if (r.error) warnings.push(r.error);
    profileGames = r.games;
  }

  const wanted = new Set([...installed.keys(), ...cacheIds, ...profileGames.map((g) => g.id)]);
  const info = vdf.readAppInfo(path.join(root, 'appcache', 'appinfo.vdf'), wanted);
  const infoOf = (id) => {
    const common = ci(info.get(id), 'common');
    if (!common) return null;
    return { name: ci(common, 'name') || '', type: String(ci(common, 'type') || '').toLowerCase() };
  };

  const games = new Map();
  const add = (id, name, isInstalled) => {
    const key = 's' + id;
    if (games.has(key)) return;
    games.set(key, { key, kind: 'steam', id: String(id), appid: id, name, installed: isInstalled });
  };

  for (const app of installed.values()) {
    if (!app.installed) continue;
    const i = infoOf(app.id);
    if (EXCLUDED_IDS.has(app.id)) continue;
    if (i && i.type && !ALLOWED_TYPES.has(i.type)) continue;
    const name = app.name || (i && i.name) || '';
    if (!name || EXCLUDED_NAMES.test(name)) continue;
    add(app.id, name, true);
  }

  for (const id of cacheIds) {
    if (installed.has(id) && installed.get(id).installed) continue;
    if (EXCLUDED_IDS.has(id)) continue;
    const i = infoOf(id);
    if (!i || !i.name || !ALLOWED_TYPES.has(i.type) || EXCLUDED_NAMES.test(i.name)) continue;
    add(id, i.name, false);
  }

  for (const g of profileGames) {
    if (!g.name || EXCLUDED_IDS.has(g.id) || EXCLUDED_NAMES.test(g.name)) continue;
    if (installed.has(g.id) && installed.get(g.id).installed) continue;
    const i = infoOf(g.id);
    if (i && i.type && !ALLOWED_TYPES.has(i.type)) continue;
    add(g.id, (i && i.name) || g.name, false);
  }

  for (const s of shortcuts) {
    const key = 'n' + s.appid;
    if (games.has(key)) continue;
    games.set(key, {
      key, kind: 'nonsteam', id: shortcutGameId(s.appid), appid: s.appid, name: s.name,
      installed: true, icon: s.icon
    });
  }

  const list = [...games.values()];
  return {
    games: list,
    meta: {
      steamRoot: root,
      user: user ? { name: user.name, accountId: user.accountId } : null,
      libraryFolders: libs.length,
      counts: {
        installed: list.filter((g) => g.kind === 'steam' && g.installed).length,
        notInstalled: list.filter((g) => !g.installed).length,
        nonSteam: list.filter((g) => g.kind === 'nonsteam').length
      },
      appInfoEntries: info.size,
      warnings
    },
    ctx: { root, userDir: user && user.dir, findLocal: makeArtFinder(root, user && user.dir) }
  };
}

const rootMemo = new Map();

/**
 * Name lookup for an app id the user typed in: Steam's local appinfo.vdf first,
 * then (if allowed) the Steam store API.
 * @returns {Promise<{name: string|null}>}
 */
async function lookupApp(appid, opts) {
  opts = opts || {};
  let name = '';
  const memoKey = opts.steamPath || '';
  if (!rootMemo.has(memoKey)) rootMemo.set(memoKey, locateSteam(opts.steamPath));
  const root = rootMemo.get(memoKey);
  if (root) {
    const info = vdf.readAppInfo(path.join(root, 'appcache', 'appinfo.vdf'), new Set([appid]));
    name = ci(ci(info.get(appid), 'common'), 'name') || '';
  }
  if (!name && opts.online) {
    const res = await httpGet('https://store.steampowered.com/api/appdetails?appids=' + appid + '&filters=basic', 6000);
    if (res) {
      try {
        const entry = JSON.parse(res.data.toString('utf8'))[String(appid)];
        if (entry && entry.success && entry.data && entry.data.name) name = String(entry.data.name);
      } catch (e) { /* not JSON */ }
    }
  }
  return { name: name || null };
}

module.exports = { scanLibrary, lookupApp, locateSteam, shortcutGameId, crc32, imageSize };
