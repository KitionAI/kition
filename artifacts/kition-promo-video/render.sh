#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel)"
BUILD_DIR="$SCRIPT_DIR/build"
ASSET_DIR="$SCRIPT_DIR/assets"
FINAL_VIDEO="$SCRIPT_DIR/kition-promo-final.mp4"
CONTACT_SHEET="$SCRIPT_DIR/kition-promo-contact-sheet.jpg"

command -v ffmpeg >/dev/null
command -v ffprobe >/dev/null
command -v magick >/dev/null

if ffmpeg -hide_banner -encoders 2>/dev/null | grep -q 'libx264'; then
  VIDEO_ENCODER_ARGS=(-c:v libx264 -preset slow -crf 17 -profile:v high -level 4.1)
elif ffmpeg -hide_banner -encoders 2>/dev/null | grep -q 'libopenh264'; then
  VIDEO_ENCODER_ARGS=(-c:v libopenh264 -b:v 10M -maxrate 14M -bufsize 20M)
elif ffmpeg -hide_banner -encoders 2>/dev/null | grep -q 'h264_videotoolbox'; then
  VIDEO_ENCODER_ARGS=(-c:v h264_videotoolbox -b:v 10M -maxrate 14M -bufsize 20M)
else
  echo "No H.264 encoder is available in FFmpeg." >&2
  exit 1
fi

FONT_FILE="${KITION_PROMO_FONT:-}"
if [[ -z "$FONT_FILE" ]] && command -v fc-match >/dev/null; then
  FONT_FILE="$(fc-match -f '%{file}\n' Arial | head -n 1)"
fi
if [[ -z "$FONT_FILE" || ! -f "$FONT_FILE" ]]; then
  echo "Set KITION_PROMO_FONT to a readable sans-serif font file." >&2
  exit 1
fi

rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR"

LOGO_MARK="$REPO_ROOT/public/logo-mark.png"
SHOT_ONBOARDING="$ASSET_DIR/onboarding-dark.png"
SHOT_AGENT="$ASSET_DIR/agent-console-dark.png"
SHOT_TABLE="$ASSET_DIR/table-dark.png"
SHOT_WORKFLOW="$ASSET_DIR/workflow-dark.png"
MUSIC_SOURCE="$ASSET_DIR/digital-clouds.mp3"

for asset in "$LOGO_MARK" "$SHOT_ONBOARDING" "$SHOT_AGENT" "$SHOT_TABLE" "$SHOT_WORKFLOW" "$MUSIC_SOURCE"; do
  if [[ ! -f "$asset" ]]; then
    echo "Missing required asset: ${asset#"$REPO_ROOT/"}" >&2
    exit 1
  fi
done

make_screen() {
  local source="$1"
  local output="$2"
  magick "$source" \
    -resize 1340x893 \
    -bordercolor '#303641' -border 2 \
    \( +clone -background '#000000' -shadow 55x18+0+18 \) \
    +swap -background none -layers merge \
    "$output"
}

make_feature_scene() {
  local source="$1"
  local kicker="$2"
  local title="$3"
  local detail="$4"
  local output="$5"
  local name
  name="$(basename "$output" .png)"

  magick "$source" \
    -resize '1920x1080^' -gravity center -extent 1920x1080 \
    -blur 0x28 -modulate 52,68,100 \
    -fill '#0e1116' -colorize 68 \
    "$BUILD_DIR/${name}-background.png"
  make_screen "$source" "$BUILD_DIR/${name}-screen.png"

  magick "$BUILD_DIR/${name}-background.png" \
    \( "$BUILD_DIR/${name}-screen.png" -resize 1370x920 \) \
    -gravity northwest -geometry +500+80 -composite \
    -fill '#5645d4' -draw 'roundrectangle 72,515 82,665 5,5' \
    -font "$FONT_FILE" -kerning 0 \
    -fill '#aeb7cf' -pointsize 24 -annotate +108+535 "$kicker" \
    -fill '#ffffff' -pointsize 40 -annotate +108+600 "$title" \
    -fill '#d6dae5' -pointsize 21 -annotate +108+642 "$detail" \
    \( "$LOGO_MARK" -resize 72x72 \) -gravity northwest -geometry +72+64 -composite \
    "$output"
}

