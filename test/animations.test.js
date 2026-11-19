'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const root = path.join(__dirname, '..', 'com.github.timsandtoms.steam-buttons.sdPlugin');
const AT = require(path.join(root, 'shared', 'anim-tools.js'));
const { AnimationStore, Animator, validate } = require(path.join(root, 'plugin', 'lib', 'animations.js'));
const { SteamGridDb, cleanItem, sniffMime } = require(path.join(root, 'plugin', 'lib', 'steamgriddb.js'));

// ------------------------------------------------------------ test files

function u32be(n) { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0); return b; }
function u16be(n) { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; }
function png(type, data) { return Buffer.from(AT.pngChunk(type, new Uint8Array(data))); }

/** A real APNG: `frames` solid-colour RGBA frames of w x h at (x, y). */
function makeApng(width, height, frames, opts) {
  opts = opts || {};
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.concat([u32be(width), u32be(height), Buffer.from([8, 6, 0, 0, 0])]);
  const parts = [sig, png('IHDR', ihdr), png('acTL', Buffer.concat([u32be(frames.length), u32be(0)]))];
  if (opts.gamma) parts.push(png('gAMA', u32be(45455)));
  let seq = 0;
  frames.forEach((f, i) => {
    parts.push(png('fcTL', Buffer.concat([u32be(seq++), u32be(f.w), u32be(f.h), u32be(f.x), u32be(f.y),
      u16be(f.num || 1), u16be(f.den || 10), Buffer.from([f.dispose || 0, f.blend || 0])])));
    const raw = Buffer.alloc((f.w * 4 + 1) * f.h);
    for (let y = 0; y < f.h; y++) for (let x = 0; x < f.w; x++) raw.set(f.rgba, y * (f.w * 4 + 1) + 1 + x * 4);
    const z = zlib.deflateSync(raw);
    if (i === 0) parts.push(png('IDAT', z));
    else parts.push(png('fdAT', Buffer.concat([u32be(seq++), z])));
  });
  parts.push(png('IEND', Buffer.alloc(0)));
  return Buffer.concat(parts);
}

function riff(id, payload) {
  const head = Buffer.alloc(8);
  head.write(id, 0, 'ascii');
  head.writeUInt32LE(payload.length, 4);
  return Buffer.concat([head, payload, payload.length & 1 ? Buffer.alloc(1) : Buffer.alloc(0)]);
}
function u24le(n) { return Buffer.from([n & 255, (n >> 8) & 255, (n >> 16) & 255]); }

/** An animated WebP container. Frame bitstreams are placeholders: demux only moves them around. */
function makeWebp(width, height, frames) {
  const vp8x = Buffer.concat([Buffer.from([0x12, 0, 0, 0]), u24le(width - 1), u24le(height - 1)]);
  const chunks = [riff('VP8X', vp8x), riff('ANIM', Buffer.from([0, 0, 0, 0, 3, 0]))];
  for (const f of frames) {
    const head = Buffer.concat([u24le(f.x / 2), u24le(f.y / 2), u24le(f.w - 1), u24le(f.h - 1), u24le(f.delay), Buffer.from([f.flags || 0])]);
    const subs = f.alpha
      ? [riff('ALPH', Buffer.from('alpha!')), riff('VP8 ', Buffer.from('lossy-bits'))]
      : [riff('VP8L', Buffer.from('lossless-bits'))];
    chunks.push(riff('ANMF', Buffer.concat([head, ...subs])));
  }
  const body = Buffer.concat([Buffer.from('WEBP'), ...chunks]);
  const head = Buffer.alloc(8);
  head.write('RIFF', 0, 'ascii');
  head.writeUInt32LE(body.length, 4);
  return Buffer.concat([head, body]);
}

const RED = [255, 0, 0, 255], BLUE = [0, 0, 255, 255];

// ------------------------------------------------------------- AnimTools

test('demux splits an APNG into standalone, valid PNG frames', () => {
  const file = makeApng(8, 6, [
    { x: 0, y: 0, w: 8, h: 6, rgba: RED, num: 1, den: 10 },
    { x: 2, y: 2, w: 4, h: 3, rgba: BLUE, num: 0, den: 0, dispose: 1, blend: 1 },
    { x: 0, y: 0, w: 8, h: 6, rgba: RED, num: 25, den: 100, dispose: 2 }
  ], { gamma: true });
  const d = AT.demux(file);
  assert.equal(d.format, 'apng');
  assert.equal(d.width, 8);
  assert.equal(d.height, 6);
  assert.deepEqual(d.frames.map((f) => [f.x, f.y, f.w, f.h, f.delay, f.dispose, f.blend]), [
    [0, 0, 8, 6, 100, 'none', 'source'],
    [2, 2, 4, 3, 100, 'background', 'over'], // a 0 delay is played as 100 ms, like browsers do
    [0, 0, 8, 6, 250, 'previous', 'source']
  ]);
  // Each frame is a complete PNG of its own size, with the shared chunks and correct CRCs.
  const f = Buffer.from(d.frames[1].file);
  assert.equal(f.readUInt32BE(16), 4);
  assert.equal(f.readUInt32BE(20), 3);
  assert.ok(f.includes(Buffer.from('gAMA')));
  let at = 8;
  const types = [];
  while (at < f.length) {
    const len = f.readUInt32BE(at), type = f.toString('ascii', at + 4, at + 8);
    const crc = f.readUInt32BE(at + 8 + len);
    assert.equal(crc, AT.crc32([f.subarray(at + 4, at + 8 + len)]), 'CRC of ' + type);
    types.push(type);
    at += 12 + len;
  }
  assert.deepEqual(types, ['IHDR', 'gAMA', 'IDAT', 'IEND']);
  // and its pixels are the frame's (blue), proving fdAT was turned back into IDAT correctly
  const idat = f.subarray(f.indexOf(Buffer.from('IDAT')) + 4);
  const raw = zlib.inflateSync(idat.subarray(0, idat.length - 4 - 12));
  assert.deepEqual([...raw.subarray(1, 5)], BLUE);
});

