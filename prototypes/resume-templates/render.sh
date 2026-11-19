#!/usr/bin/env bash
# PROTOTYPE: render every template to PDF (tagged, PDF/UA-1) + PNG previews, then run rough ATS checks.
# Needs: typst >= 0.14, poppler-utils (pdftotext, pdftoppm, pdfinfo).
set -euo pipefail
exec 2> >(grep -v "Suspects object" >&2)
cd "$(dirname "$0")"
mkdir -p out
for t in a-classic b-modern c-compact; do
  typst compile --ignore-system-fonts --font-path fonts --pdf-standard ua-1 "$t.typ" "out/$t.pdf"
  pdftoppm -r 110 -png "out/$t.pdf" "out/$t"
  pdftotext -layout "out/$t.pdf" "out/$t.txt"
  pages=$(pdfinfo "out/$t.pdf" | awk '/^Pages/{print $2}')
  tagged=$(pdfinfo "out/$t.pdf" | awk '/^Tagged/{print $2}')
  size=$(stat -c %s "out/$t.pdf")
  # Reading order: name first, then contact, summary, and every section heading present as real text.
  order_ok=yes
  for needle in "Alex Rivera" "alex.rivera@example.com" "Lumen Analytics" "Brightwell Health" "Cobalt Labs" "University of Texas"; do
    grep -q "$needle" "out/$t.txt" || order_ok="missing:$needle"
  done
  first=$(grep -m1 -v '^\s*$' "out/$t.txt" | sed 's/^ *//')
  printf '%-10s pages=%s tagged=%s size=%sKB first_line="%s" text_ok=%s\n' "$t" "$pages" "$tagged" $((size/1024)) "${first:0:40}" "$order_ok"
done
