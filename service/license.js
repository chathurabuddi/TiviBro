/* Asking a license server for a protected channel's key (app/js/drm.js).
   The app can't do it itself: webOS enforces CORS on installed apps and license servers send no CORS
   headers, and a web page may not set headers such as User-Agent, which the playlist can ask for.
   So the app hands the player's request to the helper, which posts it and passes the answer back
   untouched.  The helper never reads or keeps either: the request only means something to the license
   server, and the answer only to the TV's own protected player.

   Route (on the relay, 127.0.0.1 only, with TiviBro's secret):
     POST /license/post?u=<base64url of the address>&h=<base64url of the headers as JSON>
       body: what to send.  Answers with the server's status, Content-Type and body.
   The log keeps the server's name only: the address can carry a token.
   Plain ES5 and callbacks for Node 0.12 (webOS 4). */
'use strict';
var http = require('http'), https = require('https'), URL_ = require('url');

var MAX_ASK = 1024 * 1024, MAX_ANSWER = 4 * 1024 * 1024, TIMEOUT = 15000, HOPS = 3;

function unb64(s) { return Buffer.from(String(s || '').replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'); }
function param(q, name) { var m = new RegExp('(?:^|&)' + name + '=([A-Za-z0-9_-]*)').exec(q || ''); return m ? m[1] : ''; }

function send(res, ALLOW, code, type, body) {
  var h = { 'Content-Type': type, 'Cache-Control': 'no-store' };
  for (var x in ALLOW) h[x] = ALLOW[x];
  res.writeHead(code, h);
  res.end(body);
}
function refuse(res, ALLOW, code, why) { send(res, ALLOW, code, 'application/json', JSON.stringify({ error: why })); }

function post(target, headers, body, hops, done) {
  var u = URL_.parse(target), lib = u.protocol === 'https:' ? https : http, finished = false;
  function end(err, code, type, data) { if (finished) return; finished = true; done(err, code, type, data); }
  var h = { 'Accept': '*/*' };
  for (var k in headers) h[k] = headers[k];
  h['Content-Length'] = body.length;
  var req = lib.request({ protocol: u.protocol, hostname: u.hostname, port: u.port, path: u.path, method: 'POST', headers: h, rejectUnauthorized: false, insecureHTTPParser: true }, function (ur) {
    var code = ur.statusCode || 502;
    // 307 and 308 keep the request as it is; other redirects would turn it into a GET, which no license server answers.
    if ((code === 307 || code === 308) && ur.headers.location && hops > 0) { ur.resume(); return post(URL_.resolve(target, ur.headers.location), headers, body, hops - 1, end); }
    var parts = [], size = 0;
    ur.on('data', function (d) { size += d.length; if (size > MAX_ANSWER) { req.abort(); return end(new Error('the answer is too large')); } parts.push(d); });
    ur.on('end', function () { end(null, code, ur.headers['content-type'] || 'application/octet-stream', Buffer.concat(parts)); });
    ur.on('error', function (e) { end(e); });
  });
  req.setTimeout(TIMEOUT, function () { req.abort(); end(new Error('timeout')); });
  req.on('error', function (e) { end(e); });
  req.end(body);
}

function handle(req, res, ALLOW, log) {
  var q = req.url.split('?'), target = '', headers = {};
  if (req.method !== 'POST' || q[0] !== '/license/post') { req.resume(); return refuse(res, ALLOW, 404, 'no such route'); }
  try { target = unb64(param(q[1], 'u')); var h = param(q[1], 'h'); headers = h ? JSON.parse(unb64(h)) : {}; } catch (e) { target = ''; }
  if (!/^https?:\/\/[^/?#\s]+/i.test(target) || !headers || typeof headers !== 'object') { req.resume(); return refuse(res, ALLOW, 400, 'bad address or headers'); }
  var clean = {};
  for (var k in headers) if (/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(k) && !/^(host|content-length|connection|transfer-encoding)$/i.test(k) && !/[\r\n]/.test(String(headers[k]))) clean[k] = String(headers[k]);
  var parts = [], size = 0, big = false, t0 = Date.now(), rec = { m: 'POST', u: URL_.parse(target).protocol + '//' + URL_.parse(target).host + '/***', license: 1 };
  req.on('data', function (d) { if (big) return; size += d.length; if (size > MAX_ASK) { big = true; return refuse(res, ALLOW, 413, 'too large'); } parts.push(d); });
  req.on('end', function () {
    if (big) return;
    post(target, clean, Buffer.concat(parts), HOPS, function (err, code, type, data) {
      rec.ms = Date.now() - t0;
      if (err) { rec.e = err.code || err.message; rec.lv = 'error'; log(rec); return refuse(res, ALLOW, 502, 'the license server did not answer: ' + rec.e); }
      rec.s = code; rec.b = data.length; if (code >= 400) rec.lv = 'error';
      log(rec);
      send(res, ALLOW, code, type, data);
    });
  });
}

module.exports = { handle: handle };