test('demux splits an animated WebP and rebuilds each frame as a still WebP', () => {
  const d = AT.demux(makeWebp(100, 80, [
    { x: 0, y: 0, w: 100, h: 80, delay: 40 },
    { x: 10, y: 20, w: 30, h: 30, delay: 0, flags: 0x03, alpha: true }
  ]));
  assert.equal(d.format, 'webp');
  assert.deepEqual([d.width, d.height, d.loops], [100, 80, 3]);
  assert.deepEqual(d.frames.map((f) => [f.x, f.y, f.w, f.h, f.delay, f.blend, f.dispose]), [
    [0, 0, 100, 80, 40, 'over', 'none'],
    [10, 20, 30, 30, 100, 'source', 'background']
  ]);
  const lossless = Buffer.from(d.frames[0].file);
  assert.equal(lossless.toString('ascii', 0, 4), 'RIFF');
  assert.equal(lossless.readUInt32LE(4), lossless.length - 8);
  assert.equal(lossless.toString('ascii', 12, 16), 'VP8L');
  // A lossy frame with alpha gets a VP8X header (alpha flag, frame size) + ALPH + VP8.
  const alpha = Buffer.from(d.frames[1].file);
  assert.equal(alpha.toString('ascii', 12, 16), 'VP8X');
  assert.equal(alpha[20], 0x10);
  assert.equal(alpha.readUIntLE(24, 3) + 1, 30);
  assert.ok(alpha.includes(Buffer.from('ALPH')) && alpha.includes(Buffer.from('VP8 ')));
});

test('demux returns null for still images, junk and oversized canvases', () => {
  assert.equal(AT.demux(makeApng(4, 4, [{ x: 0, y: 0, w: 4, h: 4, rgba: RED }])), null);
  assert.equal(AT.demux(Buffer.from('definitely not an image')), null);
  assert.equal(AT.demux(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0])), null);
  assert.equal(AT.demux(makeWebp(5000, 10, [{ x: 0, y: 0, w: 10, h: 10, delay: 50 }, { x: 0, y: 0, w: 10, h: 10, delay: 50 }])), null);
  // A frame outside the canvas is dropped rather than trusted.
  const d = AT.demux(makeWebp(20, 20, [
    { x: 0, y: 0, w: 20, h: 20, delay: 50 }, { x: 0, y: 0, w: 20, h: 20, delay: 50 }, { x: 10, y: 10, w: 20, h: 20, delay: 50 }
  ]));
  assert.equal(d.frames.length, 2);
});

test('schedule keeps every frame of a slow animation and thins out a fast one', () => {
  assert.deepEqual(AT.schedule([100, 200, 100]), { keep: [true, true, true], delays: [100, 200, 100] });
  const fast = AT.schedule(new Array(10).fill(20), { minMs: 50 });
  assert.deepEqual(fast.keep, [true, false, false, true, false, false, true, false, false, true]);
  assert.equal(fast.delays.reduce((a, b) => a + b, 0), 200); // the loop still lasts as long
  const long = AT.schedule(new Array(1000).fill(60), { minMs: 50, maxFrames: 100 });
  assert.ok(long.delays.length <= 100);
  assert.equal(long.delays.reduce((a, b) => a + b, 0), 60000);
});

test('animId is stable and sensitive to the crop', () => {
  const a = AT.animId(JSON.stringify(['https://x/1.webp', { x: 0.5 }]));
  assert.match(a, /^[0-9a-f]{16}$/);
  assert.equal(a, AT.animId(JSON.stringify(['https://x/1.webp', { x: 0.5 }])));
  assert.notEqual(a, AT.animId(JSON.stringify(['https://x/1.webp', { x: 0.51 }])));
});

// -------------------------------------------------------- AnimationStore

const FRAME = 'data:image/jpeg;base64,' + Buffer.from('jpeg bytes').toString('base64');
const ID = '0123456789abcdef';

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'sb-anim-')); }

