#!/bin/bash
# Row of portrait frames: scripts/sheet-v.sh <comp> <out.png> f1 f2 ...
comp=$1; out=$2; shift 2
d=out/stills; ins=(); n=0
for f in "$@"; do ins+=(-i $d/$comp-$(printf %04d $f).png); n=$((n+1)); done
ffmpeg -loglevel error -y "${ins[@]}" -filter_complex "hstack=$n,scale=1920:-1" $d/$out
