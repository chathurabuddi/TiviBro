// MPEG-DASH channels with a license server from "#KODIPROP" lines (discussion 79): the playlist's
// lines stay with the channel (plshape.js), Kodi's license template is read and followed (drm.js),
// and the helper posts the license request with the playlist's headers (service/license.js).
// Runs the real files against its own tiny license server, no mock provider needed.  Playback
// itself is in tests/soak/dash-license.js.
const http = require('http'), fs = require('fs'), path = require('path'), vm = require('vm');
const proxy = require(path.join(__dirname, '../../service/proxy.js'));
const PlShape = require(path.join(__dirname, '../../app/js/plshape.js'));
global.btoa = global.btoa || (s => Buffer.from(s, 'binary').toString('base64'));
global.atob = global.atob || (s => Buffer.from(s, 'base64').toString('binary'));
const Drm = require(path.join(__dirname, '../../app/js/drm.js'));
let fail = 0;
const ok = (n, c, x) => { console.log((c ? 'PASS ' : 'FAIL ') + n + (x !== undefined ? '  ' + x : '')); if (!c) fail++; };
const bytes = s => Uint8Array.from(Buffer.from(s, 'binary'));
const str = b => Buffer.from(b).toString('binary');
const post = (url, headers, body) => new Promise((res, rej) => {
  const r = http.request(url, { method: 'POST', headers }, (a) => { const p = []; a.on('data', d => p.push(d)); a.on('end', () => res({ status: a.statusCode, type: a.headers['content-type'], body: Buffer.concat(p) })); });
  r.on('error', rej); r.end(body);
});

async function netFor(port) {
  const ctx = { console, fetch, setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {}, Promise,
    localStorage: { getItem: k => (k === 'tivibro.devRelay' ? String(port) : null) },
    Log: { info() {}, warn() {}, error() {}, debug() {} },
    Store: { settings: { network: 'auto' }, playlist: { id: 'p1', type: 'm3u', m3u: 'http://tv.example/list.m3u' } },
    btoa, unescape, encodeURIComponent };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../../app/js/net.js'), 'utf8') + '\nthis.Net = Net;', ctx);
  await ctx.Net.start();
  return ctx.Net;
}

