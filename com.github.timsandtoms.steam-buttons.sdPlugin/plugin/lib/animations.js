'use strict';
/*
 * Animated key icons.
 *
 * OpenDeck (and the Stream Deck hardware) shows a single frame of whatever image a key is
 * given, so animated SteamGridDB art is played here: the property inspector turns the art into
 * a list of key-sized frames with a delay each (see ui/launch.js), sends them over, and the
 * plugin keeps calling setImage with the next frame.
 *
 * Frames are saved to a cache folder so keys keep animating after OpenDeck restarts. A button's
 * settings only hold the animation's id; if its frames are ever missing, the key shows its still
 * icon and the inspector rebuilds the animation the next time it is opened.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const MAX_FRAMES = 300;
const MAX_FRAME_CHARS = 400 * 1024;          // one frame's data URL
const MAX_TOTAL_CHARS = 48 * 1024 * 1024;    // one whole animation
const MIN_DELAY = 20, MAX_DELAY = 60000;
const CACHE_BYTES = 200 * 1024 * 1024;       // all saved animations together
const CACHE_FILES = 300;
const MEMORY_ITEMS = 24;
const INCOMING_TTL = 2 * 60 * 1000;          // a half-received animation is dropped after this
const FRAME_RE = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/;

function validId(id) { return typeof id === 'string' && /^[0-9a-f]{8,40}$/.test(id); }

/** Per-user cache folder, outside the plugin folder (which is replaced on every update). */
function defaultCacheDir() {
  const home = os.homedir();
  let base;
  if (process.platform === 'win32') base = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  else if (process.platform === 'darwin') base = path.join(home, 'Library', 'Caches');
  else base = process.env.XDG_CACHE_HOME || path.join(home, '.cache');
  return path.join(base, 'steam-buttons', 'animations');
}

/** @returns {{frames: string[], delays: number[]} | null} a clean copy, or null if anything is off */
function validate(anim) {
  if (!anim || !Array.isArray(anim.frames) || !Array.isArray(anim.delays)) return null;
  const n = anim.frames.length;
  if (n < 1 || n > MAX_FRAMES || anim.delays.length !== n) return null;
  let total = 0;
  for (const f of anim.frames) {
    if (typeof f !== 'string' || f.length > MAX_FRAME_CHARS || !FRAME_RE.test(f)) return null;
    total += f.length;
  }
  if (total > MAX_TOTAL_CHARS) return null;
  const delays = anim.delays.map((d) => Math.round(Math.min(MAX_DELAY, Math.max(MIN_DELAY, Number(d) || 100))));
  return { frames: anim.frames.slice(), delays };
}

class AnimationStore {
  /** @param {string} [dir] cache folder (default: the per-user cache folder) */
  constructor(dir) {
    this.dir = dir || defaultCacheDir();
    this.memory = new Map();   // id -> {frames, delays}, most recently used last
    this.incoming = new Map(); // id -> {parts: [], count, total, delays, at}
    this.loading = new Map();  // id -> Promise
  }

  file(id) { return path.join(this.dir, id + '.json'); }

  _remember(id, anim) {
    this.memory.delete(id);
    this.memory.set(id, anim);
    while (this.memory.size > MEMORY_ITEMS) this.memory.delete(this.memory.keys().next().value);
  }

  /**
   * Takes one part of an animation from the inspector.
   * @returns {Promise<boolean|null>} null while parts are still missing, then whether it was saved
   */
  async receive(p) {
    const now = Date.now();
    for (const [k, v] of this.incoming) if (now - v.at > INCOMING_TTL) this.incoming.delete(k);
    const id = p && p.id;
    const parts = Number(p && p.parts), part = Number(p && p.part);
    if (!validId(id) || !(parts >= 1 && parts <= MAX_FRAMES) || !(part >= 0 && part < parts) || !Array.isArray(p.frames)) return false;
    let entry = this.incoming.get(id);
    if (!entry || entry.total !== parts) {
      entry = { parts: new Array(parts), count: 0, total: parts, delays: null, at: now };
      this.incoming.set(id, entry);
    }
    entry.at = now;
    if (!entry.parts[part]) entry.count++;
    entry.parts[part] = p.frames;
    if (Array.isArray(p.delays)) entry.delays = p.delays;
    if (entry.count < parts) return null;
    this.incoming.delete(id);
    return this.put(id, { frames: [].concat(...entry.parts), delays: entry.delays });
  }

  /** Saves a whole animation (to memory, and to disk when possible). */
  async put(id, anim) {
    const clean = validId(id) && validate(anim);
    if (!clean) return false;
    this._remember(id, clean);
    try {
      await fs.promises.mkdir(this.dir, { recursive: true });
      const tmp = this.file(id) + '.' + process.pid + '.tmp';
      await fs.promises.writeFile(tmp, JSON.stringify({ v: 1, frames: clean.frames, delays: clean.delays }));
      await fs.promises.rename(tmp, this.file(id));
    } catch (e) { /* still playable from memory this session */ }
    return true;
  }