magick -size 1920x1080 xc:'#0e1116' \
  -stroke '#ffffff12' -strokewidth 1 \
  -draw 'line 0,180 1920,180 line 0,360 1920,360 line 0,540 1920,540 line 0,720 1920,720 line 0,900 1920,900' \
  -draw 'line 240,0 240,1080 line 480,0 480,1080 line 720,0 720,1080 line 960,0 960,1080 line 1200,0 1200,1080 line 1440,0 1440,1080 line 1680,0 1680,1080' \
  \( "$SHOT_ONBOARDING" -resize 1120x747 -bordercolor '#303641' -border 2 -channel A -evaluate multiply 0.78 +channel \) \
  -gravity northwest -geometry +955+190 -composite \
  -fill '#5645d4' -draw 'roundrectangle 108,248 120,650 6,6' \
  \( "$LOGO_MARK" -resize 170x170 \) -gravity northwest -geometry +150+230 -composite \
  -font "$FONT_FILE" -kerning 0 \
  -fill '#ffffff' -pointsize 116 -annotate +350+350 'Kition' \
  -fill '#ffffff' -pointsize 54 -annotate +150+505 'Notes, tables & AI.' \
  -fill '#ffffff' -pointsize 54 -annotate +150+570 'All on your machine.' \
  -fill '#aeb7cf' -pointsize 25 -annotate +150+625 'A capable workspace that starts ready.' \
  "$BUILD_DIR/scene-00-title.png"

make_feature_scene "$SHOT_ONBOARDING" 'FIRST RUN' 'Ready on day one.' 'Guide, onboarding data, local workflows.' "$BUILD_DIR/scene-01-onboarding.png"
make_feature_scene "$SHOT_TABLE" 'TABLES' 'Query your tables.' 'Views, records, AI-ready structure.' "$BUILD_DIR/scene-02-table.png"
make_feature_scene "$SHOT_AGENT" 'AGENT' 'Agent ships work.' 'Read files, use tools, return results.' "$BUILD_DIR/scene-03-agent.png"
make_feature_scene "$SHOT_WORKFLOW" 'AUTOMATION' 'Automate your work.' 'Build, inspect, run, and refine.' "$BUILD_DIR/scene-04-workflow.png"

magick -size 1920x1080 xc:'#0e1116' \
  \( "$SHOT_ONBOARDING" -resize 960x640 -gravity center -crop 960x540+0+0 +repage -channel A -evaluate multiply 0.58 +channel \) -geometry +0+0 -composite \
  \( "$SHOT_TABLE" -resize 960x640 -gravity center -crop 960x540+0+0 +repage -channel A -evaluate multiply 0.48 +channel \) -geometry +960+0 -composite \
  \( "$SHOT_AGENT" -resize 960x640 -gravity center -crop 960x540+0+0 +repage -channel A -evaluate multiply 0.48 +channel \) -geometry +0+540 -composite \
  \( "$SHOT_WORKFLOW" -resize 960x640 -gravity center -crop 960x540+0+0 +repage -channel A -evaluate multiply 0.48 +channel \) -geometry +960+540 -composite \
  -fill '#0e1116b8' -draw 'rectangle 0,0 1920,1080' \
  \( "$LOGO_MARK" -resize 180x180 \) -gravity northwest -geometry +520+330 -composite \
  -font "$FONT_FILE" -kerning 0 \
  -fill '#ffffff' -pointsize 120 -annotate +735+455 'Kition' \
  -fill '#ffffff' -pointsize 48 -gravity north -annotate +0+560 'Your work. Your models. Your machine.' \
  -fill '#b9c0d3' -pointsize 30 -gravity north -annotate +0+635 'kition.ai' \
  -fill '#5645d4' -draw 'roundrectangle 800,715 1120,725 5,5' \
  "$BUILD_DIR/scene-05-close.png"

DURATION='26.75'