test('validate refuses anything that is not a list of image data URLs with delays', () => {
  assert.deepEqual(validate({ frames: [FRAME, FRAME], delays: [5, 'x'] }), { frames: [FRAME, FRAME], delays: [20, 100] });
  assert.equal(validate({ frames: ['javascript:alert(1)'], delays: [100] }), null);
  assert.equal(validate({ frames: [FRAME], delays: [] }), null);
  assert.equal(validate({ frames: [], delays: [] }), null);
});

test('the store assembles parts, saves to disk, and loads them back in a new session', async () => {
  const dir = tmpDir();
  const store = new AnimationStore(dir);
  assert.equal(await store.receive({ id: ID, part: 1, parts: 2, frames: [FRAME] }), null);
  assert.equal(await store.has(ID), false);
  assert.equal(await store.receive({ id: ID, part: 0, parts: 2, frames: [FRAME, FRAME], delays: [50, 60, 70] }), true);
  assert.ok(fs.existsSync(path.join(dir, ID + '.json')));

  const later = new AnimationStore(dir);
  assert.equal(await later.has(ID), true);
  assert.deepEqual(await later.get(ID), { frames: [FRAME, FRAME, FRAME], delays: [50, 60, 70] });
  assert.equal(await later.get('nope'), null);
  assert.equal(await later.receive({ id: '../../etc', part: 0, parts: 1, frames: [FRAME], delays: [1] }), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the animator plays frames in a loop and stops cleanly', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const store = new AnimationStore(tmpDir());
  const a = 'data:image/png;base64,QQ==', b = 'data:image/png;base64,Qg==';
  await store.put(ID, { frames: [a, b], delays: [100, 300] });
  const shown = [];
  const animator = new Animator(store, (ctx, frame) => shown.push(frame));
  const settings = { iconStyle: 'sgdb', sgdb: { anim: { id: ID } } };
  assert.equal(Animator.wanted(settings), ID);
  assert.equal(Animator.wanted({ iconStyle: 'cover', sgdb: { anim: { id: ID } } }), null);

  animator.sync('k1', ID);
  await store.get(ID);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(shown, [a]);
  assert.equal(animator.playing('k1'), true);
  t.mock.timers.tick(100);
  assert.deepEqual(shown, [a, b]);
  t.mock.timers.tick(300);
  assert.deepEqual(shown, [a, b, a]);
  assert.equal(animator.sync('k1', ID), false); // already playing: nothing restarts
  assert.equal(animator.sync('k1', null), true); // stopped
  t.mock.timers.tick(1000);
  assert.deepEqual(shown, [a, b, a]);

  animator.sync('k2', 'ffffffffffffffff'); // not in the store: waits, shows nothing
  await store.get('ffffffffffffffff');      // the same lookup the animator is waiting on
  await new Promise((r) => setImmediate(r));
  assert.equal(animator.playing('k2'), false);
  assert.deepEqual(animator.waitingFor('ffffffffffffffff'), ['k2']);
});

// --------------------------------------------------- SteamGridDB, animated

test('cleanItem marks art previewed by a video clip as animated', () => {
  const still = cleanItem({ id: 1, url: 'https://cdn2.steamgriddb.com/grid/a.png', thumb: 'https://cdn2.steamgriddb.com/thumb/a.jpg' });
  const moving = cleanItem({ id: 2, url: 'https://cdn2.steamgriddb.com/grid/b.webp', thumb: 'https://cdn2.steamgriddb.com/thumb/b.webm' });
  assert.equal(still.animated, false);
  assert.equal(moving.animated, true);
});

test('assets asks for the requested static/animated types', async () => {
  const log = [];
  const request = (options, cb) => {
    const req = new EventEmitter();
    req.destroy = () => {};
    req.end = () => {
      log.push(options.path);
      setImmediate(() => {
        const res = new EventEmitter();
        res.statusCode = 200;
        res.headers = {};
        cb(res);
        res.emit('data', Buffer.from(JSON.stringify({ success: true, data: [] })));
        res.emit('end');
      });
    };
    return req;
  };
  const sg = new SteamGridDb({ request });
  const KEY = 'abcd1234abcd1234';
  await sg.assets(KEY, { gameId: 1, type: 'grids', types: ['static', 'animated'] });
  await sg.assets(KEY, { gameId: 1, type: 'grids', types: ['animated', 'bogus'] });
  await sg.assets(KEY, { gameId: 1, type: 'grids', types: ['bogus'] });
  assert.match(log[0], /types=static,animated/);
  assert.match(log[1], /types=animated(&|$)/);
  assert.match(log[2], /types=static(&|$)/);
});

test('sniffMime recognises the preview clips of animated art', () => {
  assert.equal(sniffMime(Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(20)])), 'video/webm');
  assert.equal(sniffMime(Buffer.concat([Buffer.alloc(4), Buffer.from('ftypisom'), Buffer.alloc(8)])), 'video/mp4');
});
