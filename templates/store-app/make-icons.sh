#!/usr/bin/env bash
# Makes the store's app icons: its initials on the brand teal.
#   make-icons.sh "Mama Nkechi Mart" out/
# Needs ImageMagick (preinstalled on GitHub's Ubuntu runners).
set -euo pipefail
NAME="$1"; OUT="${2:-icons}"; mkdir -p "$OUT"
INITIALS=$(echo "$NAME" | tr -cs '[:alnum:]' ' ' | awk '{for(i=1;i<=NF&&i<=2;i++) printf toupper(substr($i,1,1))}')
[ -n "$INITIALS" ] || INITIALS="S"
IM=$(command -v magick || command -v convert)
$IM -size 1024x1024 xc:none -fill '#0f7180' -draw 'roundrectangle 0,0 1023,1023 200,200' \
  -fill white -font DejaVu-Sans-Bold -pointsize 460 -gravity center -annotate +0+20 "$INITIALS" "$OUT/icon-1024.png"
$IM "$OUT/icon-1024.png" -resize 512x512 "$OUT/icon.png"
$IM "$OUT/icon-1024.png" -define icon:auto-resize=256,128,64,48,32,16 "$OUT/icon.ico"
# Android launcher icons (legacy square + round), per screen density.
for d in mdpi:48 hdpi:72 xhdpi:96 xxhdpi:144 xxxhdpi:192; do
  n=${d%%:*}; s=${d##*:}; mkdir -p "$OUT/android/mipmap-$n"
  $IM "$OUT/icon-1024.png" -resize ${s}x${s} "$OUT/android/mipmap-$n/ic_launcher.png"
  $IM -size 1024x1024 xc:none -fill '#0f7180' -draw 'circle 512,512 512,0' -fill white -font DejaVu-Sans-Bold \
    -pointsize 400 -gravity center -annotate +0+20 "$INITIALS" -resize ${s}x${s} "$OUT/android/mipmap-$n/ic_launcher_round.png"
done
echo "icons for '$NAME' ($INITIALS) in $OUT"
