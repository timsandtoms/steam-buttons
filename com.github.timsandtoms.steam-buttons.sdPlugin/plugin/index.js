'use strict';
/*
 * Steam Buttons - plugin backend.
 * Speaks the Stream Deck plugin protocol (as implemented by OpenDeck).
 *
 *   node index.js -port <n> -pluginUUID <id> -registerEvent <name> -info <json>
 */
const WebSocket = require('ws');
const SteamUrl = require('../shared/url-tools.js');
const { scanLibrary, lookupApp } = require('./lib/steam.js');
const { ArtService, ImageServer } = require('./lib/images.js');
const { openSteamUrl } = require('./lib/opener.js');

// ------------------------------------------------------------------ args

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i += 2) out[String(argv[i]).replace(/^-+/, '')] = argv[i + 1];
  return out;
}

const args = parseArgs(process.argv);
const PORT = args.port;
const PLUGIN_UUID = args.pluginUUID;
const REGISTER_EVENT = args.registerEvent;

process.on('uncaughtException', (e) => log('uncaughtException: ' + (e && e.stack || e)));
process.on('unhandledRejection', (e) => log('unhandledRejection: ' + (e && e.stack || e)));

let ws = null;
function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}
function log(msg) {
  console.error('[steam-buttons] ' + msg);
  try { send({ event: 'logMessage', payload: { message: String(msg) } }); } catch (e) { /* ignore */ }
}

// -------------------------------------------------------- library service

const art = new ArtService();
const imageServer = new ImageServer(art);
let library = { key: '', data: null };
let scanning = null;

/**
 * The scan result is kept for the whole session (as long as this process runs).
 * It is only redone when the inspector asks for a refresh or the Steam folder /
 * profile options change.
 */
async function getLibrary(options, force) {
  const key = JSON.stringify([options.steamPath || '', !!options.useProfile]);
  if (!force && library.data && library.key === key) return Object.assign({}, library.data, { cached: true });
  if (scanning && scanning.key === key) return scanning.promise;

  const promise = (async () => {
    const t0 = Date.now();
    const result = await scanLibrary(options);
    const byKey = new Map(result.games.map((g) => [g.key, g]));
    art.setLibrary(byKey, result.ctx);
    const payload = {
      games: result.games.map((g) => ({ key: g.key, kind: g.kind, id: g.id, name: g.name, installed: g.installed })),
      meta: Object.assign({ scanMs: Date.now() - t0, scannedAt: new Date().toISOString() }, result.meta)
    };
    library = { key, data: payload };
    log('Scanned Steam library: ' + payload.games.length + ' entries in ' + payload.meta.scanMs + ' ms');
    return Object.assign({}, payload, { cached: false });
  })();
  scanning = { key, promise };
  try { return await promise; } finally { if (scanning && scanning.promise === promise) scanning = null; }
}

// Custom AppIDs the user typed in (not part of the scan cache).
function registerCustom(id, name) {
  const appid = Number(id);
  if (!/^\d{1,10}$/.test(String(id)) || !(appid > 0 && appid <= 4294967295)) return null;
  const game = { key: 'c' + appid, kind: 'steam', id: String(appid), appid, name: name || '', installed: false, custom: true };
  art.addExtra(game);
  return game;
}

// ---------------------------------------------------------- key contexts

/** context -> { settings, appliedIcon } */
const contexts = new Map();

/**
 * context -> custom AppID that key uses. OpenDeck only reports keys that are on screen,
 * and can't tell "removed" from "scrolled away", so entries are kept for the session.
 */
const customInUse = new Map();

function noteAssignment(context, settings) {
  const k = settings && settings.selected && String(settings.selected.key || '');
  if (k && k[0] === 'c') customInUse.set(context, k.slice(1));
  else customInUse.delete(context);
}

function applyIcon(context, force) {
  const c = contexts.get(context);
  if (!c) return;
  const icon = (c.settings && c.settings.icon) || '';
  if (!force && c.appliedIcon === icon) return;
  const hadIcon = !!c.appliedIcon;
  c.appliedIcon = icon;
  if (icon) {
    send({ event: 'setImage', context, payload: { image: icon, target: 0 } });
  } else if (hadIcon) {
    // We set an icon earlier and it has been removed: hand the key back to its default image.
    // A key that never had a plugin icon is left alone so an icon chosen in OpenDeck survives.
    send({ event: 'setImage', context, payload: { target: 0 } });
  }
}

