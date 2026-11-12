/* Protects the test DASH stream that ffmpeg wrote (make-dash-fixture.sh), the standard way ("cenc":
   AES-128 in counter mode, ISO/IEC 23001-7), in place.  ffmpeg's own encryption leaves out what a player
   needs in each segment, so this does the small part of a packager's job the fixture needs:
     init segment   the sample entry becomes encv/enca with a sinf box (frma, schm, schi > tenc with the key id)
     media segment  every sample is encrypted (video: the slice data only, each NAL's length and first byte
                    stay clear), and each traf gets saiz, saio and senc; trun's data offset and sidx follow
     manifest       ContentProtection for the key id and the W3C "common" system, which ClearKey reads
   node tests/lib/dash-encrypt.js <folder> <key id hex> <key hex> */
'use strict';
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const [dir, KID, KEY] = process.argv.slice(2);
const CONTAINERS = { moov: 1, trak: 1, mdia: 1, minf: 1, stbl: 1, moof: 1, traf: 1 };

function parse(buf, start, end) {
  const out = [];
  for (let o = start; o + 8 <= end;) {
    const size = buf.readUInt32BE(o), type = buf.toString('latin1', o + 4, o + 8), node = { type, data: buf.slice(o + 8, o + size) };
    if (size < 8) throw new Error('bad box ' + type);
    if (CONTAINERS[type]) node.kids = parse(buf, o + 8, o + size);
    out.push(node);
    o += size;
  }
  return out;
}
function box(type, ...parts) { const body = Buffer.concat(parts), h = Buffer.alloc(8); h.writeUInt32BE(body.length + 8, 0); h.write(type, 4, 'latin1'); return Buffer.concat([h, body]); }
function write(nodes) { return Buffer.concat(nodes.map((n) => box(n.type, n.kids ? write(n.kids) : n.data))); }
function find(nodes, ...types) { let n = { kids: nodes }; for (const t of types) { n = n && n.kids && n.kids.find((k) => k.type === t); } return n; }
const u8 = (...v) => Buffer.from(v), u16 = (v) => { const b = Buffer.alloc(2); b.writeUInt16BE(v, 0); return b; }, u32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32BE(v, 0); return b; };

function protectInit(file) {
  const tree = parse(fs.readFileSync(file), 0, fs.statSync(file).size), stsd = find(tree, 'moov', 'trak', 'mdia', 'minf', 'stbl', 'stsd');
  const entry = stsd.data.slice(8), type = entry.toString('latin1', 4, 8), video = type === 'avc1';
  if (!video && type !== 'mp4a') throw new Error('unexpected sample entry ' + type);
  const sinf = box('sinf', box('frma', Buffer.from(type, 'latin1')), box('schm', u32(0), Buffer.from('cenc', 'latin1'), u32(0x00010000)),
    box('schi', box('tenc', u32(0), u8(0, 0, 1, 8), Buffer.from(KID, 'hex'))));
  stsd.data = Buffer.concat([stsd.data.slice(0, 8), box(video ? 'encv' : 'enca', entry.slice(8), sinf)]);
  fs.writeFileSync(file, write(tree));
  return video;
}

