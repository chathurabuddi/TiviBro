/* Protected channels: getting the key a channel's playlist says where to find.
   An M3U channel can name its protection and its license server in "#KODIPROP" lines (plshape.js keeps
   them as the channel's lt and lk).  The TV's own protected player (EME) makes a request; this sends it
   to the license server the way the playlist asks and hands the answer back.  TiviBro never sees a key
   of a protected channel: both messages only mean something to the license server and to the TV.

   lk is Kodi's template, four parts split by "|":
     address | headers | what to send | how the answer reads
     https://provider.example/license?id=2|User-Agent=Agent&X-Token=abc|R{SSM}|R
   headers   "Name=value&Name=value", values written with % codes
   send      R{SSM} the request as it is (also when empty), b{SSM} as base64, B{SSM} as base64 with
             % codes, D{SSM} as decimal numbers; text around them is kept (a JSON wrapper)
   answer    R or empty: as it is.  B: base64.  J<name>: JSON, the base64 text under that name.
   For "clearkey" (keys that are not themselves protected, used by a few providers) lk can be the keys
   themselves, "id:key,id:key" in hex, and no server is asked.

   Chromium 53 compatible; the pure parts run in Node for the unit test. */
var Drm = (function () {
  'use strict';
  var SYSTEMS = {
    'com.widevine.alpha': 'com.widevine.alpha', 'widevine': 'com.widevine.alpha',
    'com.microsoft.playready': 'com.microsoft.playready', 'playready': 'com.microsoft.playready',
    'org.w3.clearkey': 'org.w3.clearkey', 'clearkey': 'org.w3.clearkey'
  };
  var NAMES = { 'com.widevine.alpha': 'Widevine', 'com.microsoft.playready': 'PlayReady', 'org.w3.clearkey': 'ClearKey' };
  var HEXKEYS = /^[0-9a-f]{32}:[0-9a-f]{32}(,[0-9a-f]{32}:[0-9a-f]{32})*$/i;

  function decode(s) { try { return decodeURIComponent(s); } catch (e) { return s; } }
  function b64(bytes) { var s = ''; for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]); return btoa(s); }
  function unb64(text) {
    var s = atob(String(text).replace(/-/g, '+').replace(/_/g, '/').replace(/\s+/g, '')), out = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  }
  function text(bytes) { var s = ''; for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]); return s; }
  function find(o, name) {
    if (!o || typeof o !== 'object') return null;
    if (typeof o[name] === 'string') return o[name];
    for (var k in o) { var v = find(o[k], name); if (v != null) return v; }
    return null;
  }

  /** What a channel's lt and lk ask for: { system, name, url, headers, send, read, keys } or { error }. */
  function parse(lt, lk) {
    var system = SYSTEMS[String(lt || '').toLowerCase()];
    if (!system) return { error: 'This channel is protected in a way TiviBro can\'t play (' + (lt || 'not named') + ')' };
    var out = { system: system, name: NAMES[system], url: '', headers: {}, send: '', read: '', keys: null };
    lk = String(lk || '').trim();
    if (system === 'org.w3.clearkey' && HEXKEYS.test(lk)) {
      out.keys = {};
      lk.split(',').forEach(function (p) { var kv = p.toLowerCase().split(':'); out.keys[kv[0]] = kv[1]; });
      return out;
    }
    var part = lk.split('|');
    out.url = part[0].trim();
    if (!/^https?:\/\//i.test(out.url)) return { error: 'This channel is protected and its playlist gives no license server' };
    (part[1] || '').split('&').forEach(function (h) { var eq = h.indexOf('='); if (eq > 0) out.headers[h.slice(0, eq).trim()] = decode(h.slice(eq + 1)).trim(); });
    out.send = part[2] || '';
    out.read = (part[3] || '').trim();
    if (!/^(R|B|J.+)?$/.test(out.read)) return { error: 'This channel\'s license answer is in a form TiviBro can\'t read (' + out.read.slice(0, 12) + ')' };
    if (/R\{SSM\}/.test(out.send) && out.send !== 'R{SSM}') return { error: 'This channel\'s license request is in a form TiviBro can\'t send' };
    return out;
  }

  /** The body to post for the player's request (a Uint8Array): the bytes themselves, or the template's text. */
  function body(info, challenge) {
    if (!info.send || info.send === 'R{SSM}') return challenge;
    return info.send.replace(/([bBD])\{SSM\}/g, function (m, how) {
      return how === 'D' ? Array.prototype.join.call(challenge, ',') : how === 'B' ? encodeURIComponent(b64(challenge)) : b64(challenge);
    });
  }

  /** The license in a server's answer (bytes in, bytes out). */
  function license(info, answer) {
    if (!info.read || info.read === 'R') return answer;
    if (info.read === 'B') return unb64(text(answer));
    var v = find(JSON.parse(text(answer)), info.read.slice(1));
    if (v == null) throw new Error('no "' + info.read.slice(1) + '" in the answer');
    return unb64(v);
  }

  /** Where and how to post the player's request: { url, headers, body }.  Through the helper whenever it
      runs (service/license.js sends the playlist's headers); straight to the server otherwise, without the
      headers a web page may not set. */
  function ask(info, challenge) {
    var via = typeof Net !== 'undefined' && Net.license ? Net.license(info.url, info.headers) : '', headers = {};
    if (via) headers = Net.ctlHeaders({});
    else for (var k in info.headers) if (!/^(user-agent|origin|referer|host|cookie)$/i.test(k)) headers[k] = info.headers[k];
    return { url: via || info.url, headers: headers, body: body(info, challenge) };
  }

  /** True when this browser has a protected player at all (webOS 4 and newer do). */
  function possible() { return typeof navigator !== 'undefined' && typeof navigator.requestMediaKeySystemAccess === 'function' && typeof window.MediaKeys !== 'undefined'; }

  return { parse: parse, body: body, license: license, ask: ask, possible: possible, NAMES: NAMES };
})();
if (typeof module !== 'undefined') module.exports = Drm;