(async () => {
  /* ---------- the playlist ---------- */
  const KEY = 'https://provider.example/license?id=2|User-Agent=Agent%2F1.0&X-Token=abc|R{SSM}|R';
  const list = PlShape.parseM3U([
    '#EXTM3U',
    '#EXTINF:-1 tvg-id="2" group-title="Local",One',
    '#KODIPROP:inputstream=inputstream.adaptive',
    '#KODIPROP:inputstream.adaptive.manifest_type=mpd',
    '#KODIPROP:inputstream.adaptive.license_type=com.widevine.alpha',
    '#KODIPROP:inputstream.adaptive.license_key=' + KEY,
    '#KODIPROP:mimetype=application/dash+xml',
    'https://provider.example/api/Ch002.mpd|User-Agent=viu',
    '#EXTINF:-1 group-title="Local",Two', 'http://tv.example/two.ts',
    '#KODIPROP:inputstream.adaptive.license_type=clearkey',
    '#KODIPROP:inputstream.adaptive.license_key=00112233445566778899aabbccddeeff:0f1e2d3c4b5a69788796a5b4c3d2e1f0',
    '#EXTINF:-1 group-title="Local",Three', 'http://tv.example/three.mpd',
    '#EXTINF:-1 group-title="Local",Four',
    '#KODIPROP:inputstream.adaptive.drm_legacy=com.widevine.alpha|https://provider.example/lic|X-Token=abc',
    'http://tv.example/four',
    '#EXTINF:-1 group-title="Local",Five', '#KODIPROP:mimetype=application/dash+xml', 'http://tv.example/five',
    '#EXTINF:-1 group-title="Local",Six', 'http://tv.example/six.ts'
  ].join('\r\n')).channels;
  ok('the license lines stay with the channel', list[0].mt === 'mpd' && list[0].lt === 'com.widevine.alpha' && list[0].lk === KEY, JSON.stringify(list[0]));
  ok('beside its clean address and its own User-Agent', list[0].url === 'https://provider.example/api/Ch002.mpd' && list[0].ua === 'viu', list[0].url + ' ' + list[0].ua);
  ok('a channel without such lines has no such fields', !('mt' in list[1]) && !('lt' in list[1]) && !('lk' in list[1]), JSON.stringify(list[1]));
  ok('lines written before the channel\'s name belong to it too', list[2].lt === 'clearkey' && /^0011/.test(list[2].lk) && !('mt' in list[2]), JSON.stringify(list[2]));
  ok('the newer drm_legacy line gives the same two', list[3].lt === 'com.widevine.alpha' && list[3].lk === 'https://provider.example/lic|X-Token=abc', JSON.stringify(list[3]));
  ok('a DASH address without .mpd is known from its mimetype', list[4].mt === 'mpd' && !('lt' in list[4]), JSON.stringify(list[4]));
  ok('one channel\'s lines never reach the next', !('mt' in list[5]) && !('lt' in list[5]), JSON.stringify(list[5]));

  /* ---------- the license template ---------- */
  let d = Drm.parse(list[0].lt, list[0].lk);
  ok('Kodi\'s template: address, headers, what to send, how the answer reads', d.system === 'com.widevine.alpha' && d.url === 'https://provider.example/license?id=2' && d.headers['User-Agent'] === 'Agent/1.0' && d.headers['X-Token'] === 'abc' && d.send === 'R{SSM}' && d.read === 'R', JSON.stringify(d));
  const ask = bytes('\x08\x04\x00\xffrequest');
  ok('R{SSM}: the request goes as it is', Drm.body(d, ask) === ask);
  ok('R: the answer is the license as it is', Drm.license(d, ask) === ask);
  d = Drm.parse('widevine', 'https://provider.example/lic');
  ok('only an address: the request and the answer as they are', !d.error && d.send === '' && Drm.body(d, ask) === ask && Drm.license(d, ask) === ask, JSON.stringify(d));
  d = Drm.parse('com.widevine.alpha', 'https://provider.example/lic|Content-Type=application%2Fjson|{"token":"t","msg":"b{SSM}"}|Jlicense');
  ok('b{SSM} inside a wrapper: base64, the wrapper kept', Drm.body(d, ask) === '{"token":"t","msg":"' + Buffer.from(ask).toString('base64') + '"}', Drm.body(d, ask));
  ok('J: the license is the base64 text under that name in the JSON answer', str(Drm.license(d, bytes(JSON.stringify({ status: 'ok', data: { license: Buffer.from('LICENSE\x00\x01', 'binary').toString('base64') } })))) === 'LICENSE\x00\x01');
  d = Drm.parse('com.widevine.alpha', 'https://provider.example/lic||B{SSM}|B');
  ok('B{SSM}: base64 with % codes', Drm.body(d, bytes('\xfb\xff\xfe')) === encodeURIComponent('+//+'), Drm.body(d, bytes('\xfb\xff\xfe')));
  ok('B: a base64 answer', str(Drm.license(d, bytes(Buffer.from('KEY\x02', 'binary').toString('base64')))) === 'KEY\x02');
  d = Drm.parse('clearkey', '00112233445566778899AABBCCDDEEFF:0f1e2d3c4b5a69788796a5b4c3d2e1f0');
  ok('ClearKey keys written in the playlist: no server', !d.error && !d.url && d.keys['00112233445566778899aabbccddeeff'] === '0f1e2d3c4b5a69788796a5b4c3d2e1f0', JSON.stringify(d));
  ok('PlayReady is known by both its names', Drm.parse('com.microsoft.playready', 'https://provider.example/pr').system === 'com.microsoft.playready' && Drm.parse('playready', 'https://provider.example/pr').name === 'PlayReady');
  ok('a protection TiviBro doesn\'t know is said by name', /can't play \(com\.example\.other\)/.test(Drm.parse('com.example.other', 'https://provider.example/lic').error));
  ok('no license server in the playlist is said too', /gives no license server/.test(Drm.parse('com.widevine.alpha', '').error));
  ok('an answer form TiviBro can\'t read is refused before anything is asked', /can't read/.test(Drm.parse('com.widevine.alpha', 'https://provider.example/lic||R{SSM}|HB').error));

  /* ---------- the helper ---------- */
  const got = [];
  const up = http.createServer((req, res) => {
    const p = []; req.on('data', x => p.push(x));
    req.on('end', () => {
      got.push({ method: req.method, url: req.url, ua: req.headers['user-agent'], token: req.headers['x-token'], type: req.headers['content-type'], body: Buffer.concat(p) });
      if (req.url === '/moved') { res.writeHead(307, { Location: '/license?id=9' }); return res.end(); }
      if (req.url === '/denied') { res.writeHead(403, { 'Content-Type': 'text/plain' }); return res.end('no'); }
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' }); res.end(Buffer.from('\x00LICENSE\xff', 'binary'));
    });
  });
  await new Promise(f => up.listen(0, '127.0.0.1', f));
  const U = 'http://127.0.0.1:' + up.address().port;
  const r = proxy.create({ ctl: 'secret' }); await new Promise(f => r.server.listen(0, '127.0.0.1', f));
  const Net = await netFor(r.server.address().port);
  const CTL = { 'X-TiviBro-Ctl': 'secret' };

  d = Drm.parse('com.widevine.alpha', U + '/license?id=2&token=tok123|User-Agent=Agent%2F1.0&X-Token=abc&Content-Type=application%2Foctet-stream|R{SSM}|R');
  const link = Net.license(d.url, d.headers);
  ok('the app posts to the helper, not to the license server', link.indexOf('http://127.0.0.1:' + r.server.address().port + '/license/post?u=') === 0 && link.indexOf('tok123') < 0, link);
  let a = await post(link, CTL, Buffer.from(ask));
  let g = got[got.length - 1] || {};
  ok('the license server gets a POST at the playlist\'s address', a.status === 200 && g.method === 'POST' && g.url === '/license?id=2&token=tok123', g.method + ' ' + g.url);
  ok('with the playlist\'s headers, User-Agent included', g.ua === 'Agent/1.0' && g.token === 'abc' && g.type === 'application/octet-stream', JSON.stringify({ ua: g.ua, token: g.token, type: g.type }));
  ok('and the request byte for byte', g.body && g.body.equals(Buffer.from(ask)));
  ok('the answer comes back byte for byte', a.body.equals(Buffer.from('\x00LICENSE\xff', 'binary')) && a.type === 'application/octet-stream');
  a = await post(Net.license(U + '/denied', {}), CTL, 'x');
  ok('a refusal comes back with its status', a.status === 403 && String(a.body) === 'no', a.status);
  a = await post(Net.license(U + '/moved', {}), CTL, 'again');
  g = got[got.length - 1];
  ok('a 307 redirect is followed with the same request', a.status === 200 && g.url === '/license?id=9' && g.method === 'POST' && String(g.body) === 'again', a.status + ' ' + g.url);
  const n = got.length;
  a = await post(link, {}, 'x');
  ok('only TiviBro may use it (its secret)', a.status === 403 && got.length === n, a.status);
  a = await post(Net.license('file:///etc/passwd', {}), CTL, 'x');
  ok('only http and https addresses', a.status === 400, a.status);
  a = await post(Net.license('http://127.0.0.1:9/none', {}), CTL, 'x');
  ok('a server that can\'t be reached: 502', a.status === 502, a.status);
  const log = JSON.stringify(proxy.LOG || (await new Promise(f => http.get('http://127.0.0.1:' + r.server.address().port + '/log', (x) => { let b = ''; x.on('data', c => b += c); x.on('end', () => f(JSON.parse(b).log)); }))));
  ok('the helper\'s log keeps the server\'s name only', /"license":1/.test(log) && log.indexOf('tok123') < 0 && log.indexOf('id=2') < 0, log.slice(0, 200));

  r.server.close(); up.close();
  console.log(fail ? fail + ' failures' : 'all DASH license tests passed');
  process.exit(fail ? 1 : 0);
})();
