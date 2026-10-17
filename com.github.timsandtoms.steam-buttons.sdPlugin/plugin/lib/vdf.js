'use strict';
/*
 * Minimal, dependency-free readers for the Valve formats Steam Buttons needs:
 *   - text KeyValues   (libraryfolders.vdf, appmanifest_*.acf, localconfig.vdf, loginusers.vdf)
 *   - binary KeyValues (shortcuts.vdf)
 *   - appinfo.vdf      (v40 / v41, only the entries that are asked for)
 */
const fs = require('fs');

// ---------------------------------------------------------------- text VDF

const ESCAPES = { n: '\n', t: '\t', '\\': '\\', '"': '"' };

function parseText(text) {
  let i = 0;
  const n = text.length;

  function skip() {
    while (i < n) {
      const c = text.charCodeAt(i);
      if (c === 32 || c === 9 || c === 10 || c === 13 || c === 0xfeff) i++;
      else if (c === 47 && text.charCodeAt(i + 1) === 47) {
        while (i < n && text.charCodeAt(i) !== 10) i++;
      } else break;
    }
  }

  function quoted() {
    // text[i] is the opening quote
    let j = i + 1;
    let start = j;
    let out = '';
    while (j < n) {
      const c = text.charCodeAt(j);
      if (c === 92) {
        out += text.slice(start, j);
        const e = text[j + 1];
        out += ESCAPES[e] !== undefined ? ESCAPES[e] : e === undefined ? '' : e;
        j += 2;
        start = j;
      } else if (c === 34) {
        out += text.slice(start, j);
        i = j + 1;
        return out;
      } else j++;
    }
    out += text.slice(start, j);
    i = n;
    return out;
  }

  // Returns a string, '{', '}' or null at EOF
  function token() {
    skip();
    if (i >= n) return null;
    const ch = text[i];
    if (ch === '"') return { s: quoted() };
    if (ch === '{') { i++; return '{'; }
    if (ch === '}') { i++; return '}'; }
    const start = i;
    while (i < n && !/[\s{}"]/.test(text[i])) i++;
    return { s: text.slice(start, i) };
  }

  function object() {
    const obj = {};
    for (;;) {
      const k = token();
      if (k === null || k === '}') return obj;
      if (k === '{') continue;
      const v = token();
      if (v === null) return obj;
      if (v === '{') obj[k.s] = object();
      else if (v === '}') return obj;
      else obj[k.s] = v.s;
    }
  }

  return object();
}

function readTextFile(file) {
  return parseText(fs.readFileSync(file, 'utf8'));
}

/** Case-insensitive property lookup. */
function ci(obj, key) {
  if (!obj || typeof obj !== 'object') return undefined;
  if (key in obj) return obj[key];
  const lower = String(key).toLowerCase();
  for (const k of Object.keys(obj)) if (k.toLowerCase() === lower) return obj[k];
  return undefined;
}

/** Case-insensitive path lookup: ciPath(obj, 'a', 'b', 'c'). */
function ciPath(obj, ...keys) {
  let cur = obj;
  for (const k of keys) {
    cur = ci(cur, k);
    if (cur === undefined) return undefined;
  }
  return cur;
}

// -------------------------------------------------------------- binary VDF

function readCString(buf, pos) {
  let end = buf.indexOf(0, pos);
  if (end === -1) end = buf.length;
  return { s: buf.toString('utf8', pos, end), pos: end + 1 };
}

/**
 * Parse a binary KeyValues block starting at `pos`.
 * `strings` (optional) is the appinfo v41 string table; keys are then indices.
 * Returns { value, pos } where value is the object that was read.
 */
function parseBinary(buf, pos, strings) {
  function readKey() {
    if (strings) {
      const idx = buf.readUInt32LE(pos);
      pos += 4;
      return strings[idx] !== undefined ? strings[idx] : String(idx);
    }
    const r = readCString(buf, pos);
    pos = r.pos;
    return r.s;
  }

  function readObject(depth) {
    const obj = {};
    if (depth > 64) throw new Error('binary vdf nested too deeply');
    while (pos < buf.length) {
      const type = buf[pos++];
      if (type === 8) break; // end of object
      const key = readKey();
      switch (type) {
        case 0: obj[key] = readObject(depth + 1); break;
        case 1: { const r = readCString(buf, pos); obj[key] = r.s; pos = r.pos; break; }
        case 2: obj[key] = buf.readInt32LE(pos); pos += 4; break;
        case 3: obj[key] = buf.readFloatLE(pos); pos += 4; break;
        case 4: case 6: obj[key] = buf.readUInt32LE(pos); pos += 4; break;
        case 5: {
          let end = pos;
          while (end + 1 < buf.length && (buf[end] !== 0 || buf[end + 1] !== 0)) end += 2;
          obj[key] = buf.toString('utf16le', pos, end);
          pos = end + 2;
          break;
        }
        case 7: obj[key] = buf.readBigUInt64LE(pos).toString(); pos += 8; break;
        case 10: obj[key] = buf.readBigInt64LE(pos).toString(); pos += 8; break;
        default: throw new Error('unknown binary vdf type ' + type + ' at ' + (pos - 1));
      }
    }
    return obj;
  }

  const value = readObject(0);
  return { value, pos };
}

// ------------------------------------------------------------- appinfo.vdf

/** Small windowed reader so scanning 100k+ entries doesn't mean 100k syscalls. */
class FileWindow {
  constructor(fd, size) {
    this.fd = fd;
    this.size = size;
    this.start = 0;
    this.buf = Buffer.alloc(0);
  }
  read(pos, len) {
    if (pos + len > this.size) len = Math.max(0, this.size - pos);
    if (pos >= this.start && pos + len <= this.start + this.buf.length) {
      return this.buf.subarray(pos - this.start, pos - this.start + len);
    }
    const want = Math.min(this.size - pos, Math.max(len, 4 * 1024 * 1024));
    const b = Buffer.alloc(want);
    const got = fs.readSync(this.fd, b, 0, want, pos);
    this.buf = b.subarray(0, got);
    this.start = pos;
    return this.buf.subarray(0, Math.min(len, got));
  }
}

const APPINFO_V40 = 0x07564428;
const APPINFO_V41 = 0x07564429;

/**
 * Read selected entries out of appinfo.vdf.
 * @param {string} file
 * @param {Set<number>} wanted app ids to extract
 * @returns {Map<number, object>} appid -> the "appinfo" object ({ appid, common: {...}, ... })
 */
function readAppInfo(file, wanted) {
  const result = new Map();
  if (!wanted || wanted.size === 0) return result;
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const win = new FileWindow(fd, size);

    const head = win.read(0, 16);
    if (head.length < 8) return result;
    const magic = head.readUInt32LE(0);
    let pos;
    let strings = null;
    let limit = size;

    if (magic === APPINFO_V41) {
      pos = 16;
      const tableOffset = Number(head.readBigInt64LE(8));
      if (!(tableOffset > 16 && tableOffset < size)) return result;
      limit = tableOffset;
      const tb = Buffer.alloc(size - tableOffset);
      fs.readSync(fd, tb, 0, tb.length, tableOffset);
      const count = tb.readUInt32LE(0);
      strings = new Array(count);
      let p = 4;
      for (let i = 0; i < count && p < tb.length; i++) {
        const r = readCString(tb, p);
        strings[i] = r.s;
        p = r.pos;
      }
    } else if (magic === APPINFO_V40) {
      pos = 8;
    } else {
      return result; // unknown/older format
    }

    let remaining = wanted.size;
    while (pos + 8 <= limit && remaining > 0) {
      const h = win.read(pos, 8);
      if (h.length < 8) break;
      const appid = h.readUInt32LE(0);
      const entrySize = h.readUInt32LE(4);
      if (appid === 0 || entrySize < 60) break;
      if (wanted.has(appid)) {
        const entry = win.read(pos + 8, entrySize);
        if (entry.length === entrySize) {
          try {
            const kv = parseBinary(entry, 60, strings).value;
            result.set(appid, ci(kv, 'appinfo') || kv);
          } catch (e) { /* skip damaged entry */ }
        }
        remaining--;
      }
      pos += 8 + entrySize;
    }
  } catch (e) {
    /* unreadable appinfo just means fewer names */
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch (e) { /* ignore */ }
  }
  return result;
}

module.exports = { parseText, readTextFile, parseBinary, readAppInfo, ci, ciPath };
