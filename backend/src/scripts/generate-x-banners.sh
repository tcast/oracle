#!/usr/bin/env bash
# Generate scenic / abstract X profile headers (~1500x500). NEVER faces.
# Requires ImageMagick (`magick`).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="${X_BANNER_DIR:-$ROOT/private/x-banners}"
mkdir -p "$OUT"
# Wipe prior pool (including any leftover portrait squares)
find "$OUT" -maxdepth 1 -type f \( -iname '*.jpg' -o -iname '*.jpeg' -o -iname '*.png' -o -iname '*.webp' \) -delete

gen() {
  local name="$1"; shift
  magick -size 1500x500 "$@" -quality 88 "$OUT/${name}.jpg"
  echo "wrote ${name}.jpg"
}

gen sky-dawn          gradient:'#1a1a2e-#e94560' \( +clone -sparse-color barycentric '0,0 #0f3460 750,250 #e94560 1499,499 #533483' \) -compose blend -define compose:args=60 -composite -blur 0x8
gen ocean-teal        gradient:'#0a1628-#1a535c' \( -size 1500x500 plasma:fractal -blur 0x12 -colorspace Gray -normalize \) -compose softlight -composite -modulate 100,40,110
gen dusk-violet       gradient:'#2d1b69-#f5576c' -blur 0x2 \( -size 1500x500 plasma:fractal -blur 0x20 \) -compose overlay -composite -modulate 95,70,100
gen mist-blue         gradient:'#667eea-#764ba2' \( -size 1500x500 plasma:fractal -blur 0x25 -colorspace Gray \) -compose softlight -composite
gen coastal-fog       gradient:'#89f7fe-#66a6ff' -blur 0x1 \( -size 1500x500 plasma:fractal -blur 0x30 \) -compose softlight -composite -modulate 105,50,100
gen forest-canopy     gradient:'#134e4a-#065f46' \( -size 1500x500 plasma:fractal -blur 0x8 -colorspace Gray -normalize \) -compose multiply -composite -modulate 90,60,100
gen meadow-haze       gradient:'#a8e063-#56ab2f' \( -size 1500x500 plasma:fractal -blur 0x18 \) -compose softlight -composite -modulate 100,55,105
gen pine-ridge        gradient:'#1b4332-#40916c' \( -size 1500x500 plasma:fractal -blur 0x14 -colorspace Gray \) -compose overlay -composite
gen city-night        gradient:'#0f0c29-#302b63' \( -size 1500x500 plasma:fractal -blur 0x6 \) -compose screen -composite -modulate 85,80,100 -fill '#ff6b35' -draw 'rectangle 200,380 280,500' -fill '#f7c948' -draw 'rectangle 900,360 940,500' -blur 0x3
gen neon-strip        gradient:'#141e30-#243b55' \( -size 1500x500 radial-gradient:'#00d2ff-#00000000' -gravity east \) -compose screen -composite \( -size 1500x500 radial-gradient:'#ff0080-#00000000' -gravity west \) -compose screen -composite -blur 0x4
gen stadium-lights    gradient:'#1a1a1a-#3d5a80' \( -size 1500x500 plasma:fractal -blur 0x10 -colorspace Gray \) -compose softlight -composite -modulate 90,40,100
gen asphalt-texture   gradient:'#2b2b2b-#4a4a4a' \( -size 1500x500 plasma:fractal -blur 0x2 -colorspace Gray -normalize -modulate 100,0 \) -compose softlight -composite
gen warm-sand         gradient:'#f6d365-#fda085' \( -size 1500x500 plasma:fractal -blur 0x22 \) -compose softlight -composite -modulate 105,60,100
gen terracotta-dusk   gradient:'#eb3349-#f45c43' \( -size 1500x500 plasma:fractal -blur 0x16 \) -compose softlight -composite -modulate 95,70,100
gen cream-linen       gradient:'#e8d5b7-#d4a373' \( -size 1500x500 plasma:fractal -blur 0x28 -colorspace Gray \) -compose softlight -composite
gen coral-wash        gradient:'#ff9a9e-#fecfef' \( -size 1500x500 plasma:fractal -blur 0x20 \) -compose softlight -composite
gen slate-grain       gradient:'#485563-#29323c' \( -size 1500x500 plasma:fractal -blur 0x3 -colorspace Gray -normalize \) -compose overlay -composite
gen indigo-haze       gradient:'#4b6cb7-#182848' \( -size 1500x500 plasma:fractal -blur 0x18 \) -compose softlight -composite
gen arctic-ice        gradient:'#e0eafc-#cfdef3' \( -size 1500x500 plasma:fractal -blur 0x25 -colorspace Gray \) -compose softlight -composite -modulate 108,30,100
gen charcoal-ember    gradient:'#232526-#414345' \( -size 1500x500 radial-gradient:'#ff512f-#00000000' \) -compose screen -composite -blur 0x8 -modulate 90,70,100

for base in sky-dawn ocean-teal forest-canopy city-night warm-sand slate-grain neon-strip meadow-haze; do
  magick "$OUT/${base}.jpg" -modulate 100,105,115 -quality 88 "$OUT/${base}-alt.jpg"
  magick "$OUT/${base}.jpg" -modulate 98,90,85 -quality 88 "$OUT/${base}-cool.jpg"
done

count=$(find "$OUT" -maxdepth 1 -type f -iname '*.jpg' | wc -l | tr -d ' ')
echo "Generated $count landscape banners in $OUT (all must be ~1500x500, never faces)"
identify -format "%f %wx%h\n" "$OUT"/*.jpg | awk '$2 != "1500x500" { bad=1; print "BAD", $0 } END { if (bad) exit 1 }'
