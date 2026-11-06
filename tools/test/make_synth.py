"""Synthetic stand-in for the real inputs, so the pipeline and app can be built
before the PLATEAU/e-Stat files arrive.  Writes, into the output folder:
  buildings.json   same shape as extract_b3dm.js output
  blocks.shp/.dbf  like r2kb (basic unit blocks, SETAI/JINKO)
  areas.shp/.dbf   like r2ka (small areas, KEY_CODE/S_NAME/SETAI/JINKO)
  t083.txt t084.txt t082.txt   e-Stat style tables (code row + label row)
Usage: python make_synth.py OUTDIR [--real-estat] [--edge-cases]
  --real-estat  also write real-layout inputs: tblT001083C13.zip / tblT001084C13.zip /
                tblT001082C13.zip (CP932, real labels, ward/町/丁目 rows, '-' and X cells,
                a hidden area with HTKSAKI, a 町 without 丁目 = 13119020000 with only a
                9-digit row), r2kb13119.zip / r2ka13119.zip, and estat.json (what was done)
  --edge-cases  two L2 scenarios (the deeper without duration), invalid flood values, an
                L1-only building, a courtyard building with fp, blocks cut by report.bbox,
                blocks of 1-2 small buildings, duplicate KEY_CODE records, a slab reaching into
                a block without a residential building; edge.json lists them
Without options the output is the same as before.
"""
import io, json, math, os, random, struct, sys, tempfile, zipfile