  /** @returns {Promise<{frames: string[], delays: number[]} | null>} */
  get(id) {
    if (!validId(id)) return Promise.resolve(null);
    if (this.memory.has(id)) {
      const hit = this.memory.get(id);
      this._remember(id, hit);
      return Promise.resolve(hit);
    }
    if (this.loading.has(id)) return this.loading.get(id);
    const job = (async () => {
      try {
        const raw = JSON.parse(await fs.promises.readFile(this.file(id), 'utf8'));
        const clean = validate(raw);
        if (!clean) return null;
        this._remember(id, clean);
        const t = new Date();
        fs.promises.utimes(this.file(id), t, t).catch(() => {}); // mark as recently used
        return clean;
      } catch (e) { return null; }
    })();
    this.loading.set(id, job);
    job.then(() => this.loading.delete(id), () => this.loading.delete(id));
    return job;
  }

  async has(id) {
    if (!validId(id)) return false;
    if (this.memory.has(id)) return true;
    try { await fs.promises.access(this.file(id)); return true; } catch (e) { return false; }
  }

  /** Deletes the least recently used files beyond the cache limits, never one in `keep`. */
  async prune(keep) {
    let names;
    try { names = await fs.promises.readdir(this.dir); } catch (e) { return; }
    const files = [];
    for (const name of names) {
      const m = /^([0-9a-f]{8,40})\.json$/.exec(name);
      if (!m) continue;
      try {
        const st = await fs.promises.stat(path.join(this.dir, name));
        files.push({ id: m[1], size: st.size, t: st.mtimeMs });
      } catch (e) { /* gone */ }
    }
    files.sort((a, b) => b.t - a.t); // newest first
    let bytes = 0, count = 0;
    for (const f of files) {
      bytes += f.size; count++;
      if ((bytes > CACHE_BYTES || count > CACHE_FILES) && !(keep && keep.has(f.id))) {
        fs.promises.unlink(this.file(f.id)).catch(() => {});
        this.memory.delete(f.id);
      }
    }
  }
}

/**
 * Plays animations on keys. `show(context, frame)` is called with each frame; the caller turns
 * that into a setImage.
 */
class Animator {
  constructor(store, show) {
    this.store = store;
    this.show = show;
    this.running = new Map(); // context -> {id, timer, index, anim, ready}
  }

  /** The animation id a key's settings ask for, or null. */
  static wanted(settings) {
    const a = settings && settings.iconStyle === 'sgdb' && settings.sgdb && settings.sgdb.anim;
    return a && validId(a.id) ? a.id : null;
  }

  /** True while the key is showing animation frames (so its still icon must not be applied). */
  playing(context) {
    const r = this.running.get(context);
    return !!(r && r.ready);
  }

  /**
   * Starts, keeps or stops the key's animation so it matches `id`.
   * @returns {boolean} true if the key just stopped playing an animation
   */
  sync(context, id) {
    const cur = this.running.get(context);
    if (cur && cur.id === id && (cur.ready || cur.pending)) return false;
    const wasPlaying = !!(cur && cur.ready);
    this.stop(context);
    if (!id) return wasPlaying;
    const run = { id, timer: null, index: 0, anim: null, ready: false, pending: true };
    this.running.set(context, run);
    this.store.get(id).then((anim) => {
      if (this.running.get(context) !== run) return;
      run.pending = false;
      if (!anim || anim.frames.length < 1) return; // not here (yet): the still icon stays
      run.anim = anim;
      run.ready = true;
      this._tick(context, run);
    });
    return wasPlaying;
  }

  _tick(context, run) {
    if (this.running.get(context) !== run) return;
    const { frames, delays } = run.anim;
    const i = run.index % frames.length;
    this.show(context, frames[i]);
    if (frames.length < 2) return;
    run.index = i + 1;
    run.timer = setTimeout(() => this._tick(context, run), delays[i]);
  }

  stop(context) {
    const cur = this.running.get(context);
    if (!cur) return;
    clearTimeout(cur.timer);
    this.running.delete(context);
  }

  /** Contexts that want `id` but couldn't play it yet (its frames arrived later). */
  waitingFor(id) {
    const out = [];
    for (const [context, run] of this.running) if (run.id === id && !run.ready && !run.pending) out.push(context);
    return out;
  }

  /** Ids in use, so pruning never deletes them. */
  inUse() { return new Set([...this.running.values()].map((r) => r.id)); }
}

module.exports = { AnimationStore, Animator, validId, validate, defaultCacheDir };
