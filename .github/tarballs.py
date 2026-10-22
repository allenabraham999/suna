import re,sys
lock=open('pnpm-lock.yaml').read()
pk=lock[lock.index('\npackages:\n'):]
out=set()
for m in re.finditer(r"^  '?/((?:@[^/]+/)?[^@/]+)@([^(:']+)[^:]*'?:\n((?:    .*\n)*)", pk, re.M):
    name,ver,body=m.groups()
    if 'tarball:' in body: continue
    base=name.split('/')[-1]
    out.add(f"{name}/-/{base}-{ver}.tgz")
for u in sorted(out): print(u)
