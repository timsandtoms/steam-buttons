#!/usr/bin/env node
'use strict';
/*
 * Build the plugin zip locally, the same way the release workflow does.
 *
 *   node scripts/package.js            -> dist/com.github.timsandtoms.steam-buttons.sdPlugin.zip
 *   node scripts/package.js --install  -> also installs it into OpenDeck's plugins folder
 *
 * Runtime dependencies are installed fresh (npm ci --omit=dev) into a temporary copy, so the zip
 * never picks up dev-only files, and your working folder is left untouched. No external zip tool is
 * needed (works the same on Windows, macOS and Linux). Restart OpenDeck after installing.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const pluginDir = fs.readdirSync(root).find((d) => d.endsWith('.sdPlugin') && fs.statSync(path.join(root, d)).isDirectory());
if (!pluginDir) { console.error('Could not find the *.sdPlugin folder.'); process.exit(1); }
const install = process.argv.includes('--install');

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(buf) { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }

function walk(dir, base) {
  const out = [];
  for (const name of fs.readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    const rel = base ? base + '/' + name : name;
    if (fs.statSync(full).isDirectory()) out.push(...walk(full, rel)); else out.push({ full, rel });
  }
  return out;
}

function writeZip(files, dest) {
  const parts = [], central = [];
  let offset = 0;
  const d = new Date(), dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const dosDate = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  for (const f of files) {
    const data = fs.readFileSync(f.full);
    const comp = zlib.deflateRawSync(data, { level: 9 });
    const name = Buffer.from(f.rel, 'utf8');
    const crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(8, 8);
    lh.writeUInt16LE(dosTime, 10); lh.writeUInt16LE(dosDate, 12); lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(name.length, 26);
    parts.push(lh, name, comp);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE((3 << 8) | 20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(8, 10); ch.writeUInt16LE(dosTime, 12); ch.writeUInt16LE(dosDate, 14); ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(((0o100644) << 16) >>> 0, 38); ch.writeUInt32LE(offset, 42);
    central.push(ch, name);
    offset += 30 + name.length + comp.length;
  }
  const cdSize = central.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cdSize, 12); end.writeUInt32LE(offset, 16);
  fs.writeFileSync(dest, Buffer.concat([...parts, ...central, end]));
}

function opendeckPlugins() {
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'opendeck', 'plugins');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'opendeck', 'plugins');
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'opendeck', 'plugins');
}

const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'steam-buttons-'));
try {
  const staged = path.join(stage, pluginDir);
  fs.cpSync(path.join(root, pluginDir), staged, { recursive: true, filter: (src) => path.basename(src) !== 'node_modules' });
  console.log('Installing runtime dependencies...');
  execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['ci', '--omit=dev', '--no-audit', '--no-fund'], { cwd: staged, stdio: 'inherit', shell: process.platform === 'win32' });

  const files = walk(staged, pluginDir);
  const dist = path.join(root, 'dist');
  fs.mkdirSync(dist, { recursive: true });
  const zip = path.join(dist, pluginDir + '.zip');
  writeZip(files, zip);
  const version = JSON.parse(fs.readFileSync(path.join(staged, 'manifest.json'), 'utf8')).Version;
  console.log('\nBuilt ' + path.relative(root, zip) + '  (version ' + version + ', ' + files.length + ' files, ' + Math.round(fs.statSync(zip).size / 1024) + ' KB)');

  if (install) {
    const dest = path.join(opendeckPlugins(), pluginDir);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.rmSync(dest, { recursive: true, force: true });
    fs.cpSync(staged, dest, { recursive: true });
    console.log('Installed to ' + dest + '\nRestart OpenDeck to load it.');
  } else {
    console.log('Install it from OpenDeck\'s Plugins tab, or run again with --install.');
  }
} finally {
  fs.rmSync(stage, { recursive: true, force: true });
}