let ivCounter = 0;
function protectSegment(file, video) {
  const src = fs.readFileSync(file), tree = parse(src, 0, src.length);
  let pos = 0, grew = 0;
  tree.forEach((node) => {
    const at = pos; pos += node.data.length + 8;
    if (node.type !== 'moof') return;
    const traf = find([node], 'moof', 'traf'), tfhd = find(traf.kids, 'tfhd').data, trun = find(traf.kids, 'trun').data;
    const tf = tfhd.readUInt32BE(0) & 0xffffff, tr = trun.readUInt32BE(0) & 0xffffff, count = trun.readUInt32BE(4);
    if (!(tf & 0x020000) || (tf & 1) || !(tr & 1)) throw new Error('expected offsets counted from the moof box');
    let dflt = 0, o = 8;
    if (tf & 0x2) o += 4;
    if (tf & 0x8) o += 4;
    if (tf & 0x10) dflt = tfhd.readUInt32BE(o);
    let t = 12 + (tr & 0x4 ? 4 : 0), data = at + trun.readInt32BE(8);
    const infos = [];
    for (let i = 0; i < count; i++) {
      if (tr & 0x100) t += 4;
      const size = tr & 0x200 ? trun.readUInt32BE(t) : dflt;
      if (tr & 0x200) t += 4;
      if (tr & 0x400) t += 4;
      if (tr & 0x800) t += 4;
      if (!size) throw new Error('sample size not found');
      const iv = Buffer.alloc(8); iv.writeUInt32BE(++ivCounter, 4);
      const ranges = [], subs = [];
      if (!video) ranges.push([data, data + size]);
      else {
        // Each NAL: a 4-byte length, then the NAL.  Slices (types 1 and 5) are encrypted after their first byte.
        let clear = 0;
        for (let n = data; n < data + size;) {
          const len = src.readUInt32BE(n), nal = src[n + 4] & 0x1f;
          if ((nal === 1 || nal === 5) && len > 1) { subs.push([clear + 5, len - 1]); ranges.push([n + 5, n + 4 + len]); clear = 0; } else clear += 4 + len;
          n += 4 + len;
        }
        if (clear) subs.push([clear, 0]);
        if (subs.some((s) => s[0] > 0xffff)) throw new Error('clear part too long');
      }
      const c = crypto.createCipheriv('aes-128-ctr', Buffer.from(KEY, 'hex'), Buffer.concat([iv, Buffer.alloc(8)]));
      ranges.forEach(([a, b]) => c.update(src.slice(a, b)).copy(src, a));
      infos.push(video ? Buffer.concat([iv, u16(subs.length)].concat(subs.map((s) => Buffer.concat([u16(s[0]), u32(s[1])])))) : iv);
      data += size;
    }
    const before = write([node]).length;
    const saiz = box('saiz', u32(0), video ? Buffer.concat([u8(0), u32(count), Buffer.from(infos.map((x) => x.length))]) : Buffer.concat([u8(8), u32(count)]));
    const senc = box('senc', u32(video ? 2 : 0), u32(count), Buffer.concat(infos));
    const saio = box('saio', u32(0), u32(1), u32(before + saiz.length + 20 + 16));   // the first IV, counted from the moof box
    const added = saiz.length + saio.length + senc.length;
    trun.writeInt32BE(trun.readInt32BE(8) + added, 8);
    traf.kids.push({ type: 'saiz', data: saiz.slice(8) }, { type: 'saio', data: saio.slice(8) }, { type: 'senc', data: senc.slice(8) });
    grew += added;
  });
  // The samples were encrypted in the file's own bytes: mdat's data is a view of them.
  const sidx = find(tree, 'sidx');
  if (sidx) { const ref = 12 + (sidx.data[0] ? 16 : 8) + 4; sidx.data.writeUInt32BE(sidx.data.readUInt32BE(ref) + grew, ref); }
  fs.writeFileSync(file, write(tree));
}

const files = fs.readdirSync(dir), kinds = {};
files.filter((f) => /^init-\d+\.mp4$/.test(f)).forEach((f) => { kinds[/\d+/.exec(f)[0]] = protectInit(path.join(dir, f)); });
files.filter((f) => /^seg-\d+-\d+\.m4s$/.test(f)).sort().forEach((f) => protectSegment(path.join(dir, f), kinds[/^seg-(\d+)-/.exec(f)[1]]));

const id = KID.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');
const pssh = box('pssh', u32(0x01000000), Buffer.from('1077efecc0b24d02ace33c1e52e2fb4b', 'hex'), u32(1), Buffer.from(KID, 'hex'), u32(0)).toString('base64');
const cp = '<ContentProtection schemeIdUri="urn:mpeg:dash:mp4protection:2011" value="cenc" cenc:default_KID="' + id + '"/>' +
  '<ContentProtection schemeIdUri="urn:uuid:1077efec-c0b2-4d02-ace3-3c1e52e2fb4b"><cenc:pssh>' + pssh + '</cenc:pssh></ContentProtection>';
const mpd = path.join(dir, 'stream.mpd');
fs.writeFileSync(mpd, fs.readFileSync(mpd, 'utf8').replace('<MPD ', '<MPD xmlns:cenc="urn:mpeg:cenc:2013" ').replace(/(<AdaptationSet [^>]*>)/g, '$1' + cp));
