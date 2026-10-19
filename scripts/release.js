#!/usr/bin/env node
'use strict';
/*
 * Bump the plugin version everywhere, commit, and tag.
 *
 *   node scripts/release.js patch      1.0.0 -> 1.0.1
 *   node scripts/release.js minor      1.0.1 -> 1.1.0
 *   node scripts/release.js major      1.1.0 -> 2.0.0
 *   node scripts/release.js 1.2.3      an exact version (must not be lower than the current one)
 *   node scripts/release.js current    tag the version already in the files (first release)
 *
 * Beta (pre-release) builds: add "-beta" to bump the version and tag vX.Y.Z-beta.1, or use plain
 * "beta" to tag the next beta of the version already in the files (vX.Y.Z-beta.2, ...).
 *   node scripts/release.js minor-beta   1.0.0 -> 1.1.0 files, tag v1.1.0-beta.1
 *   node scripts/release.js beta         tag v1.1.0-beta.2 (no file changes)
 * GitHub publishes a tag containing "-beta" as a *pre-release*: it is downloadable from the Releases
 * page but is never GitHub's "latest release", which is what the OpenDeck plugin list follows.
 * When it's ready, run "current" to tag the final vX.Y.Z.
 *
 * Updates manifest.json, package.json and package-lock.json, commits as "Release vX.Y.Z",
 * and creates the annotated tag vX.Y.Z. It does not push; run `git push --follow-tags` after.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const plugin = fs.readdirSync(root).find((d) => d.endsWith('.sdPlugin') && fs.statSync(path.join(root, d)).isDirectory());
if (!plugin) fail('Could not find the *.sdPlugin folder next to this script\'s parent directory.');
const manifestPath = path.join(root, plugin, 'manifest.json');
const pkgPath = path.join(root, plugin, 'package.json');
const lockPath = path.join(root, plugin, 'package-lock.json');

function fail(msg) { console.error('\nError: ' + msg + '\n'); process.exit(1); }
function git(...args) { return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim(); }
function parse(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:\.0+)?$/.exec(String(v).trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}
function cmp(a, b) { for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i]; return 0; }

let arg = process.argv[2];
let beta = false;
if (arg === 'beta') { arg = 'current'; beta = true; }
else if (/-beta$/.test(arg || '')) { arg = arg.replace(/-beta$/, ''); beta = true; }
if (!arg) fail('Say what to release: patch, minor, major, current, or a version like 1.2.3.');

// Make sure git is usable and the working tree is clean, so the release commit contains only the version bump.
try { git('rev-parse', '--is-inside-work-tree'); } catch (e) { fail('This folder is not a git repository.'); }
if (git('status', '--porcelain')) fail('You have uncommitted changes. Commit or stash them first, then run this again.');

const manifestText = fs.readFileSync(manifestPath, 'utf8');
const versionLine = /("Version"\s*:\s*")([^"]*)(")/;
const found = versionLine.exec(manifestText);
if (!found) fail('No "Version" found in ' + manifestPath);
const current = parse(found[2]);
if (!current) fail('Cannot read the current version "' + found[2] + '" from manifest.json.');

let next;
if (arg === 'patch') next = [current[0], current[1], current[2] + 1];
else if (arg === 'minor') next = [current[0], current[1] + 1, 0];
else if (arg === 'major') next = [current[0] + 1, 0, 0];
else if (arg === 'current') next = current;
else {
  next = parse(arg);
  if (!next) fail('"' + arg + '" is not patch, minor, major, current, or a version like 1.2.3.');
  if (cmp(next, current) < 0) fail('Version ' + next.join('.') + ' is lower than the current ' + current.join('.') + '.');
}
const version = next.join('.');
let tag = 'v' + version;
if (beta) {
  const used = git('tag', '--list', tag + '-beta.*').split('\n').map((t) => Number((/-beta\.(\d+)$/.exec(t) || [])[1])).filter(Boolean);
  tag += '-beta.' + (used.length ? Math.max(...used) + 1 : 1);
}
if (git('tag', '--list', tag)) fail('The tag ' + tag + ' already exists. Tags are never reused; pick a higher version.');

// manifest.json: edit just the one line so the file's formatting is untouched.
fs.writeFileSync(manifestPath, manifestText.replace(versionLine, '$1' + version + '$3'));

// package.json and package-lock.json: standard 2-space JSON.
function updateJson(file, fn) {
  if (!fs.existsSync(file)) return;
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  fn(data);
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
}
updateJson(pkgPath, (d) => { d.version = version; });
updateJson(lockPath, (d) => {
  d.version = version;
  if (d.packages && d.packages['']) d.packages[''].version = version;
});

git('add', manifestPath, pkgPath);
if (fs.existsSync(lockPath)) git('add', lockPath);
if (git('status', '--porcelain')) git('commit', '-m', 'Release ' + tag);
else console.log('Files already at ' + version + '; no version commit needed.');
git('tag', '-a', tag, '-m', 'Release ' + tag);

console.log('\nCreated tag ' + tag + (beta ? ' (a pre-release; it will not become the latest release)' : '') + ' (version ' + version + ').');
console.log('Next: push it to GitHub with   git push --follow-tags   (or run the "Release: push" task in VS Code).\n');
