/* MPEG-DASH channels with a license server from "#KODIPROP" lines (discussion 79), the whole way in a
   real browser: the playlist's lines reach the channel, a .mpd channel starts on the DASH player and not
   the MPEG-TS one, the license request goes through the helper to the server the playlist names with the
   playlist's headers, and the picture plays.  A channel that can't play says why instead of retrying.
   The stream is tests/lib/dash (a test pattern protected with a made-up ClearKey key, the protection
   every browser has built in): Widevine itself needs a TV.
     node tests/mock/mock_provider.js &      (on :8077)
     npm run serve &                         (app on :8078, dev helper on :47811)
     node tests/soak/dash-license.js */
'use strict';
const { chromium } = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path');
const R = require('../../scripts/demo/record.js');
const APP = process.env.APP || 'http://127.0.0.1:8078/index.html';
const MOCK = process.env.MOCK || 'http://127.0.0.1:8077';
const HERE = 'http://127.0.0.1:8096', DASH = path.join(__dirname, '../lib/dash');
const KID = '00112233445566778899aabbccddeeff', KEY = '0f1e2d3c4b5a69788796a5b4c3d2e1f0';
let fails = 0;
const ok = (n, c, x) => { console.log((c ? 'PASS ' : 'FAIL ') + n + (x !== undefined && !c ? '  ' + String(x).slice(0, 900) : '')); if (!c) fails++; };
const b64u = (hex) => Buffer.from(hex, 'hex').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const PROPS = (type, key) => '#KODIPROP:inputstream=inputstream.adaptive\n#KODIPROP:inputstream.adaptive.manifest_type=mpd\n#KODIPROP:inputstream.adaptive.license_type=' + type + '\n' +
  (key ? '#KODIPROP:inputstream.adaptive.license_key=' + key + '\n' : '') + '#KODIPROP:mimetype=application/dash+xml\n';
const L = (name, props, url) => '#EXTINF:-1 group-title="DASH",' + name + '\n' + props + url + '\n';
const LIST = '#EXTM3U\n' +
  L('Protected', PROPS('clearkey', HERE + '/license?id=2|User-Agent=LicenseAgent&X-Token=abc%20def|R{SSM}|R'), HERE + '/dash/stream.mpd|User-Agent=StreamAgent') +
  L('Refused', PROPS('clearkey', HERE + '/refuse?id=3||R{SSM}|R'), HERE + '/dash/stream.mpd') +
  L('Unknown', PROPS('com.example.unknown', HERE + '/license'), HERE + '/dash/stream.mpd') +
  L('Keys in the list', PROPS('clearkey', KID + ':' + KEY), HERE + '/dash/stream.mpd') +
  '#EXTINF:-1 group-title="TV",Plain\n' + MOCK + '/live/u/p/1.ts\n';

const seen = { license: [], manifest: [], refused: 0 };
const srv = http.createServer((req, res) => {
  const p = req.url.split('?')[0];
  if (p === '/list.m3u') { res.writeHead(200, { 'Content-Type': 'audio/x-mpegurl' }); return res.end(LIST); }
  if (p === '/refuse') { seen.refused++; req.resume(); res.writeHead(403); return res.end('no'); }
  if (p === '/license') {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      seen.license.push({ method: req.method, ua: req.headers['user-agent'], token: req.headers['x-token'], url: req.url, body });
      if (req.headers['x-token'] !== 'abc def') { res.writeHead(403); return res.end('no token'); }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ keys: [{ kty: 'oct', kid: b64u(KID), k: b64u(KEY) }], type: 'temporary' }));
    });
    return;
  }
  const m = /^\/dash\/([a-z0-9.-]+)$/i.exec(p);
  if (m && fs.existsSync(path.join(DASH, m[1]))) {
    if (/\.mpd$/.test(m[1])) seen.manifest.push(req.headers['user-agent']);
    res.writeHead(200, { 'Content-Type': /\.mpd$/.test(m[1]) ? 'application/dash+xml' : 'video/mp4' });
    return res.end(fs.readFileSync(path.join(DASH, m[1])));
  }
  res.writeHead(404); res.end();
}).listen(8096, '127.0.0.1');

