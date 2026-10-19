'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const path = require('node:path');

const lib = path.join(__dirname, '..', 'com.github.timsandtoms.steam-buttons.sdPlugin', 'plugin', 'lib', 'steamgriddb.js');
const { SteamGridDb, allowedImageUrl, validKey, cleanItem, sniffMime } = require(lib);

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 1)]);
const KEY = 'abcd1234abcd1234abcd1234abcd1234';

/** An https.request stand-in. `routes(options)` returns {status, body, headers}. */
function fakeRequest(routes, log) {
  return (options, cb) => {
    const req = new EventEmitter();
    req.destroy = () => {};
    req.end = () => {
      if (log) log.push(options);
      const r = routes(options);
      setImmediate(() => {
        if (r instanceof Error) { req.emit('error', r); return; }
        const res = new EventEmitter();
        res.statusCode = r.status;
        res.headers = r.headers || {};
        cb(res);
        res.emit('data', Buffer.isBuffer(r.body) ? r.body : Buffer.from(JSON.stringify(r.body)));
        res.emit('end');
      });
    };
    return req;
  };
}

test('validKey accepts plain alphanumeric keys only', () => {
  assert.equal(validKey(KEY), true);
  assert.equal(validKey('  ' + KEY + ' '), true);
  assert.equal(validKey('short'), false);
  assert.equal(validKey('has spaces in it 1234'), false);
  assert.equal(validKey(''), false);
  assert.equal(validKey(null), false);
});

test('allowedImageUrl only admits SteamGridDB hosts over https', () => {
  assert.ok(allowedImageUrl('https://cdn2.steamgriddb.com/grid/abc.png'));
  assert.ok(allowedImageUrl('https://steamgriddb.com/x.png'));
  assert.ok(allowedImageUrl('https://s3.amazonaws.com/steamgriddb/grid/abc.png'));
  assert.equal(allowedImageUrl('http://cdn2.steamgriddb.com/grid/abc.png'), null);
  assert.equal(allowedImageUrl('https://s3.amazonaws.com/other-bucket/abc.png'), null);
  assert.equal(allowedImageUrl('https://evilsteamgriddb.com/abc.png'), null);
  assert.equal(allowedImageUrl('https://cdn2.steamgriddb.com.evil.test/abc.png'), null);
  assert.equal(allowedImageUrl('https://user:pw@cdn2.steamgriddb.com/abc.png'), null);
  assert.equal(allowedImageUrl('https://127.0.0.1/abc.png'), null);
  assert.equal(allowedImageUrl('file:///etc/passwd'), null);
  assert.equal(allowedImageUrl('nonsense'), null);
});

test('cleanItem drops records with foreign image hosts and trims fields', () => {
  assert.equal(cleanItem({ id: 1, url: 'https://evil.test/a.png', thumb: 'https://evil.test/t.png' }), null);
  const it = cleanItem({
    id: 7, url: 'https://cdn2.steamgriddb.com/grid/a.png', thumb: 'https://evil.test/t.png', width: 600, height: 900,
    style: 'alternate', score: 3, upvotes: 4, downvotes: 1, author: { name: 'someone', steam64: '1' }, extra: 'x'
  });
  assert.equal(it.id, 7);
  assert.equal(it.thumb, it.url); // a foreign thumb falls back to the image itself
  assert.equal(it.author, 'someone');
  assert.equal(it.extra, undefined);
});

test('search maps results and sends the bearer key', async () => {
  const log = [];
  const sg = new SteamGridDb({
    request: fakeRequest(() => ({ status: 200, body: { success: true, data: [
      { id: 2254, name: 'Half-Life 2', verified: true }, { id: 0, name: 'bad' }, { id: 5, name: '' }
    ] } }), log)
  });
  const r = await sg.search(KEY, 'half life');
  assert.deepEqual(r, [{ id: 2254, name: 'Half-Life 2', verified: true }]);
  assert.equal(log[0].host, 'www.steamgriddb.com');
  assert.equal(log[0].path, '/api/v2/search/autocomplete/half%20life');
  assert.equal(log[0].headers.Authorization, 'Bearer ' + KEY);
});

test('requests without a usable key fail before touching the network', async () => {
  const log = [];
  const sg = new SteamGridDb({ request: fakeRequest(() => ({ status: 200, body: {} }), log) });
  await assert.rejects(sg.search('', 'x'), { code: 'no_key' });
  await assert.rejects(sg.search('bad key!', 'x'), { code: 'no_key' });
  assert.equal(log.length, 0);
});

test('HTTP errors become typed errors', async () => {
  const mk = (status) => new SteamGridDb({ request: fakeRequest(() => ({ status, body: { success: false, errors: ['nope'] } })) });
  await assert.rejects(mk(401).search(KEY, 'x'), { code: 'bad_key' });
  await assert.rejects(mk(403).search(KEY, 'x'), { code: 'bad_key' });
  await assert.rejects(mk(429).search(KEY, 'x'), { code: 'rate_limited' });
  await assert.rejects(mk(500).search(KEY, 'x'), { code: 'api' });
  const net = new SteamGridDb({ request: fakeRequest(() => new Error('ECONNRESET')) });
  await assert.rejects(net.search(KEY, 'x'), { code: 'network' });
});

