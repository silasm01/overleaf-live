#!/usr/bin/env python3
"""Packs the TeX Live files that a compile reads, plus a project, into
bundle.bin + bundle.json for test/worker.js (phase 1 test only; the
extension gets TeX Live files on demand in phase 4).

  strace -f -e trace=openat -o trace.txt texpresso-xetex -texlive main.tex
  make-bundle.py trace.txt <project folder> <output folder>
"""
import json, os, re, sys
trace, proj, out = sys.argv[1:4]
paths = set()
for line in open(trace):
    if 'ENOENT' in line:
        continue
    for m in re.findall(r'"(/(?:usr/share|var/lib|usr/local/share)[^"]*)"', line):
        if os.path.isfile(m):
            paths.add(m)
entries = [(p, p) for p in sorted(paths)]
for root, dirs, files in os.walk(proj, followlinks=True):
    for f in files:
        p = os.path.join(root, f)
        rel = os.path.relpath(p, proj)
        if rel.startswith(('template/', 'examples/', '.git/')) or \
           rel.endswith(('.aux', '.log', '.toc', '.out', '.xdv', '.pdf')):
            continue
        entries.append((p, '/project/' + rel))
index, off = [], 0
with open(os.path.join(out, 'bundle.bin'), 'wb') as blob:
    for src, dst in entries:
        data = open(src, 'rb').read()
        blob.write(data)
        index.append([dst, off, len(data)])
        off += len(data)
json.dump(index, open(os.path.join(out, 'bundle.json'), 'w'))
print(f'{len(entries)} files, {off // 1024} KB')