(async () => {
  const b = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const page = await (await b.newContext({ viewport: { width: 1920, height: 1080 } })).newPage();
  const errs = []; page.on('pageerror', (e) => errs.push(e.message));
  await page.addInitScript(R.init({ time: Date.now() })[0]);
  await page.goto(APP);
  const ev = (f, a) => page.evaluate(f, a);
  await page.waitForFunction(() => window.Library && Library.count() > 0, null, { timeout: 60000 });
  await page.waitForTimeout(1500);
  // A new playlist every run: the helper keeps a playlist's channels, and a kept list would hide a parser change.
  const PL = 'dash' + Date.now().toString(36);
  await ev((id) => { const d = Store.byId('p1'); d.off = true; Store.upsertPlaylist(d); Store.upsertPlaylist({ id: id, name: 'DASH list', type: 'm3u', m3u: 'http://127.0.0.1:8096/list.m3u?' + id }); App.switchPlaylist(id); }, PL);
  await page.waitForFunction((id) => Store.settings.active === id && window.Library && Library.count() === 5 && document.getElementById('viewSetup').classList.contains('hidden'), PL, { timeout: 30000 }).catch(() => {});
  await ev(() => { window.__states = []; Player.on('state', (s, m) => window.__states.push([s, m || ''])); Store.settings.engine = 'auto'; });
  const chans = await ev(() => Library.data.channels.map((c) => ({ n: c.n, url: c.url, ua: c.ua, mt: c.mt, lt: c.lt, lk: c.lk })));
  ok('the playlist\'s license lines stay with the channel', chans.length === 5 && chans[0].mt === 'mpd' && chans[0].lt === 'clearkey' && /\/license\?id=2\|User-Agent=LicenseAgent/.test(chans[0].lk) && chans[0].url === HERE + '/dash/stream.mpd' && chans[0].ua === 'StreamAgent', JSON.stringify(chans[0]));
  ok('a channel without them has none', chans[4].mt === undefined && chans[4].lt === undefined, JSON.stringify(chans[4]));

  const start = (i) => ev((i) => { window.__states.length = 0; Views.startChannel(Library.data.channels[i], false, Views.goFull); }, i);
  const playing = () => page.waitForFunction(() => Player.stats && Player.stats.state === 'playing' && document.getElementById('video').currentTime > 1, null, { timeout: 30000 }).then(() => true, () => false);
  const failed = () => page.waitForFunction(() => window.__states.some((s) => s[0] === 'error'), null, { timeout: 30000 }).then(() => ev(() => window.__states.filter((s) => s[0] === 'error')[0][1]), () => '');
  const logs = () => ev(() => Log.lines(false).join('\n'));
  const tail = async () => (await logs()).slice(-900);

  await start(0);
  ok('a protected DASH channel plays', await playing(), await tail());
  ok('on the DASH player, without trying the MPEG-TS one first', await ev(() => Player._test.kind) === 'dash' && !/with ts engine/.test(await logs()));
  const lic = seen.license[0] || {};
  ok('the license request went to the playlist\'s server, as a POST', lic.method === 'POST' && lic.url === '/license?id=2', JSON.stringify(lic));
  ok('with the headers the playlist asks for', lic.ua === 'LicenseAgent' && lic.token === 'abc def', JSON.stringify(lic));
  ok('and the player\'s request as its body, untouched', /"kids"/.test(lic.body || '') && (lic.body || '').indexOf(b64u(KID)) > 0, lic.body);
  ok('the stream is asked for with the channel\'s own User-Agent', seen.manifest[0] === 'StreamAgent', seen.manifest.join());
  ok('the log never shows the license address', !/license\?id=2/.test(await logs()));

  await start(4);
  ok('a plain channel after it plays (the DASH player lets go of the screen)', await playing() && await ev(() => Player._test.kind) !== 'dash', await tail());

  await start(1);
  const why1 = await failed();
  ok('a license server that refuses: the screen says so, with the error', /license server for this channel did not give TiviBro a key \(error 403\)/.test(why1) && seen.refused > 0, why1 + ' | ' + await logs());
  ok('and it is not retried as a busy provider', !/Provider busy|reconnecting/i.test((await ev(() => window.__states.map((s) => s[1]).join('|')))));

  const before = seen.manifest.length;
  await start(2);
  const why2 = await failed();
  ok('a protection TiviBro doesn\'t know: said at once, nothing loaded', /protected in a way TiviBro can't play \(com\.example\.unknown\)/.test(why2) && seen.manifest.length === before, why2);

  await start(3);
  ok('keys written in the playlist: plays without asking a server', await playing() && seen.license.length === 1, await tail());

  ok('no page errors', !errs.length, errs.join(' | '));
  await b.close(); srv.close();
  console.log(fails ? fails + ' failures' : 'all DASH license checks passed');
  process.exit(fails ? 1 : 0);
})();