test('gameForSteamApp returns null for unknown apps', async () => {
  const sg = new SteamGridDb({ request: fakeRequest(() => ({ status: 404, body: { success: false } })) });
  assert.equal(await sg.gameForSteamApp(KEY, '730'), null);
  const ok = new SteamGridDb({ request: fakeRequest(() => ({ status: 200, body: { success: true, data: { id: 5, name: 'CS' } } })) });
  assert.deepEqual(await ok.gameForSteamApp(KEY, '730'), { id: 5, name: 'CS' });
  assert.equal(await ok.gameForSteamApp(KEY, 'abc'), null);
});

test('assets builds the query and reports paging', async () => {
  const log = [];
  const items = Array.from({ length: 3 }, (_, i) => ({
    id: i + 1, url: 'https://cdn2.steamgriddb.com/grid/' + i + '.png', thumb: 'https://cdn2.steamgriddb.com/thumb/' + i + '.jpg',
    width: 600, height: 900, style: 'alternate', score: 0, author: { name: 'a' }
  }));
  items.push({ id: 99, url: 'https://evil.test/x.png' });
  const sg = new SteamGridDb({
    request: fakeRequest(() => ({ status: 200, body: { success: true, page: 1, total: 120, limit: 50, data: items } }), log)
  });
  const r = await sg.assets(KEY, { gameId: 2254, type: 'grids', styles: ['blurred'], dimensions: ['600x900', '342x482'], page: 1 });
  assert.equal(r.items.length, 3); // the foreign-host record was dropped
  assert.equal(r.hasMore, true);   // (1+1)*50 < 120
  const q = log[0].path;
  assert.match(q, /^\/api\/v2\/grids\/game\/2254\?/);
  assert.match(q, /styles=blurred/);
  assert.match(q, /dimensions=600x900,342x482/);
  assert.match(q, /types=static/);
  assert.match(q, /nsfw=false/);
  assert.match(q, /humor=false/);
  assert.match(q, /page=1/);

  const last = await new SteamGridDb({
    request: fakeRequest(() => ({ status: 200, body: { success: true, page: 2, total: 120, limit: 50, data: items } }))
  }).assets(KEY, { gameId: 1, type: 'icons', page: 2 });
  assert.equal(last.hasMore, false);
});

test('assets honours the adult/humour opt-ins and rejects junk input', async () => {
  const log = [];
  const sg = new SteamGridDb({ request: fakeRequest(() => ({ status: 200, body: { success: true, data: [] } }), log) });
  await sg.assets(KEY, { gameId: 1, type: 'heroes', nsfw: true, humor: true, styles: ['a&b=c', 'material'] });
  assert.match(log[0].path, /nsfw=any/);
  assert.match(log[0].path, /humor=any/);
  assert.match(log[0].path, /styles=material(&|$)/);
  assert.doesNotMatch(log[0].path, /a&b/);
  await assert.rejects(sg.assets(KEY, { gameId: 1, type: 'nonsense' }), { code: 'api' });
  await assert.rejects(sg.assets(KEY, { gameId: 0, type: 'grids' }), { code: 'api' });
});

test('fetchImage fetches, validates, caches, and refuses foreign hosts', async () => {
  const log = [];
  const sg = new SteamGridDb({ request: fakeRequest(() => ({ status: 200, body: PNG }), log) });
  const url = 'https://cdn2.steamgriddb.com/grid/a.png';
  const a = await sg.fetchImage(url);
  assert.equal(a.mime, 'image/png');
  const b = await sg.fetchImage(url);
  assert.equal(b, a);
  assert.equal(log.length, 1); // second call came from the cache
  assert.equal(await sg.fetchImage('https://example.com/a.png'), null);
  assert.equal(log.length, 1);
});

test('fetchImage rejects non-images and redirects off the allowlist', async () => {
  const html = new SteamGridDb({ request: fakeRequest(() => ({ status: 200, body: Buffer.from('<html>not an image at all</html>') })) });
  assert.equal(await html.fetchImage('https://cdn2.steamgriddb.com/grid/a.png'), null);
  const off = new SteamGridDb({ request: fakeRequest(() => ({ status: 302, headers: { location: 'https://evil.test/a.png' }, body: '' })) });
  assert.equal(await off.fetchImage('https://cdn2.steamgriddb.com/grid/a.png'), null);
  let hops = 0;
  const on = new SteamGridDb({
    request: fakeRequest((o) => (hops++ === 0
      ? { status: 302, headers: { location: 'https://cdn.steamgriddb.com/grid/b.png' }, body: '' }
      : { status: 200, body: PNG }))
  });
  assert.equal((await on.fetchImage('https://cdn2.steamgriddb.com/grid/a.png')).mime, 'image/png');
});

test('concurrent fetches of one image share a single request', async () => {
  const log = [];
  const sg = new SteamGridDb({ request: fakeRequest(() => ({ status: 200, body: PNG }), log) });
  const url = 'https://cdn2.steamgriddb.com/grid/a.png';
  await Promise.all([sg.fetchImage(url), sg.fetchImage(url), sg.fetchImage(url)]);
  assert.equal(log.length, 1);
});

test('sniffMime recognises the formats the inspector can decode', () => {
  assert.equal(sniffMime(PNG), 'image/png');
  assert.equal(sniffMime(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(20)])), 'image/jpeg');
  assert.equal(sniffMime(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(8)])), 'image/webp');
  assert.equal(sniffMime(Buffer.from('plain text, not an image')), null);
});
