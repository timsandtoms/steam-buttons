/*
 * Steam Buttons - animated artwork helpers.
 *
 * Loaded by the property inspector (as a plain <script>) and required by the tests.
 *
 * Neither OpenDeck nor the Stream Deck hardware plays an animated key image: they show one
 * frame. So the inspector splits animated SteamGridDB art (animated WebP, or the older APNG)
 * into its frames, draws each one through the button's crop, and the plugin then plays those
 * frames on the key itself.
 *
 * demux() does the splitting without decoding any pixels: every frame comes back as a small
 * standalone still image file (WebP or PNG) that the web view can decode natively, plus where
 * it goes on the canvas and how it is blended and disposed of.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AnimTools = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var MAX_SIDE = 4096;       // larger canvases are refused
  var MAX_SOURCE_FRAMES = 1000;

  function u8(buf) { return buf instanceof Uint8Array ? buf : new Uint8Array(buf); }
  function ascii(b, at, n) { var s = ''; for (var i = 0; i < n; i++) s += String.fromCharCode(b[at + i]); return s; }
  function le16(b, at) { return b[at] | (b[at + 1] << 8); }
  function le24(b, at) { return b[at] | (b[at + 1] << 8) | (b[at + 2] << 16); }
  function le32(b, at) { return (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0; }
  function be16(b, at) { return (b[at] << 8) | b[at + 1]; }
  function be32(b, at) { return ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0; }

  function concat(parts) {
    var n = 0, i;
    for (i = 0; i < parts.length; i++) n += parts[i].length;
    var out = new Uint8Array(n), at = 0;
    for (i = 0; i < parts.length; i++) { out.set(parts[i], at); at += parts[i].length; }
    return out;
  }

  /** Frame delays as browsers treat them: 10 ms or less means 100 ms. */
  function fixDelay(ms) { return !(ms > 10) ? 100 : Math.min(ms, 60000); }

  // ------------------------------------------------------------------ WebP

  function isWebp(b) { return b.length >= 16 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP'; }

  /** RIFF chunks between from and to: [{ id, at (payload start), size, end (next chunk) }] */
  function riffChunks(b, from, to) {
    var out = [];
    var at = from;
    while (at + 8 <= to) {
      var id = ascii(b, at, 4), size = le32(b, at + 4);
      var start = at + 8, end = start + size + (size & 1);
      if (start + size > to) break;
      out.push({ id: id, at: start, size: size, end: Math.min(end, to) });
      at = end;
    }
    return out;
  }

  function riffChunk(id, payload) {
    var head = new Uint8Array(8);
    for (var i = 0; i < 4; i++) head[i] = id.charCodeAt(i);
    var n = payload.length;
    head[4] = n & 255; head[5] = (n >> 8) & 255; head[6] = (n >> 16) & 255; head[7] = (n >>> 24) & 255;
    return n & 1 ? concat([head, payload, new Uint8Array(1)]) : concat([head, payload]);
  }

  function riffFile(chunks) {
    var body = concat([new Uint8Array([0x57, 0x45, 0x42, 0x50])].concat(chunks)); // "WEBP"
    var head = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0]);               // "RIFF"
    var n = body.length;
    head[4] = n & 255; head[5] = (n >> 8) & 255; head[6] = (n >> 16) & 255; head[7] = (n >>> 24) & 255;
    return concat([head, body]);
  }

  function demuxWebp(b) {
    var top = riffChunks(b, 12, Math.min(b.length, 8 + le32(b, 4)));
    var vp8x = top.filter(function (c) { return c.id === 'VP8X'; })[0];
    if (!vp8x || vp8x.size < 10 || !(b[vp8x.at] & 0x02)) return null; // no animation flag
    var width = le24(b, vp8x.at + 4) + 1, height = le24(b, vp8x.at + 7) + 1;
    var anim = top.filter(function (c) { return c.id === 'ANIM'; })[0];
    var loops = anim && anim.size >= 6 ? le16(b, anim.at + 4) : 0;
    var frames = [];
    top.forEach(function (c) {
      if (c.id !== 'ANMF' || c.size < 16 || frames.length >= MAX_SOURCE_FRAMES) return;
      var p = c.at;
      var x = le24(b, p) * 2, y = le24(b, p + 3) * 2;
      var w = le24(b, p + 6) + 1, h = le24(b, p + 9) + 1;
      var delay = le24(b, p + 12), flags = b[p + 15];
      var subs = riffChunks(b, p + 16, c.at + c.size);
      var alph = null, image = null;
      subs.forEach(function (s) {
        if (s.id === 'ALPH' && !alph) alph = s;
        else if ((s.id === 'VP8 ' || s.id === 'VP8L') && !image) image = s;
      });
      if (!image || x + w > width || y + h > height) return;
      var parts = [];
      if (image.id === 'VP8 ' && alph) {
        // A lossy frame with alpha needs the extended header to say so.
        var x8 = new Uint8Array(10);
        x8[0] = 0x10;
        x8[4] = (w - 1) & 255; x8[5] = ((w - 1) >> 8) & 255; x8[6] = ((w - 1) >> 16) & 255;
        x8[7] = (h - 1) & 255; x8[8] = ((h - 1) >> 8) & 255; x8[9] = ((h - 1) >> 16) & 255;
        parts.push(riffChunk('VP8X', x8));
        parts.push(riffChunk('ALPH', b.subarray(alph.at, alph.at + alph.size)));
      }
      parts.push(riffChunk(image.id, b.subarray(image.at, image.at + image.size)));
      frames.push({
        x: x, y: y, w: w, h: h, delay: fixDelay(delay),
        blend: flags & 0x02 ? 'source' : 'over',
        dispose: flags & 0x01 ? 'background' : 'none',
        mime: 'image/webp', file: riffFile(parts)
      });
    });
    return frames.length > 1 ? { format: 'webp', width: width, height: height, loops: loops, frames: frames } : null;
  }

  // ------------------------------------------------------------------ APNG

  var PNG_SIG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  var CRC_TABLE = (function () {
    var t = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(parts) {
    var c = 0xffffffff;
    for (var p = 0; p < parts.length; p++) {
      var buf = parts[p];
      for (var i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    }
    return (c ^ 0xffffffff) >>> 0;
  }

  function pngChunk(type, data) {
    var head = new Uint8Array(8), tail = new Uint8Array(4);
    var n = data.length;
    head[0] = n >>> 24; head[1] = (n >> 16) & 255; head[2] = (n >> 8) & 255; head[3] = n & 255;
    for (var i = 0; i < 4; i++) head[4 + i] = type.charCodeAt(i);
    var crc = crc32([head.subarray(4), data]);
    tail[0] = crc >>> 24; tail[1] = (crc >> 16) & 255; tail[2] = (crc >> 8) & 255; tail[3] = crc & 255;
    return concat([head, data, tail]);
  }

  function isPng(b) {
    if (b.length < 8) return false;
    for (var i = 0; i < 8; i++) if (b[i] !== PNG_SIG[i]) return false;
    return true;
  }

  function demuxApng(b) {
    var at = 8, ihdr = null, actl = false, pre = [], frames = [], cur = null, seenIdat = false;
    var DISPOSE = ['none', 'background', 'previous'];
    function finish() {
      if (cur && cur.data.length) frames.push(cur);
      cur = null;
    }
    while (at + 12 <= b.length) {
      var len = be32(b, at), type = ascii(b, at + 4, 4), p = at + 8;
      if (p + len + 4 > b.length) break;
      var data = b.subarray(p, p + len);
      if (type === 'IHDR') ihdr = data;
      else if (type === 'acTL') actl = true;
      else if (type === 'fcTL' && len >= 26) {
        finish();
        if (frames.length >= MAX_SOURCE_FRAMES) break;
        var num = be16(data, 20), den = be16(data, 22) || 100;
        cur = {
          w: be32(data, 4), h: be32(data, 8), x: be32(data, 12), y: be32(data, 16),
          delay: fixDelay(Math.round(num * 1000 / den)),
          dispose: DISPOSE[data[24]] || 'none', blend: data[25] === 1 ? 'over' : 'source',
          data: []
        };
      } else if (type === 'IDAT') {
        seenIdat = true;
        if (cur) cur.data.push(data); // an IDAT before any fcTL is a default image that isn't part of the animation
      } else if (type === 'fdAT' && len > 4) {
        if (cur) cur.data.push(data.subarray(4));
      } else if (type === 'IEND') break;
      else if (!seenIdat && !cur && type !== 'acTL') pre.push(pngChunk(type, data)); // PLTE, tRNS, gAMA, ...
      at = p + len + 4;
    }
    finish();
    if (!ihdr || ihdr.length < 13 || !actl || frames.length < 2) return null;
    var width = be32(ihdr, 0), height = be32(ihdr, 4);
    if (frames[0].dispose === 'previous') frames[0].dispose = 'background';
    var out = [];
    frames.forEach(function (f) {
      if (!f.w || !f.h || f.x + f.w > width || f.y + f.h > height) return;
      var hdr = new Uint8Array(ihdr);
      hdr[0] = f.w >>> 24; hdr[1] = (f.w >> 16) & 255; hdr[2] = (f.w >> 8) & 255; hdr[3] = f.w & 255;
      hdr[4] = f.h >>> 24; hdr[5] = (f.h >> 16) & 255; hdr[6] = (f.h >> 8) & 255; hdr[7] = f.h & 255;
      var file = concat([PNG_SIG, pngChunk('IHDR', hdr)].concat(pre)
        .concat(f.data.map(function (d) { return pngChunk('IDAT', d); }))
        .concat([pngChunk('IEND', new Uint8Array(0))]));
      out.push({ x: f.x, y: f.y, w: f.w, h: f.h, delay: f.delay, blend: f.blend, dispose: f.dispose, mime: 'image/png', file: file });
    });
    return out.length > 1 ? { format: 'apng', width: width, height: height, loops: 0, frames: out } : null;
  }

  // ---------------------------------------------------------------- public

  /**
   * Splits an animated WebP or APNG into frames.
   * @returns {{format: string, width: number, height: number, loops: number,
   *   frames: {x: number, y: number, w: number, h: number, delay: number, blend: string,
   *            dispose: string, mime: string, file: Uint8Array}[]} | null}
   *   null for still images, other formats, or files too damaged or too big to use.
   */
  function demux(buf) {
    var b = u8(buf);
    var out = null;
    try {
      if (isWebp(b)) out = demuxWebp(b);
      else if (isPng(b)) out = demuxApng(b);
    } catch (e) { out = null; }
    if (!out || out.width > MAX_SIDE || out.height > MAX_SIDE || out.width < 1 || out.height < 1) return null;
    return out;
  }

  /**
   * Picks which source frames to keep so the key is never asked to change faster than once
   * every minMs, and never holds more than maxFrames pictures. A dropped frame isn't lost: it
   * is painted onto the canvas anyway, and shows up in the next frame that is kept.
   * @param {number[]} delays per source frame, in ms
   * @returns {{keep: boolean[], delays: number[]}} keep[i]: capture after source frame i;
   *   delays: how long each captured picture stays up
   */
  function schedule(delays, opts) {
    opts = opts || {};
    var minMs = opts.minMs || 50, maxFrames = opts.maxFrames || 150;
    var total = 0, i;
    for (i = 0; i < delays.length; i++) total += delays[i];
    var gap = Math.max(minMs, total / maxFrames);
    var keep = [], starts = [], t = 0, last = -Infinity;
    for (i = 0; i < delays.length; i++) {
      // Frame i first shows at t; keep it when enough time has passed since the last kept one.
      var take = i === 0 || (t - last >= gap - 0.5 && starts.length < maxFrames);
      keep.push(take);
      if (take) { starts.push(t); last = t; }
      t += delays[i];
    }
    var out = [];
    for (i = 0; i < starts.length; i++) out.push(Math.round((i + 1 < starts.length ? starts[i + 1] : total) - starts[i]));
    return { keep: keep, delays: out };
  }

  /** Short stable id for an animation: the art plus the crop it is drawn with. */
  function animId(text) {
    var s = String(text);
    var a = 0x811c9dc5, b = 0x01000193 ^ s.length;
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      a = Math.imul(a ^ c, 0x01000193) >>> 0;
      b = Math.imul(b ^ s.charCodeAt(s.length - 1 - i), 0x01000193) >>> 0;
    }
    return ('0000000' + a.toString(16)).slice(-8) + ('0000000' + b.toString(16)).slice(-8);
  }

  return { demux: demux, schedule: schedule, animId: animId, crc32: crc32, pngChunk: pngChunk };
});