async function onKeyDown(msg) {
  const context = msg.context;
  const cached = contexts.get(context);
  const fromEvent = msg.payload && msg.payload.settings;
  const settings = fromEvent && fromEvent.url ? fromEvent : (cached && cached.settings) || fromEvent || {};
  const url = SteamUrl.normalizeForOpen(settings.url);
  if (!url) {
    log('Key pressed without a valid steam:// URL: ' + JSON.stringify(settings.url || ''));
    send({ event: 'showAlert', context });
    return;
  }
  const ok = await openSteamUrl(url);
  if (ok) {
    send({ event: 'showOk', context });
  } else {
    // Last resort: let the host application open it.
    log('No OS launcher accepted ' + url + '; asking the host to open it');
    send({ event: 'openUrl', payload: { url } });
    send({ event: 'showOk', context });
  }
}

// ------------------------------------------------- property inspector I/O

function toInspector(msg, payload) {
  send({ event: 'sendToPropertyInspector', action: msg.action, context: msg.context, payload });
}

async function onSendToPlugin(msg) {
  const p = msg.payload || {};
  try {
    if (p.cmd === 'library') {
      const options = p.options || {};
      art.allowCdn = options.cdn !== false;
      (options.customApps || []).forEach((c) => registerCustom(c.id, c.name));
      const base = await imageServer.start();
      const data = await getLibrary(options, !!p.refresh);
      toInspector(msg, Object.assign({ event: 'library', requestId: p.requestId, base }, data));
    } else if (p.cmd === 'custom') {
      const options = p.options || {};
      art.allowCdn = options.cdn !== false;
      const game = registerCustom(p.id, '');
      if (!game) { toInspector(msg, { event: 'custom', id: String(p.id), invalid: true }); return; }
      const info = await lookupApp(game.appid, { steamPath: options.steamPath, online: options.cdn !== false });
      game.name = info.name || '';
      const hasArt = !!(await art.resolve(game.key, 'thumb'));
      toInspector(msg, { event: 'custom', id: game.id, name: info.name, hasArt });
    } else if (p.cmd === 'customInUse') {
      toInspector(msg, { event: 'customInUse', ids: [...new Set(customInUse.values())] });
    } else if (p.cmd === 'image') {
      const dataUrl = await art.resolveDataUrl(String(p.key), String(p.kind));
      toInspector(msg, { event: 'image', key: p.key, kind: p.kind, dataUrl });
    }
  } catch (e) {
    log('sendToPlugin ' + p.cmd + ' failed: ' + (e && e.stack || e));
    toInspector(msg, { event: 'error', cmd: p.cmd, requestId: p.requestId, message: String(e && e.message || e) });
  }
}

// ------------------------------------------------------------------ main

function connect() {
  ws = new WebSocket('ws://127.0.0.1:' + PORT);
  ws.on('open', () => send({ event: REGISTER_EVENT, uuid: PLUGIN_UUID }));
  ws.on('close', () => process.exit(0));
  ws.on('error', (e) => { console.error('websocket error', e && e.message); });
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(String(raw)); } catch (e) { return; }
    switch (msg.event) {
      case 'willAppear': {
        contexts.set(msg.context, { settings: (msg.payload && msg.payload.settings) || {}, appliedIcon: null });
        noteAssignment(msg.context, contexts.get(msg.context).settings);
        applyIcon(msg.context, true);
        break;
      }
      case 'willDisappear':
        contexts.delete(msg.context);
        break;
      case 'didReceiveSettings': {
        const c = contexts.get(msg.context) || { appliedIcon: null };
        c.settings = (msg.payload && msg.payload.settings) || {};
        contexts.set(msg.context, c);
        noteAssignment(msg.context, c.settings);
        applyIcon(msg.context, false);
        break;
      }
      case 'keyDown':
        onKeyDown(msg);
        break;
      case 'sendToPlugin':
        onSendToPlugin(msg);
        break;
      default:
        break;
    }
  });
}

if (require.main === module) {
  if (!PORT || !PLUGIN_UUID || !REGISTER_EVENT) {
    console.error('Usage: node index.js -port <n> -pluginUUID <id> -registerEvent <name> -info <json>');
    process.exit(1);
  }
  connect();
}
