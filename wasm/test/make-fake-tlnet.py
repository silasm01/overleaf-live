#!/usr/bin/env python3
"""Makes a test TeX Live repository ("tlnet": tlpkg/texlive.tlpdb.xz and
archive/<package>.tar.xz) from the TeX Live installed on this machine, for
tests of extension/engine/texlive.js without the network.

Packages are made from the folders (tex/latex/<pkg>, fonts/<kind>/<supplier>/<pkg>,
...), as TeX Live mostly makes them. Map files (fonts/map/dvips) give
"execute addMap", and language.dat gives "execute AddHyphen" lines.

  make-fake-tlnet.py <output folder> [texmf roots...]
"""
import io, lzma, os, sys, tarfile

out = sys.argv[1]
roots = sys.argv[2:] or ['/usr/share/texlive/texmf-dist', '/usr/share/texmf']
GENERATED = {'tex/generic/config/language.dat', 'tex/generic/config/language.def',
             'tex/generic/config/language.dat.lua', 'ls-R'}

def package_of(rel):
    parts = rel.split('/')
    if rel.startswith(('tex/generic/config/', 'tex/generic/hyphen/')):
        return 'hyphen-base'
    if parts[0] == 'fonts' and len(parts) >= 5:
        return parts[3] if parts[1] in ('map', 'enc') else parts[3]
    if parts[0] == 'fonts' and len(parts) >= 4:
        return parts[2]
    if len(parts) >= 4:
        return parts[2]
    if len(parts) >= 3:
        return parts[1]
    return 'misc'

files = {}                      # rel -> real path (the first root wins)
for root in roots:
    for d, _, names in os.walk(root, followlinks=True):
        for n in names:
            real = os.path.join(d, n)
            rel = os.path.relpath(real, root)
            if rel in GENERATED or rel.startswith(('doc/', 'source/', 'fonts/map/pdftex/updmap', 'web2c/')) or rel in files:
                continue
            if os.path.isfile(real):
                files[rel] = real

pkgs = {}
for rel in sorted(files):
    pkgs.setdefault(package_of(rel), []).append(rel)

hyph = []                       # AddHyphen entries from the installed language.dat
lang = '/var/lib/texmf/tex/generic/config/language.dat'
if os.path.exists(lang):
    after = False
    for line in open(lang, encoding='utf-8', errors='replace'):
        line = line.split('%')[0].strip()
        if not line:
            continue
        if line.startswith('='):
            if hyph: hyph[-1]['synonyms'].append(line[1:])
            continue
        name, file = line.split()[:2]
        if name in ('english', 'dumylang', 'nohyphenation', 'vietnamese', 'hebrew'):
            continue            # in language.us
        hyph.append({'name': name, 'file': file, 'synonyms': []})

os.makedirs(os.path.join(out, 'archive'), exist_ok=True)
os.makedirs(os.path.join(out, 'tlpkg'), exist_ok=True)
db = []
for name, rels in sorted(pkgs.items()):
    db.append(f'name {name}')
    db.append('category Package')
    db.append('revision 1')
    db.append('relocated 1')
    for rel in rels:
        if rel.startswith('fonts/map/dvips/') and rel.endswith('.map'):
            db.append(f'execute addMap {os.path.basename(rel)}')
    if name == 'hyph-utf8':
        for h in hyph:
            syn = f" synonyms={','.join(h['synonyms'])}" if h['synonyms'] else ''
            db.append(f"execute AddHyphen name={h['name']}{syn} lefthyphenmin=2 righthyphenmin=2 file={h['file']}")
    db.append(f'runfiles size={len(rels)}')
    db += [f' RELOC/{rel}' for rel in rels]
    db.append('')
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode='w', format=tarfile.GNU_FORMAT) as t:
        for rel in rels:
            t.add(files[rel], arcname=rel)
        info = tarfile.TarInfo(f'tlpkg/tlpobj/{name}.tlpobj')
        data = f'name {name}\n'.encode()
        info.size = len(data)
        t.addfile(info, io.BytesIO(data))
    with open(os.path.join(out, 'archive', f'{name}.tar.xz'), 'wb') as f:
        f.write(lzma.compress(buf.getvalue(), preset=1))
text = '\n'.join(db) + '\n'
with open(os.path.join(out, 'tlpkg', 'texlive.tlpdb.xz'), 'wb') as f:
    f.write(lzma.compress(text.encode(), preset=6))
print(f'{len(pkgs)} packages, {len(files)} files, {len(hyph)} hyphenation entries')