ffmpeg -hide_banner -loglevel error -y \
  -ss 6 -i "$MUSIC_SOURCE" -t "$DURATION" \
  -af "afade=t=in:st=0:d=0.7,afade=t=out:st=24.9:d=1.7,loudnorm=I=-18:TP=-1.5:LRA=9" \
  -ar 48000 -ac 2 -c:a pcm_s16le "$BUILD_DIR/music.wav"

ffmpeg -hide_banner -loglevel error -y \
  -loop 1 -t 4 -i "$BUILD_DIR/scene-00-title.png" \
  -loop 1 -t 5 -i "$BUILD_DIR/scene-01-onboarding.png" \
  -loop 1 -t 5 -i "$BUILD_DIR/scene-02-table.png" \
  -loop 1 -t 5 -i "$BUILD_DIR/scene-03-agent.png" \
  -loop 1 -t 5 -i "$BUILD_DIR/scene-04-workflow.png" \
  -loop 1 -t 5 -i "$BUILD_DIR/scene-05-close.png" \
  -i "$BUILD_DIR/music.wav" \
  -filter_complex "[0:v]fps=30,zoompan=z='1+0.05*on/120':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=1920x1080:fps=30,settb=AVTB,setpts=PTS-STARTPTS[v0];[1:v]fps=30,zoompan=z='1+0.09*on/150':x='iw/2-(iw/zoom/2)+14*sin(on/34)':y='ih/2-(ih/zoom/2)':d=1:s=1920x1080:fps=30,settb=AVTB,setpts=PTS-STARTPTS[v1];[2:v]fps=30,zoompan=z='1+0.085*on/150':x='iw/2-(iw/zoom/2)-14*sin(on/38)':y='ih/2-(ih/zoom/2)':d=1:s=1920x1080:fps=30,settb=AVTB,setpts=PTS-STARTPTS[v2];[3:v]fps=30,zoompan=z='1+0.09*on/150':x='iw/2-(iw/zoom/2)+12*sin(on/31)':y='ih/2-(ih/zoom/2)+7*sin(on/46)':d=1:s=1920x1080:fps=30,settb=AVTB,setpts=PTS-STARTPTS[v3];[4:v]fps=30,zoompan=z='1+0.095*on/150':x='iw/2-(iw/zoom/2)-12*sin(on/35)':y='ih/2-(ih/zoom/2)':d=1:s=1920x1080:fps=30,settb=AVTB,setpts=PTS-STARTPTS[v4];[5:v]fps=30,zoompan=z='1+0.05*on/150':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=1920x1080:fps=30,settb=AVTB,setpts=PTS-STARTPTS[v5];[v0][v1]xfade=transition=smoothleft:duration=0.45:offset=3.55[x1];[x1][v2]xfade=transition=wipeleft:duration=0.45:offset=8.10[x2];[x2][v3]xfade=transition=smoothleft:duration=0.45:offset=12.65[x3];[x3][v4]xfade=transition=wipeleft:duration=0.45:offset=17.20[x4];[x4][v5]xfade=transition=fade:duration=0.45:offset=21.75,format=yuv420p[v]" \
  -map '[v]' -map 6:a \
  -t "$DURATION" \
  "${VIDEO_ENCODER_ARGS[@]}" \
  -pix_fmt yuv420p -movflags +faststart \
  -c:a aac -b:a 192k \
  "$FINAL_VIDEO"

ffmpeg -hide_banner -loglevel error -y \
  -i "$FINAL_VIDEO" \
  -vf "fps=1/2.2,scale=480:-1,tile=4x3:padding=10:margin=10:color=#0e1116" \
  -frames:v 1 "$CONTACT_SHEET"

ffprobe -v error \
  -show_entries format=duration,size,bit_rate:stream=index,codec_name,codec_type,width,height,r_frame_rate,bit_rate \
  -of json "$FINAL_VIDEO" > "$SCRIPT_DIR/ffprobe-report.json"

echo "Rendered: ${FINAL_VIDEO#"$REPO_ROOT/"}"
echo "Contact sheet: ${CONTACT_SHEET#"$REPO_ROOT/"}"
