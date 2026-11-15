#!/bin/bash
# Two-by-two contact sheet: scripts/sheet.sh <comp> <out.png> f1 f2 f3 f4
comp=$1; out=$2; shift 2
d=out/stills
ffmpeg -loglevel error -y -i $d/$comp-$(printf %04d $1).png -i $d/$comp-$(printf %04d $2).png -i $d/$comp-$(printf %04d $3).png -i $d/$comp-$(printf %04d $4).png \
  -filter_complex "[0][1]hstack[a];[2][3]hstack[b];[a][b]vstack,scale=1920:-1" $d/$out
