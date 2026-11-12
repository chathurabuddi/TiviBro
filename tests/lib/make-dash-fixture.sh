#!/usr/bin/env bash
# A tiny protected MPEG-DASH stream for the DASH soak test (tests/soak/dash-license.js): 12 s of
# ffmpeg's test pattern (160x90, 5 fps, H.264) and a tone (AAC), encrypted with a made-up test key
# ("ClearKey", the protection every browser has built in), so the whole path runs in a desktop
# browser: the playlist's license lines, the DASH player, the license request through the helper.
# No real media, no real key.
#   bash tests/lib/make-dash-fixture.sh      writes tests/lib/dash/
# Needs ffmpeg with libx264 (tested with 7.1.1) and node.  ffmpeg writes the stream; dash-encrypt.js
# protects it.  The outputs are committed; run this only to change them.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="$HERE/dash"; rm -rf "$OUT"; mkdir -p "$OUT"
KID=00112233445566778899aabbccddeeff
KEY=0f1e2d3c4b5a69788796a5b4c3d2e1f0
cd "$OUT"
ffmpeg -hide_banner -loglevel error -y -fflags +bitexact \
  -f lavfi -i testsrc=s=160x90:r=5:d=12 -f lavfi -i sine=f=440:d=12 -map 0:v -map 1:a \
  -c:v libx264 -preset ultrafast -crf 40 -g 10 -pix_fmt yuv420p -flags:v +bitexact -c:a aac -b:a 24k -ac 1 \
  -f dash -seg_duration 4 -use_template 1 -use_timeline 0 \
  -init_seg_name 'init-$RepresentationID$.mp4' -media_seg_name 'seg-$RepresentationID$-$Number$.m4s' stream.mpd
node "$HERE/dash-encrypt.js" "$OUT" "$KID" "$KEY"
ls -l "$OUT"
