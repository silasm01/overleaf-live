import subprocess, sys, time, os, threading, json, shutil
proj, exp = sys.argv[1], sys.argv[2]
edits = [("catalog/guide.tex", "Worked examples are", "Worked examples (EDITED NOW) are", 20),
         ("catalog/guide.tex", "holds only what", "holds only and exactly what", 50)]
shutil.rmtree(exp, ignore_errors=True); os.makedirs(exp)
inc = []
for root, dirs, files in os.walk(os.path.join(proj, 'template')): inc += ['-I', root]
p = subprocess.Popen(['/tmp/tpn/build/texpresso', '-texlive', *inc, 'main.tex'], cwd=proj,
     env=dict(os.environ, SDL_VIDEODRIVER='offscreen'), stdin=subprocess.PIPE, stdout=subprocess.PIPE,
     stderr=open('/tmp/nat-timed-err.txt', 'w'))
t0 = time.time(); events = []
def reader():
    for raw in p.stdout:
        l = raw.decode('utf8', 'replace').strip()
        if l.startswith('(page-image') or l.startswith('(page-count'): events.append((time.time() - t0, l[:60]))
threading.Thread(target=reader, daemon=True).start()
def send(s): p.stdin.write((s + '\n').encode()); p.stdin.flush()
send(f'(export-png {json.dumps(exp)} 800)'); send('(export-range 0 2)'); send('(rescan)')
marks = [0]
for f, a, b, at in edits:
    time.sleep(max(0, at - (time.time() - t0)))
    path = os.path.join(proj, f); t = open(path).read().replace(a, b, 1); open(path, 'w').write(t)
    marks.append(time.time() - t0); send(f'(open {json.dumps(f, ensure_ascii=False)} {json.dumps(t, ensure_ascii=False)})')
time.sleep(15); p.kill()
for i, m in enumerate(marks):
    nxt = marks[i + 1] if i + 1 < len(marks) else 1e9
    imgs = [e for e in events if m <= e[0] < nxt and e[1].startswith('(page-image')]
    print(f'step {i} at {m:.1f}s: first page image after {((imgs[0][0]-m)*1000 if imgs else -1):.0f} ms, {len(imgs)} page images')