def write_shp(base, polys, fields, rows):
    # polys: list of list-of-rings (lon,lat)
    recs = []
    for rings in polys:
        pts = [p for r in rings for p in (r + [r[0]])]
        parts = []; n = 0
        for r in rings:
            parts.append(n); n += len(r) + 1
        xs = [p[0] for p in pts]; ys = [p[1] for p in pts]
        c = struct.pack('<i4d2i', 5, min(xs), min(ys), max(xs), max(ys), len(parts), len(pts))
        c += struct.pack('<%di' % len(parts), *parts)
        c += b''.join(struct.pack('<2d', *p) for p in pts)
        recs.append(c)
    allx = [p[0] for rr in polys for r in rr for p in r]; ally = [p[1] for rr in polys for r in rr for p in r]
    body = b''; shx = b''; off = 50
    for i, c in enumerate(recs):
        body += struct.pack('>2i', i+1, len(c)//2) + c
        shx += struct.pack('>2i', off, len(c)//2); off += 4 + len(c)//2
    hdr = lambda L: struct.pack('>7i', 9994, 0, 0, 0, 0, 0, L) + struct.pack('<2i', 1000, 5) + struct.pack('<4d', min(allx), min(ally), max(allx), max(ally)) + struct.pack('<4d', 0, 0, 0, 0)
    open(base + '.shp', 'wb').write(hdr(50 + len(body)//2) + body)
    open(base + '.shx', 'wb').write(hdr(50 + len(shx)//2) + shx)
    # dbf
    nf = len(fields)
    h = struct.pack('<BBBBIHH20x', 3, 126, 1, 1, len(rows), 32 + 32*nf + 1, 1 + sum(f[2] for f in fields))
    for name, t, l in fields:
        h += struct.pack('<11sc4xBB14x', name.encode('ascii'), t.encode('ascii'), l, 0)
    h += b'\r'
    for r in rows:
        h += b' '
        for (name, t, l), v in zip(fields, r):
            s = str(v).encode('cp932')
            h += (s.rjust(l) if t == 'N' else s.ljust(l))[:l]
    h += b'\x1a'
    open(base + '.dbf', 'wb').write(h)

def write_zip(path, members):
    # members: [(name, bytes)], fixed timestamps so the zip is reproducible
    with zipfile.ZipFile(path, 'w', zipfile.ZIP_DEFLATED) as z:
        for n, data in members:
            z.writestr(zipfile.ZipInfo(n, date_time=(2021, 6, 25, 0, 0, 0)), data)

def zip_shp(path, name, polys, fields, rows):
    with tempfile.TemporaryDirectory() as tmp:
        write_shp(os.path.join(tmp, name), polys, fields, rows)
        members = []
        for e in ('.shp', '.shx', '.dbf'):
            with open(os.path.join(tmp, name + e), 'rb') as f:
                members.append((name + e, f.read()))
        write_zip(path, members)


opts = [v for v in sys.argv[1:] if v.startswith('--')]
bad = [v for v in opts if v not in ('--real-estat', '--edge-cases')]
if bad or len(sys.argv) - len(opts) != 2:
    sys.exit('usage: python make_synth.py OUTDIR [--real-estat] [--edge-cases]')
REAL, EDGE = '--real-estat' in opts, '--edge-cases' in opts
random.seed(7)
out = next(v for v in sys.argv[1:] if not v.startswith('--'))
os.makedirs(out, exist_ok=True)
LON0, LAT0 = 139.6300, 35.7750
KX = 111320 * math.cos(math.radians(LAT0)); KY = 110540
W, H = 4200.0, 2700.0
CITY = (W, H)       # H is reused below for the table header
GEOID = 36.7

def ll(x, y):
    return (round(LON0 + x / KX, 7), round(LAT0 + y / KY, 7))

def ground(x, y):  # orthometric height: plateau in the south, lowland in the north
    if y < 900: return 24 + 3 * math.sin(x / 700)
    if y < 1200: t = (y - 900) / 300; return 24 * (1 - t) + 3 * t
    return 3 + 0.6 * math.sin(x / 400)

def flood(x, y):
    if y < 1050: return 0.0
    d = 2.2 + 3.0 * (y - 1050) / 1300 + 0.6 * math.sin(x / 250) + random.uniform(-0.3, 0.3)
    return max(0.0, round(d, 2))

def rect(cx, cy, w, d, ang=0.0):
    c, s = math.cos(ang), math.sin(ang)
    pts = []
    for dx, dy in ((-w/2, -d/2), (w/2, -d/2), (w/2, d/2), (-w/2, d/2)):
        pts.append((cx + dx * c - dy * s, cy + dx * s + dy * c))
    return pts

cho_w, cho_h = 600.0, 675.0
def cho_of(x, y):
    i = min(int(x // cho_w), 6); j = min(int(y // cho_h), 3)
    return i, j
CHO_NAMES = ['あかつき', 'ひばり', 'みその', 'しんがし', 'よつば', 'とくまる', 'にしだい']
KANJI = ['一', '二', '三', '四']
def cho_key(i, j):
    return '13119%03d%03d' % (10 + i, j + 1)

blds = []
gid = 0
def add(ring, usage, st, x, y, kind):
    global gid
    gid += 1
    g = ground(x, y)
    fh = 2.9 if usage in ('住宅', '店舗等併用住宅') else 3.0
    h = round(st * fh + random.uniform(0.2, 1.2), 1)
    z0 = round(g + GEOID, 2); z1 = round(z0 + h, 2)
    i, j = cho_of(x, y)
    a = {'gml_id': 'bldg_%06d' % gid, 'bldg:usage': usage, 'bldg:storeysAboveGround': st,
         'bldg:measuredHeight': h, '13+区市町村コード+大字・町コード+町・丁目コード': cho_key(i, j),
         '_x': ll(x, y)[0], '_y': ll(x, y)[1], '_zmin': round(g, 2), '_zmax': round(g + h, 2),
         'city_code': '13119'}
    d = flood(x, y)
    if d > 0:
        p = '荒川水系荒川（国管理区間）_L2（想定最大規模）'
        a[p + '_浸水深'] = d
        a[p + '_浸水継続時間'] = round(72 + 240 * min(1, (y - 1050) / 1300), 1)
        a[p + '_浸水ランク'] = '3m以上5m未満' if d >= 3 else '0.5m以上3m未満'
        a[p + '_浸水ランクコード'] = 4 if d >= 3 else 3
        if d > 1.0:
            p1 = '荒川水系荒川（国管理区間）_L1（計画規模）'
            a[p1 + '_浸水深'] = round(d * 0.55, 2)
            a[p1 + '_浸水継続時間'] = round(24 + 96 * min(1, (y - 1050) / 1300), 1)
    blds.append({'id': a['gml_id'], 'ring': [list(ll(px, py)) for px, py in ring], 'z0': z0, 'z1': z1, 'a': a, '_x': x, '_y': y, '_k': kind})

# danchi cluster (lowland): long slabs
for row in range(9):
    for col in range(3):
        x = 1650 + col * 260 + random.uniform(-10, 10); y = 1350 + row * 75
        st = 14 if row % 3 == 0 else (11 if row % 3 == 1 else 5)
        add(rect(x, y, 150 if st > 5 else 90, 13, 0.02), '共同住宅', st, x, y, 'danchi')
# streets: blocks 90 x 70 m with houses and small apartments
for bx in range(0, int(W), 90):
    for by in range(0, int(H) - 250, 70):
        cx, cy = bx + 45, by + 35
        if 1560 < cx < 2480 and 1300 < cy < 2050:  # danchi area
            continue
        r = random.random()
        if r < 0.05:  # park / school
            if random.random() < 0.5:
                add(rect(cx, cy, 60, 22), '文教厚生施設', 3, cx, cy, 'school')
            continue
        main_road = (bx % 630 == 0) or (by % 490 == 0)
        for k in range(12):
            hx = bx + 10 + (k % 6) * 13 + random.uniform(-1, 1)
            hy = by + 15 + (k // 6) * 32 + random.uniform(-1, 1)
            u = random.random()
            if main_road and k < 6:
                if u < 0.45: add(rect(hx, hy, 11, 12), '店舗等併用住宅', 3, hx, hy, 'shop')
                elif u < 0.7: add(rect(hx, hy, 12, 14), '店舗等併用共同住宅', random.choice([4, 5, 6, 7]), hx, hy, 'shopapt')
                elif u < 0.85: add(rect(hx, hy, 12, 12), '商業施設', 2, hx, hy, 'com')
                else: add(rect(hx, hy, 12, 12), '業務施設', 4, hx, hy, 'off')
            else:
                if u < 0.70: add(rect(hx, hy, 8.5, 9.5), '住宅', random.choice([2, 2, 2, 3]), hx, hy, 'house')
                elif u < 0.88: add(rect(hx, hy, 11, 16), '共同住宅', random.choice([2, 3, 3, 4]), hx, hy, 'apt')
                elif u < 0.93: add(rect(hx, hy, 11, 14), '共同住宅', random.choice([6, 8, 10]), hx, hy, 'mansion')
                elif u < 0.96: add(rect(hx, hy, 3, 2.5), '不明', 1, hx, hy, 'shed')
                else: add(rect(hx, hy, 12, 12), '作業所併用住宅', 2, hx, hy, 'work')

# households per building (truth used to make census numbers)
UNIT = {'住宅': None, '共同住宅': 50, '店舗等併用住宅': 110, '店舗等併用共同住宅': 50, '作業所併用住宅': 130}
def true_hh(b):
    u = b['a']['bldg:usage']; st = b['a']['bldg:storeysAboveGround']
    x = [p[0] for p in b['ring']]; y = [p[1] for p in b['ring']]
    area = (max(x) - min(x)) * KX * (max(y) - min(y)) * KY * 0.9
    if u == '住宅': return 1 if random.random() < 0.9 else (2 if random.random() < 0.3 else 0)
    if u in UNIT:
        fac = 0.8 if '店舗' in u else 0.85
        n = area * st * fac / UNIT[u] * random.uniform(0.75, 1.05)
        return max(0, int(round(n)))
    return 0
for b in blds:
    b['_hh'] = true_hh(b)
    k = b['_k']
    b['_s'] = sum(1 for _ in range(b['_hh']) if random.random() < {'danchi': 0.42, 'apt': 0.7, 'mansion': 0.5, 'shopapt': 0.55, 'house': 0.12, 'shop': 0.2, 'work': 0.15}.get(k, 0.3))
    old = 0.6 if k == 'danchi' else (0.35 if k in ('house', 'shop', 'work') else 0.18)
    b['_e'] = sum(1 for _ in range(b['_s']) if random.random() < old)

EXT_E = 4150.0    # --edge-cases: report.bbox ends here in the east (cuts the blocks of x 4100-4200)
edge = {}
if EDGE:
    # courtyard building (ring = outer wall, fp = net footprint) next to a solid twin, in one block
    for nm, (x, y, fp) in (('courtyard', (2325, 1725, 1200.0)), ('solid', (2375, 1775, None))):
        add(rect(x, y, 40, 40), '共同住宅', 5, x, y, 'edge')
        b = blds[-1]; b['id'] = b['a']['gml_id'] = 'edge_' + nm
        if fp:
            b['fp'] = fp
        b['_hh'] = int(round((fp or 1600.0) * 5 * 0.85 / 50 * 0.9)); b['_s'] = b['_hh'] // 2; b['_e'] = b['_hh'] // 8
        edge[nm] = b['id']
    # blocks holding only 1-2 small buildings (their types must come from 町丁目 or view pools)
    edge['sparse'] = []
    for n, (x, kind) in enumerate(((350, 'house'), (720, 'house'), (760, 'house'), (950, 'apt'), (1120, 'apt'),
                                   (1160, 'apt'), (2050, 'apt'), (3020, 'house'), (3060, 'apt'), (3850, 'apt'))):
        if kind == 'house':
            add(rect(x, 2520, 8.5, 9.5), '住宅', 2, x, 2520, 'house')
            blds[-1].update(_hh=1, _s=n % 2, _e=n % 2)
        else:
            add(rect(x, 2520, 11, 16), '共同住宅', 2, x, 2520, 'apt')
            blds[-1].update(_hh=5, _s=3, _e=1)
        blds[-1]['id'] = blds[-1]['a']['gml_id'] = 'edge_sparse_%d' % n
        edge['sparse'].append(blds[-1]['id'])
    # flood attributes: a deeper second L2 scenario without duration, a tie, bad values, L1 only
    P = '荒川水系荒川（国管理区間）_L2（想定最大規模）'; P1 = '荒川水系荒川（国管理区間）_L1（計画規模）'
    wet = [b for b in blds if P + '_浸水深' in b['a']]
    edge['twoL2'] = []
    for b in wet[::7]:
        b['a']['荒川水系新河岸川_L2（想定最大規模）_浸水深'] = round(b['a'][P + '_浸水深'] + 0.4, 2)
        edge['twoL2'].append(b['id'])
    b = wet[3]; b['a']['荒川水系隅田川_L2（想定最大規模）_浸水深'] = b['a'][P + '_浸水深']; edge['tie'] = b['id']
    b = wet[4]; b['a']['テスト川_L2（想定最大規模）_浸水深'] = -9999; edge['badDepth'] = b['id']
    b = wet[5]; b['a'][P + '_浸水継続時間'] = -9999; edge['badDuration'] = b['id']
    b = next(b for n, b in enumerate(wet) if n > 7 and n % 7 and P1 + '_浸水深' in b['a'])
    for k in [k for k in b['a'] if k.startswith(P)]:
        del b['a'][k]
    edge['l1only'] = b['id']
    # a slab centred in one block reaching 40 m into the next, whose households have no residential building
    add(rect(2580, 2530, 120, 12), '共同住宅', 6, 2580, 2530, 'edge')
    blds[-1].update(id='edge_reach', _hh=40, _s=20, _e=5); blds[-1]['a']['gml_id'] = 'edge_reach'
    add(rect(2680, 2530, 3, 2.5), '不明', 1, 2680, 2530, 'shed')
    blds[-1].update(_hh=20, _s=10, _e=3)        # census households of the shed's block (they live in the slab)
    edge['reach'] = {'slab': 'edge_reach', 'shed': blds[-1]['id']}

# blocks 100 x 100 m
blocks = {}
for b in blds:
    key = (int(b['_x'] // 100), int(b['_y'] // 100))
    blocks.setdefault(key, []).append(b)
bpolys, brows = [], []
for (i, j), bs in sorted(blocks.items()):
    hh = sum(b['_hh'] for b in bs)
    x1, y1 = i * 100, j * 100
    ring = [ll(x1, y1), ll(x1 + 100, y1), ll(x1 + 100, y1 + 100), ll(x1, y1 + 100)]
    bpolys.append([ring])
    ci, cj = cho_of(x1 + 50, y1 + 50)
    brows.append((cho_key(ci, cj)[:11] + '%04d' % (len(brows) + 1), int(hh * 2.05), hh))
def halves(i, j):
    x1, y1 = i * 100, j * 100
    return ([ll(x1, y1), ll(x1 + 50, y1), ll(x1 + 50, y1 + 100), ll(x1, y1 + 100)],
            [ll(x1 + 50, y1), ll(x1 + 100, y1), ll(x1 + 100, y1 + 100), ll(x1 + 50, y1 + 100)])
if EDGE:
    # one block stored as two records repeating SETAI/JINKO, one with its numbers split
    bkeys = sorted(blocks)
    edge['dupBlocks'] = {}
    for cell, mode in (((10, 10), 'repeat'), ((12, 10), 'split')):
        n = bkeys.index(cell); key, jinko, hh = brows[n]
        west, east = halves(*cell)
        bpolys[n] = [west]; bpolys.append([east])
        if mode == 'repeat':
            brows.append((key, jinko, hh))
        else:
            brows[n] = (key, jinko - jinko // 3, hh - hh // 3); brows.append((key, jinko // 3, hh // 3))
        edge['dupBlocks'][key] = {'mode': mode, 'SETAI': hh}
    edge['cutBlocks'] = sorted(brows[n][0] for n, c in enumerate(bkeys) if c[0] * 100 < EXT_E < c[0] * 100 + 100)
BFIELDS = [('KEY_CODE', 'C', 16), ('JINKO', 'N', 8), ('SETAI', 'N', 8)]
write_shp(os.path.join(out, 'blocks'), bpolys, BFIELDS, brows)

# small areas (cho-chome)
apolys, arows, stat = [], [], []
for i in range(7):
    for j in range(4):
        x1, y1 = i * cho_w, j * cho_h
        ring = [ll(x1, y1), ll(x1 + cho_w, y1), ll(x1 + cho_w, y1 + cho_h), ll(x1, y1 + cho_h)]
        bs = [b for b in blds if cho_of(b['_x'], b['_y']) == (i, j)]
        hh = sum(b['_hh'] for b in bs); s = sum(b['_s'] for b in bs); e = sum(b['_e'] for b in bs)
        pop = int(hh * 2.05)
        p65 = int(pop * (0.42 if any(b['_k'] == 'danchi' for b in bs) else 0.24))
        h65 = int(hh * 0.45)
        apolys.append([ring])
        name = '%s%s丁目' % (CHO_NAMES[i], KANJI[j])
        arows.append((cho_key(i, j), name, '板橋区', pop, hh))
        stat.append((cho_key(i, j), name, hh, s, h65, pop, p65, e))
if EDGE:
    # よつば二丁目 stored as two records that both repeat its SETAI/JINKO
    n = 4 * 4 + 1; x1, y1 = 4 * cho_w, 1 * cho_h; xm = x1 + cho_w / 2
    apolys[n] = [[ll(x1, y1), ll(xm, y1), ll(xm, y1 + cho_h), ll(x1, y1 + cho_h)]]
    apolys.append([[ll(xm, y1), ll(x1 + cho_w, y1), ll(x1 + cho_w, y1 + cho_h), ll(xm, y1 + cho_h)]])
    arows.append(arows[n]); edge['dupArea'] = arows[n][0]
AFIELDS = [('KEY_CODE', 'C', 11), ('S_NAME', 'C', 40), ('CITY_NAME', 'C', 20), ('JINKO', 'N', 8), ('SETAI', 'N', 8)]
write_shp(os.path.join(out, 'areas'), apolys, AFIELDS, arows)

def table(path, codes, labels, rows):
    with open(path, 'w', encoding='cp932', newline='') as f:
        f.write(','.join(codes) + '\r\n' + ','.join(labels) + '\r\n')
        for r in rows:
            f.write(','.join(str(v) for v in r) + '\r\n')
H = ['KEY_CODE', 'HYOSYO', 'CITYNAME', 'NAME', 'HTKSYORI', 'HTKSAKI', 'GASSAN']
HL = ['', '', '', '', '', '', '']
table(os.path.join(out, 't083.txt'), H + ['T001083001', 'T001083002', 'T001083003'], HL + ['一般世帯数', '世帯人員が１人', '世帯人員が２人'],
      [(k, 3, '板橋区', n, 0, '', '', hh, s, int(hh * 0.3)) for k, n, hh, s, h65, pop, p65, e in stat])
table(os.path.join(out, 't084.txt'), H + ['T001084001', 'T001084020', 'T001084030'], HL + ['一般世帯総数', '単独世帯', '６５歳以上世帯員のいる一般世帯'],
      [(k, 3, '板橋区', n, 0, '', '', hh, s, h65) for k, n, hh, s, h65, pop, p65, e in stat])
table(os.path.join(out, 't082.txt'), H + ['T001082001', 'T001082019'], HL + ['総数', '総数６５歳以上'],
      [(k, 3, '板橋区', n, 0, '', '', pop, p65) for k, n, hh, s, h65, pop, p65, e in stat])

if REAL:
    # ---- real-layout e-Stat inputs (ported from the review's mk_tables.py / mk_estat.py)
    CHOLESS = {'13119012002': ('13119020000', 'だいもん')}   # みその二丁目 becomes a 町 without 丁目
    HIDE = ('13119013002', '131190200')                       # しんがし二丁目 hidden, HTKSAKI = だいもん (9 digits)
    F = ('gen', 'single', 'h65', 'pop', 'p65')
    A = {}
    for k, nm, hh, s, h65, pop, p65, e in stat:
        k2, nm2 = CHOLESS.get(k, (k, nm))
        A[k2] = dict(name=nm2, gen=hh, single=s, h65=h65, pop=pop, p65=p65)
    def split(n, k):
        return [n // k + (1 if i < n % k else 0) for i in range(k)]
    def v083(d):
        g, s = d['gen'], d['single']; two = int(g * 0.3); rest = max(0, g - s - two)
        return [g, s, two, rest // 2, rest - rest // 2, 0, 0, 0, d['pop'], round(d['pop'] / max(g, 1), 2)]
    def v084(d):
        g = d['gen']; kin = g - d['single'] - g // 50; nuc = int(kin * 0.85)
        return [g, kin, nuc, nuc // 3, nuc // 2, kin - nuc, g // 20, g // 6, d['h65']]
    def v082(d):
        pop, p65 = d['pop'], d['p65']; p75 = p65 // 2; young = pop // 8; mid = pop - p65 - young
        tot = [pop] + split(young, 3) + split(mid, 10) + split(p65 - p75, 2) + [young, mid, p65, p75]
        m = [v // 2 for v in tot]
        return tot + m + [x - y for x, y in zip(tot, m)]
    AGES = ['０～４歳', '５～９歳', '１０～１４歳', '１５～１９歳', '２０～２４歳', '２５～２９歳', '３０～３４歳', '３５～３９歳',
            '４０～４４歳', '４５～４９歳', '５０～５４歳', '５５～５９歳', '６０～６４歳', '６５～６９歳', '７０～７４歳',
            '１５歳未満', '１５～６４歳', '６５歳以上', '７５歳以上']
    LAB = {'083': ['一般世帯総数', '世帯人員１人', '世帯人員２人', '世帯人員３人', '世帯人員４人', '世帯人員５人',
                   '世帯人員６人', '世帯人員７人以上', '一般世帯人員', '１世帯当たり人員'],
           '084': ['一般世帯総数', '親族のみの世帯', '核家族世帯', 'うち夫婦のみ', 'うち夫婦と子供', '核家族以外',
                   '６歳未満世帯員のいる世帯', '１８歳未満世帯員のいる世帯', '６５歳以上世帯員のいる一般世帯'],
           '082': [sx + ('（年齢「不詳」含む）' if a == '' else a) for sx in ('総数', '男', '女') for a in [''] + AGES]}
    VF = {'083': v083, '084': v084, '082': v082}
    cell = lambda v: '-' if v == 0 else str(v)
    def add_up(ds):
        return {f: sum(d[f] for d in ds) for f in F}
    recv = HIDE[1] + '00'
    for code in ('083', '084', '082'):
        lab = LAB[code]; vf = VF[code]
        lines = [','.join(H + ['T001%s%03d' % (code, i + 1) for i in range(len(lab))]), ','.join(HL + lab)]
        row = lambda key, lvl, nm, flags, vals: lines.append(','.join([key, lvl, '板橋区', nm] + flags + vals))
        row('13119', '1', '', ['0', '', ''], [cell(v) for v in vf(add_up(A.values()))])
        for c9 in sorted({k[:9] for k in A}):
            ks = sorted(k for k in A if k[:9] == c9)
            if ks == [c9 + '00'] and c9 + '00' in [v[0] for v in CHOLESS.values()]:
                d = dict(A[ks[0]])
                if ks[0] == recv:
                    d = add_up([d, A[HIDE[0]]])
                row(c9, '2', A[ks[0]]['name'], ['2', '', HIDE[0]] if ks[0] == recv else ['0', '', ''], [cell(v) for v in vf(d)])
                continue
            row(c9, '2', A[ks[0]]['name'][:-3], ['0', '', ''], [cell(v) for v in vf(add_up([A[k] for k in ks]))])
            for k in ks:
                if k == HIDE[0]:
                    row(k, '3', A[k]['name'], ['1', HIDE[1], ''], ['X'] * len(lab))
                else:
                    row(k, '3', A[k]['name'], ['0', '', ''], [cell(v) for v in vf(A[k])])
        lines.append(','.join(['13120', '1', '練馬区', '', '0', '', ''] + ['-'] * len(lab)))
        lines.append(','.join(['131200010', '2', '練馬区', '旭丘', '0', '', ''] + ['X'] * len(lab)))
        lines.append(','.join(['13120001001', '3', '練馬区', '旭丘１丁目', '0', '', ''] + ['-'] * len(lab)))
        name = 'tblT001%sC13' % code
        write_zip(os.path.join(out, name + '.zip'), [(name + '.txt', ('\r\n'.join(lines) + '\r\n').encode('cp932'))])
    zip_shp(os.path.join(out, 'r2kb13119.zip'), 'r2kb13119', bpolys, BFIELDS, brows)
    arows2 = [(CHOLESS[r[0]][0], CHOLESS[r[0]][1]) + tuple(r[2:]) if r[0] in CHOLESS else r for r in arows]
    zip_shp(os.path.join(out, 'r2ka13119.zip'), 'r2ka13119', apolys, AFIELDS, arows2)
    with open(os.path.join(out, 'estat.json'), 'w', encoding='utf-8') as f:
        json.dump({'choless': CHOLESS['13119012002'][0], 'choless9': '131190200', 'hidden': HIDE[0], 'htksaki': HIDE[1]}, f)

truth = {'households': sum(b['_hh'] for b in blds), 'single': sum(b['_s'] for b in blds), 'elderly_single': sum(b['_e'] for b in blds)}
report = {'tiles': 0, 'features': len(blds), 'kept': len(blds), 'dup': 0, 'axisModes': {'synthetic': 1}, 'errors': [], 'keys': {}}
if EDGE:
    report['bbox'] = list(ll(0, 0) + ll(EXT_E, CITY[1]))
    edge['bbox'] = report['bbox']
    with open(os.path.join(out, 'edge.json'), 'w', encoding='utf-8') as f:
        json.dump(edge, f, ensure_ascii=False, indent=1)
json.dump({'buildings': [{k: v for k, v in b.items() if not k.startswith('_')} for b in blds],
           'report': report},
          open(os.path.join(out, 'buildings.json'), 'w', encoding='utf-8'), ensure_ascii=False)
json.dump(truth, open(os.path.join(out, 'truth.json'), 'w'))
print(len(blds), 'buildings', len(brows), 'blocks', len(arows), 'areas', truth)
