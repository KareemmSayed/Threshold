#!/bin/bash
# Review a render without a player: contact sheets every half second, and the frames where the picture
# jumps the most (scene-change score), which should only be the wipes.
#   scripts/watch.sh out/threshold-launch-16x9.mp4
f=$1; name=$(basename "$f" .mp4); d=out/review/$name
mkdir -p "$d"
ffmpeg -loglevel error -y -i "$f" -vf "select='not(mod(n\,30))',scale=480:-2,tile=4x4" -fps_mode vfr "$d/sheet-%02d.png"
ffmpeg -hide_banner -i "$f" -vf "select='gte(scene,0)',metadata=print:file=$d/scene.txt" -an -f null - 2>/dev/null
awk '/pts_time:/{for(i=1;i<=NF;i++) if($i ~ /^pts_time:/){split($i,a,":"); t=a[2]}} /scene_score/{split($1,b,"="); printf "%7.3fs  frame %5d  %s\n", t, t*60+0.5, b[2]}' "$d/scene.txt" | sort -k4 -nr | head -25 > "$d/jumps.txt"
echo "$d"; cat "$d/jumps.txt"
