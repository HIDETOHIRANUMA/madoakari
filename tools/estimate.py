#!/usr/bin/env python3
"""まどあかり: estimate households per building and pack the data for the web app.

Standard library only (Python 3.8+, Windows or Linux).

  python estimate.py --buildings takashimadaira_buildings.json \
      --blocks r2kb13119.shp --areas r2ka13119.shp \
      --t083 tblT001083H13.txt --t084 tblT001084H13.txt --t082 tblT001082H13.txt \
      --ward-elderly-single 37998 --city 13119 \
      --bbox 139.630,35.775,139.680,35.800 --name 高島平 --out ../data

Inputs
  buildings  output of extract_b3dm.js (PLATEAU 3D Tiles -> footprints + attributes)
  blocks     e-Stat 2020 census basic unit block boundaries (基本単位区, SETAI/JINKO)
  areas      e-Stat 2020 census small area boundaries (小地域)
  t083/t084/t082  e-Stat small area tables (世帯人員 / 家族類型 / 年齢)

Method (shown in the app as 推計方法)
  1. Each building gets an expected number of households from its use, floors and
     footprint: a detached house is about one household, apartments are floor area
     divided by a typical dwelling size.
  2. The households of each basic unit block (census) are shared out to the
     buildings in it in proportion to that expectation, so block totals stay exact.
  3. Single-person households of each small area (census) are shared out with
     weights by building type and dwelling size; the small area total stays exact.
  4. Elderly single households: the ward total (census) is shared out to small
     areas by singles x share of people aged 65+, capped by the census counts of
     singles and of households with a member aged 65+, then to buildings.
  5. Flood: PLATEAU flood attributes (depth, duration) per building. Floors whose
     floor level is under the expected depth count as flooded floors.
All per-building numbers are estimates.  Only area totals are census figures.
"""
import argparse, csv, io, json, math, os, re, struct, sys, zipfile
from collections import defaultdict

GEOID_DEFAULT = 36.7          # m, geoid height around Itabashi (ellipsoid - orthometric)
SMALL_BUILDING = 10           # below this many households, type counts are shown per block only

USAGE = {  # label or code -> (code, short name, residential factor, m2 per dwelling)
    '住宅': ('411', '住宅', 1.0, None), '411': ('411', '住宅', 1.0, None),
    '共同住宅': ('412', '共同住宅', 0.85, 55.0), '412': ('412', '共同住宅', 0.85, 55.0),
    '店舗等併用住宅': ('413', '店舗等併用住宅', 0.6, 95.0), '413': ('413', '店舗等併用住宅', 0.6, 95.0),
    '店舗等併用共同住宅': ('414', '店舗等併用共同住宅', 0.7, 55.0), '414': ('414', '店舗等併用共同住宅', 0.7, 55.0),
    '作業所併用住宅': ('415', '作業所併用住宅', 0.6, 100.0), '415': ('415', '作業所併用住宅', 0.6, 100.0),
}
USAGE_CLASS = ['その他', '住宅', '共同住宅', '店舗等併用住宅', '店舗等併用共同住宅', '作業所併用住宅',
               '商業・業務', '文教厚生', '官公庁', '工場・倉庫', '不明']
CLASS_OF = {'411': 1, '412': 2, '413': 3, '414': 4, '415': 5}
NONRES_CLASS = [('商業', 6), ('業務', 6), ('宿泊', 6), ('文教', 7), ('厚生', 7), ('官公', 8),
                ('工場', 9), ('倉庫', 9), ('運輸', 9), ('不明', 10)]

warnings = []
def warn(msg):
    if len(warnings) < 300:
        warnings.append(msg)

# ------------------------------------------------------------------ geometry

class Local:
    """Equirectangular metres around an origin (good to a few cm over a few km)."""
    def __init__(self, lon0, lat0):
        self.lon0, self.lat0 = lon0, lat0
        self.kx = 111320.0 * math.cos(math.radians(lat0)) * (1 - 0.00669438 * math.sin(math.radians(lat0)) ** 2) ** -0.5
        self.ky = 110574.0 + 1110.0 * math.sin(math.radians(lat0)) ** 2
    def xy(self, lon, lat):
        return ((lon - self.lon0) * self.kx, (lat - self.lat0) * self.ky)
    def ll(self, x, y):
        return (self.lon0 + x / self.kx, self.lat0 + y / self.ky)

def area_xy(r):
    s = 0.0
    for i in range(len(r)):
        x1, y1 = r[i]; x2, y2 = r[(i + 1) % len(r)]
        s += x1 * y2 - x2 * y1
    return s / 2.0

def centroid_xy(r):
    a = 0.0; cx = 0.0; cy = 0.0
    for i in range(len(r)):
        x1, y1 = r[i]; x2, y2 = r[(i + 1) % len(r)]
        c = x1 * y2 - x2 * y1
        a += c; cx += (x1 + x2) * c; cy += (y1 + y2) * c
    if abs(a) < 1e-9:
        return (sum(p[0] for p in r) / len(r), sum(p[1] for p in r) / len(r))
    return (cx / (3 * a), cy / (3 * a))

def point_in_ring(x, y, ring):
    inside = False
    j = len(ring) - 1
    for i in range(len(ring)):
        xi, yi = ring[i]; xj, yj = ring[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi + 1e-300) + xi:
            inside = not inside
        j = i
    return inside

def point_in_parts(x, y, parts):
    c = False
    for r in parts:
        if point_in_ring(x, y, r):
            c = not c
    return c

def simplify_xy(r, tol):
    if len(r) <= 4:
        return r
    keep = [False] * len(r)
    keep[0] = keep[-1] = True
    stack = [(0, len(r) - 1)]
    while stack:
        a, b = stack.pop()
        (x1, y1), (x2, y2) = r[a], r[b]
        dx, dy = x2 - x1, y2 - y1
        L = math.hypot(dx, dy) or 1e-9
        best, bi = 0.0, -1
        for i in range(a + 1, b):
            d = abs(dy * r[i][0] - dx * r[i][1] + x2 * y1 - y2 * x1) / L
            if d > best:
                best, bi = d, i
        if best > tol and bi > 0:
            keep[bi] = True
            stack.append((a, bi)); stack.append((bi, b))
    out = [p for p, k in zip(r, keep) if k]
    return out if len(out) >= 3 else r

class Grid:
    """Point-in-polygon index over features with metre rings."""
    def __init__(self, feats, cell=150.0):
        self.f = feats; self.cell = cell; self.g = defaultdict(list)
        for i, ft in enumerate(feats):
            x1, y1, x2, y2 = ft['bb']
            for gx in range(int(math.floor(x1 / cell)), int(math.floor(x2 / cell)) + 1):
                for gy in range(int(math.floor(y1 / cell)), int(math.floor(y2 / cell)) + 1):
                    self.g[(gx, gy)].append(i)
    def find(self, x, y):
        for i in self.g.get((int(math.floor(x / self.cell)), int(math.floor(y / self.cell))), ()):
            ft = self.f[i]
            x1, y1, x2, y2 = ft['bb']
            if x1 <= x <= x2 and y1 <= y <= y2 and point_in_parts(x, y, ft['parts']):
                return i
        return None

# ------------------------------------------------------------------ shapefile

def read_dbf(path, encoding):
    data = open(path, 'rb').read()
    nrec, hlen, rlen = struct.unpack('<xxxxIHH', data[:12])
    fields = []; pos = 32
    while data[pos] != 0x0D:
        name = data[pos:pos + 11].split(b'\0', 1)[0].decode('ascii', 'replace')
        fields.append((name, chr(data[pos + 11]), data[pos + 16]))
        pos += 32
    rows = []; off = hlen
    for _ in range(nrec):
        rec = data[off:off + rlen]; off += rlen
        if not rec or rec[:1] == b'*':
            rows.append(None); continue
        p = 1; row = {}
        for name, ft, fl in fields:
            s = rec[p:p + fl].decode(encoding, 'replace').strip(); p += fl
            if ft in 'NF':
                try: row[name] = float(s) if ('.' in s or 'e' in s.lower()) else int(s)
                except ValueError: row[name] = None
            else:
                row[name] = s
        rows.append(row)
    return rows

def read_shp(path):
    data = open(path, 'rb').read()
    pos = 100; shapes = []
    while pos + 8 <= len(data):
        _, clen = struct.unpack('>ii', data[pos:pos + 8])
        c = data[pos + 8:pos + 8 + clen * 2]; pos += 8 + clen * 2
        st = struct.unpack('<i', c[:4])[0] if len(c) >= 4 else 0
        if st in (5, 15, 25):
            nparts, npts = struct.unpack('<ii', c[36:44])
            parts = list(struct.unpack('<%di' % nparts, c[44:44 + 4 * nparts])) + [npts]
            base = 44 + 4 * nparts
            pts = [struct.unpack('<dd', c[base + 16 * i:base + 16 * i + 16]) for i in range(npts)]
            shapes.append([pts[parts[k]:parts[k + 1]] for k in range(nparts)])
        else:
            shapes.append([])
    return shapes

def read_shapefile(shp, loc):
    base = shp[:-4]
    dbf = next((base + e for e in ('.dbf', '.DBF') if os.path.exists(base + e)), None)
    enc = 'cp932'
    for e in ('.cpg', '.CPG'):
        if os.path.exists(base + e) and 'utf' in open(base + e, errors='ignore').read().lower():
            enc = 'utf-8'
    feats = []
    for g, a in zip(read_shp(shp), read_dbf(dbf, enc)):
        if a is None or not g:
            continue
        parts = [[loc.xy(x, y) for x, y in r] for r in g]
        xs = [p[0] for r in parts for p in r]; ys = [p[1] for r in parts for p in r]
        feats.append({'a': a, 'parts': parts, 'bb': (min(xs), min(ys), max(xs), max(ys))})
    return feats

# ------------------------------------------------------------------ e-Stat tables

def read_table(path):
    """{KEY_CODE: {'_row': {...}, label: value}}; '-' -> 0, '*'/'X' -> None."""
    raw = open(path, 'rb').read()
    if path.lower().endswith('.zip'):
        z = zipfile.ZipFile(io.BytesIO(raw))
        n = next(n for n in z.namelist() if n.lower().endswith(('.txt', '.csv')))
        raw = z.read(n)
    for enc in ('utf-8-sig', 'cp932'):
        try:
            txt = raw.decode(enc); break
        except UnicodeDecodeError:
            continue
    rows = list(csv.reader(io.StringIO(txt)))
    codes = [c.strip() for c in rows[0]]; labels = [c.strip() for c in rows[1]]
    kc = next(i for i, c in enumerate(codes) if c.upper() in ('KEY_CODE', 'KEYCODE'))
    out = {}
    for r in rows[2:]:
        if len(r) <= kc or not r[kc].strip():
            continue
        d = {'_row': {codes[i]: r[i].strip() for i in range(min(len(r), len(codes)))}}
        for i, v in enumerate(r):
            if i == kc or i >= len(codes) or not codes[i].upper().startswith('T'):
                continue
            lab = labels[i] if i < len(labels) and labels[i] else codes[i]
            v = v.strip()
            if v == '-':
                val = 0
            elif v in ('', '*', 'X', 'x', '…', '...', '***'):
                val = None
            else:
                try: val = float(v) if '.' in v else int(v)
                except ValueError: val = None
            d[lab] = val
        out[r[kc].strip()] = d
    return out, [l for l, c in zip(labels, codes) if c.upper().startswith('T')]

def norm(s):
    return s.translate(str.maketrans('０１２３４５６７８９（）～　', '0123456789()~ ')).replace(' ', '')

def find_label(labels, *patterns):
    """First label matching one of the regexes (after width normalisation)."""
    for p in patterns:
        for l in labels:
            if re.search(p, norm(l)):
                return l
    return None

# ------------------------------------------------------------------ allocation

def largest_remainder(total, weights):
    s = sum(weights)
    if total <= 0 or s <= 0:
        return [0] * len(weights)
    raw = [total * w / s for w in weights]
    base = [int(math.floor(x)) for x in raw]
    left = int(round(total - sum(base)))
    for i in sorted(range(len(raw)), key=lambda i: raw[i] - base[i], reverse=True)[:left]:
        base[i] += 1
    return base

def capped_allocation(total, weights, caps):
    alloc = [0] * len(weights)
    remain = int(total)
    active = [i for i in range(len(weights)) if caps[i] > 0 and weights[i] > 0]
    for _ in range(40):
        if remain <= 0 or not active:
            break
        part = largest_remainder(remain, [weights[i] for i in active])
        given = 0; nxt = []
        for i, a in zip(active, part):
            g = min(a, caps[i] - alloc[i]); alloc[i] += g; given += g
            if alloc[i] < caps[i]:
                nxt.append(i)
        remain -= given; active = nxt
        if given == 0:
            # rounding left nothing for anyone: give one each to the largest weights
            for i in sorted(active, key=lambda i: -weights[i])[:remain]:
                alloc[i] += 1; remain -= 1
            break
    return alloc

# ------------------------------------------------------------------ main steps

def usage_of(a):
    u = a.get('bldg:usage')
    if u is None:
        return None, 0
    u = str(u).strip()
    if u in USAGE:
        code = USAGE[u][0]
        return code, CLASS_OF[code]
    for k, c in NONRES_CLASS:
        if k in u:
            return u, c
    return u, 0

def floors_of(a, height):
    s = a.get('bldg:storeysAboveGround')
    try:
        s = int(float(s))
    except (TypeError, ValueError):
        s = None
    if s is not None and 1 <= s <= 80:
        return s, True
    return max(1, int(round(height / 3.0))), False

def expected_households(b):
    """Expected dwellings in a building (before matching census totals)."""
    if not b['res']:
        return 0.0
    code = b['usage']; area = b['area']; fl = b['floors']
    fac, unit = USAGE[code][2], USAGE[code][3]
    if area < 18:          # sheds, garages
        return 0.0
    if unit is None:       # detached house: about one household, two for very large ones
        return min(2.0, max(0.7, area * fl / 140.0))
    return max(0.8, area * fl * fac / unit)

def flood_of(a):
    """Largest expected depth among L2 (想定最大規模) scenarios, else any scenario."""
    best = None
    for k, v in a.items():
        if not k.endswith('_浸水深'):
            continue
        try:
            d = float(v)
        except (TypeError, ValueError):
            continue
        prefix = k[:-len('_浸水深')]
        l2 = ('L2' in prefix) or ('想定最大' in prefix)
        dur = a.get(prefix + '_浸水継続時間')
        try:
            dur = float(dur) if dur is not None else None
        except (TypeError, ValueError):
            dur = None
        cand = (1 if l2 else 0, d, dur, prefix)
        if best is None or cand[:2] > best[:2]:
            best = cand
    if best is None or best[1] <= 0:
        return 0.0, None, None
    return best[1], best[2], best[3]

def build_grid(loc, blds, bbox_xy, cell=20.0):
    """Ground heights from building bases, and the expected flood water surface."""
    x1, y1, x2, y2 = bbox_xy
    nx = int(math.ceil((x2 - x1) / cell)) + 1; ny = int(math.ceil((y2 - y1) / cell)) + 1
    hash_ = defaultdict(list); hc = 60.0
    for b in blds:
        hash_[(int(b['cx'] // hc), int(b['cy'] // hc))].append(b)
    allz = sorted(b['z0'] for b in blds) or [0.0]
    zmed = allz[len(allz) // 2]
    ground = [[None] * nx for _ in range(ny)]
    water = [[None] * nx for _ in range(ny)]
    for j in range(ny):
        y = y1 + j * cell
        for i in range(nx):
            x = x1 + i * cell
            near = []
            for r in (1, 2, 3):
                near = []
                gx, gy = int(x // hc), int(y // hc)
                for dx in range(-r, r + 1):
                    for dy in range(-r, r + 1):
                        for b in hash_.get((gx + dx, gy + dy), ()):
                            d2 = (b['cx'] - x) ** 2 + (b['cy'] - y) ** 2
                            if d2 < (hc * r) ** 2:
                                near.append((d2, b))
                if len(near) >= 3:
                    break
            if not near:
                continue
            near.sort(key=lambda t: t[0]); near = near[:12]
            # robust IDW of base heights: drop the highest third (podiums, decks)
            zs = sorted(near, key=lambda t: t[1]['z0'])[:max(1, (len(near) * 2 + 2) // 3)]
            wsum = sum(1.0 / (d2 + 25.0) for d2, _ in zs)
            ground[j][i] = sum(b['z0'] / (d2 + 25.0) for d2, b in zs) / wsum
            close = [(d2, b) for d2, b in near if d2 < 70.0 ** 2]
            if close:
                wet = [(d2, b) for d2, b in close if b['fd'] > 0]
                if len(wet) * 2 >= len(close):
                    lv = sorted(b['z0'] + b['fd'] for _, b in wet)
                    water[j][i] = lv[len(lv) // 2]
    # fill gaps in the ground (parks, rivers) by spreading neighbours
    for _ in range(60):
        changed = False
        for j in range(ny):
            for i in range(nx):
                if ground[j][i] is None:
                    vals = [ground[jj][ii] for jj, ii in ((j - 1, i), (j + 1, i), (j, i - 1), (j, i + 1))
                            if 0 <= jj < ny and 0 <= ii < nx and ground[jj][ii] is not None]
                    if vals:
                        ground[j][i] = min(vals) - 0.05; changed = True
        if not changed:
            break
    for j in range(ny):
        for i in range(nx):
            if ground[j][i] is None:
                ground[j][i] = zmed
    # water spreads over empty ground that is lower than the neighbouring water
    occupied = set((int((b['cx'] - x1) // cell), int((b['cy'] - y1) // cell)) for b in blds)
    for _ in range(80):
        changed = False
        for j in range(ny):
            for i in range(nx):
                if water[j][i] is not None or (i, j) in occupied:
                    continue
                vals = [water[jj][ii] for jj, ii in ((j - 1, i), (j + 1, i), (j, i - 1), (j, i + 1))
                        if 0 <= jj < ny and 0 <= ii < nx and water[jj][ii] is not None]
                if vals and max(vals) > ground[j][i] + 0.1:
                    water[j][i] = max(vals); changed = True
        if not changed:
            break
    # light smoothing of the ground
    g2 = [row[:] for row in ground]
    for j in range(1, ny - 1):
        for i in range(1, nx - 1):
            g2[j][i] = (ground[j][i] * 4 + ground[j - 1][i] + ground[j + 1][i] + ground[j][i - 1] + ground[j][i + 1]) / 8.0
    return {'x1': x1, 'y1': y1, 'cell': cell, 'nx': nx, 'ny': ny, 'ground': g2, 'water': water}

def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--buildings', required=True)
    ap.add_argument('--blocks', required=True)
    ap.add_argument('--areas', required=True)
    ap.add_argument('--t083', required=True)
    ap.add_argument('--t084', required=True)
    ap.add_argument('--t082', required=True)
    ap.add_argument('--ward-elderly-single', type=int, required=True)
    ap.add_argument('--city', default='13119')
    ap.add_argument('--city-name', default='板橋区')
    ap.add_argument('--bbox', required=True)
    ap.add_argument('--name', default='')
    ap.add_argument('--geoid', type=float, default=GEOID_DEFAULT)
    ap.add_argument('--out', required=True)
    a = ap.parse_args()

    bb = [float(v) for v in a.bbox.split(',')]
    loc = Local((bb[0] + bb[2]) / 2, (bb[1] + bb[3]) / 2)
    bx1, by1 = loc.xy(bb[0], bb[1]); bx2, by2 = loc.xy(bb[2], bb[3])

    src = json.load(open(a.buildings, encoding='utf-8'))
    raw = src['buildings']
    print('buildings in file:', len(raw), file=sys.stderr)

    # ---- buildings
    blds = []
    stats = defaultdict(int)
    for r in raw:
        at = r.get('a') or {}
        cc = str(at.get('city_code') or '')
        if cc and a.city and cc != a.city:
            stats['other_city'] += 1; continue
        ring = [loc.xy(p[0], p[1]) for p in r['ring']]
        if len(ring) > 3 and ring[0] == ring[-1]:
            ring = ring[:-1]
        if len(ring) < 3:
            stats['bad_ring'] += 1; continue
        ar = area_xy(ring)
        if ar < 0:
            ring.reverse(); ar = -ar
        cx, cy = centroid_xy(ring)
        if not (bx1 <= cx <= bx2 and by1 <= cy <= by2):
            stats['outside'] += 1; continue
        z0 = float(r['z0']); z1 = float(r['z1'])
        hgt = z1 - z0
        try:
            mh = float(at.get('bldg:measuredHeight'))
        except (TypeError, ValueError):
            mh = None
        if hgt <= 0.5 and mh and mh > 0:
            hgt = mh
        hgt = max(hgt, 2.0)
        code, cls = usage_of(at)
        fl, fl_known = floors_of(at, hgt)
        fd, fdur, fsc = flood_of(at)
        b = {'id': r['id'], 'ring': ring, 'area': ar, 'cx': cx, 'cy': cy,
             'z0': z0 - a.geoid, 'h': hgt, 'usage': code, 'cls': cls,
             'res': code in USAGE and USAGE[code][0] == code, 'floors': fl, 'fl_known': fl_known,
             'fd': fd, 'fdur': fdur, 'fsc': fsc,
             'cho_attr': str(at.get('13+区市町村コード+大字・町コード+町・丁目コード') or '')}
        b['exp'] = expected_households(b)
        blds.append(b)
        stats['kept'] += 1
        stats['res'] += 1 if b['res'] else 0
    print('buildings in view:', len(blds), dict(stats), file=sys.stderr)

    # ---- census geography
    blocks = read_shapefile(a.blocks, loc)
    areas = read_shapefile(a.areas, loc)
    areas = [f for f in areas if not a.city or str(f['a'].get('KEY_CODE', ''))[:5] == a.city]
    blocks = [f for f in blocks if f['bb'][2] >= bx1 - 500 and f['bb'][0] <= bx2 + 500
              and f['bb'][3] >= by1 - 500 and f['bb'][1] <= by2 + 500]
    gblk = Grid(blocks); gare = Grid(areas)
    for b in blds:
        b['blk'] = gblk.find(b['cx'], b['cy'])
        b['are'] = gare.find(b['cx'], b['cy'])
        if b['blk'] is None:   # centroid on a block edge or in a road: try the ring points
            for p in b['ring']:
                b['blk'] = gblk.find(p[0], p[1])
                if b['blk'] is not None:
                    break
        if b['are'] is None:
            for p in b['ring']:
                b['are'] = gare.find(p[0], p[1])
                if b['are'] is not None:
                    break
    agree = sum(1 for b in blds if b['are'] is not None and b['cho_attr'] == str(areas[b['are']]['a'].get('KEY_CODE')))
    with_attr = sum(1 for b in blds if b['cho_attr'])
    print('cho-chome code agreement: %d / %d' % (agree, with_attr), file=sys.stderr)

    # ---- step 1-2: block households -> buildings
    by_blk = defaultdict(list)
    for b in blds:
        b['hh'] = 0; b['guess'] = False
        if b['blk'] is not None:
            by_blk[b['blk']].append(b)
    blk_unplaced = 0; blk_guess = 0
    for k, f in enumerate(blocks):
        setai = f['a'].get('SETAI') or 0
        if not isinstance(setai, (int, float)):
            setai = 0
        bs = by_blk.get(k, [])
        cand = [b for b in bs if b['exp'] > 0]
        if setai > 0 and not cand:
            cand = [b for b in bs if b['area'] >= 30 and b['cls'] not in (9,)]
            for b in cand:
                b['exp'] = b['area'] * b['floors'] / 300.0; b['guess'] = True
            if cand:
                blk_guess += 1
        if setai > 0 and not cand:
            blk_unplaced += int(setai); continue
        for b, n in zip(cand, largest_remainder(int(setai), [b['exp'] for b in cand])):
            b['hh'] = n

    # ---- census tables
    t083, l083 = read_table(a.t083)
    t084, l084 = read_table(a.t084)
    t082, l082 = read_table(a.t082)
    L_gen = find_label(l084, r'^一般世帯総数$', r'^一般世帯数$', r'一般世帯') or find_label(l083, r'一般世帯')
    L_single = find_label(l084, r'^単独世帯$', r'単独世帯')
    L_single83 = find_label(l083, r'1人$', r'1人世帯', r'世帯人員が1人')
    L_h65 = find_label(l084, r'65歳以上世帯員のいる', r'65歳以上の世帯員のいる')
    L_pop = find_label(l082, r'^総数$', r'^総数総数$', r'^人口総数$')
    L_p65 = find_label(l082, r'^総数65歳以上$', r'65歳以上$', r'65歳以上')
    labels_used = {'general': L_gen, 'single': L_single or L_single83, 'h65': L_h65, 'pop': L_pop, 'p65': L_p65}
    print('labels:', labels_used, file=sys.stderr)

    def val(t, key, lab):
        if lab is None:
            return None
        d = t.get(key)
        return None if d is None else d.get(lab)

    # small areas: merge hidden ones into the area that carries their numbers
    akeys = [str(f['a'].get('KEY_CODE')) for f in areas]
    group = {}
    for key in akeys:
        d = t084.get(key) or t083.get(key)
        tgt = key
        if d is not None and val(t084, key, L_gen) is None:
            to = (d['_row'].get('HTKSAKI') or '').strip()
            if to:
                tgt = to if len(to) >= 11 else key[:5] + to
                warn('area %s is hidden in the tables; pooled with %s' % (key, tgt))
        group[key] = tgt
    cen = {}
    for key in set(group.values()):
        g = val(t084, key, L_gen) or val(t083, key, L_gen)
        s = val(t084, key, L_single) if L_single else None
        if s is None:
            s = val(t083, key, L_single83)
        cen[key] = {'general': g, 'single': s, 'h65': val(t084, key, L_h65),
                    'pop': val(t082, key, L_pop), 'p65': val(t082, key, L_p65)}

    # ---- step 3: singles per small-area group -> buildings
    by_grp = defaultdict(list)
    for b in blds:
        b['s'] = 0; b['e'] = 0
        if b['are'] is not None:
            by_grp[group[akeys[b['are']]]].append(b)
    setai_grp = defaultdict(int)
    for f in areas:
        k = group[str(f['a'].get('KEY_CODE'))]
        v = f['a'].get('SETAI')
        setai_grp[k] += v if isinstance(v, (int, float)) else 0
    def single_weight(b):
        if b['hh'] <= 0:
            return 0.0
        code = b['usage'] if b['res'] else None
        k = {'412': 1.6, '414': 1.45, '413': 0.6, '415': 0.55, '411': 0.45}.get(code, 0.9)
        if code in ('412', '414'):
            per = b['area'] * b['floors'] * USAGE[code][2] / max(1, b['hh'])
            k *= min(1.8, max(0.6, 55.0 / max(per, 15.0)))
        return b['hh'] * k
    for key, bs in by_grp.items():
        c = cen.get(key, {})
        tot = setai_grp.get(key) or c.get('general') or 0
        hh_in = sum(b['hh'] for b in bs)
        if c.get('single') is None or not tot:
            warn('no single-household count for %s' % key); continue
        target = min(hh_in, int(round(c['single'] * hh_in / tot)))
        for b, n in zip(bs, capped_allocation(target, [single_weight(b) for b in bs], [b['hh'] for b in bs])):
            b['s'] = n

    # ---- step 4: elderly singles. ward total -> areas -> buildings
    W = {}
    for key, c in cen.items():
        if c.get('single') and c.get('pop') and c.get('p65') is not None:
            W[key] = c['single'] * c['p65'] / c['pop']
    caps = {k: min(cen[k]['single'], cen[k]['h65'] if cen[k].get('h65') is not None else cen[k]['single']) for k in W}
    keys = sorted(W)
    E_area = dict(zip(keys, capped_allocation(a.ward_elderly_single, [W[k] for k in keys], [int(caps[k]) for k in keys])))
    for key, bs in by_grp.items():
        c = cen.get(key, {})
        tot = setai_grp.get(key) or c.get('general') or 0
        if key not in E_area or not tot:
            continue
        hh_in = sum(b['hh'] for b in bs)
        target = min(sum(b['s'] for b in bs), int(round(E_area[key] * hh_in / tot)))
        ws = [b['s'] * (1.15 if b['usage'] in ('411', '413', '415') else 1.0) for b in bs]
        for b, n in zip(bs, capped_allocation(target, ws, [b['s'] for b in bs])):
            b['e'] = n

    # ---- step 5: flood floors
    for b in blds:
        b['ffl'] = 0; b['fhh'] = 0
        if b['fd'] > 0 and b['hh'] > 0:
            fh = min(3.6, max(2.6, b['h'] / b['floors']))
            n = sum(1 for k in range(b['floors']) if 0.5 + k * fh < b['fd'])
            b['ffl'] = n
            b['fhh'] = int(round(b['hh'] * n / b['floors']))
        elif b['fd'] > 0:
            fh = min(3.6, max(2.6, b['h'] / b['floors']))
            b['ffl'] = sum(1 for k in range(b['floors']) if 0.5 + k * fh < b['fd'])

    # ---- validation: share small-area totals without block numbers, compare with blocks
    def crossval(weight):
        pred = defaultdict(float); obs = defaultdict(float)
        for key, bs in by_grp.items():
            tot = sum(b['hh'] for b in bs)
            ws = [weight(b) for b in bs]
            s = sum(ws)
            if s <= 0:
                continue
            for b, w in zip(bs, ws):
                if b['blk'] is not None:
                    pred[b['blk']] += tot * w / s
        for k, f in enumerate(blocks):
            v = f['a'].get('SETAI') or 0
            if isinstance(v, (int, float)) and any(True for _ in by_blk.get(k, [])):
                obs[k] = v
        ks = [k for k in obs if obs[k] >= 20]
        if not ks:
            return None
        ape = sorted(abs(pred[k] - obs[k]) / obs[k] for k in ks)
        mo = sum(obs[k] for k in ks) / len(ks)
        ss_res = sum((pred[k] - obs[k]) ** 2 for k in ks); ss_tot = sum((obs[k] - mo) ** 2 for k in ks)
        return {'blocks': len(ks), 'median_ape': round(ape[len(ape) // 2], 3),
                'within_25pct': round(sum(1 for e in ape if e <= 0.25) / len(ape), 3),
                'r2': round(1 - ss_res / ss_tot, 3) if ss_tot > 0 else None}
    validation = {
        'method': crossval(lambda b: b['exp'] if not b['guess'] else 0.0),
        'footprint_only': crossval(lambda b: b['area'] if b['res'] else 0.0),
        'floor_area_only': crossval(lambda b: b['area'] * b['floors'] if b['res'] else 0.0),
    }
    print('validation:', validation, file=sys.stderr)

    # ---- privacy: type counts of small buildings are only kept per block
    blk_small = defaultdict(lambda: [0, 0, 0])
    for b in blds:
        if 0 < b['hh'] < SMALL_BUILDING and b['blk'] is not None:
            t = blk_small[b['blk']]
            t[0] += b['hh']; t[1] += b['s']; t[2] += b['e']

    # ---- grid
    grid = build_grid(loc, blds, (bx1, by1, bx2, by2))

    # ---- pack
    os.makedirs(a.out, exist_ok=True)
    blds.sort(key=lambda b: (b['blk'] if b['blk'] is not None else 1 << 30, b['cy'], b['cx']))
    used_blocks = sorted(set(b['blk'] for b in blds if b['blk'] is not None))
    bindex = {k: i for i, k in enumerate(used_blocks)}
    used_areas = sorted(set(b['are'] for b in blds if b['are'] is not None))
    aindex = {k: i for i, k in enumerate(used_areas)}
    ring_start = [0]; ring_xy = []
    for b in blds:
        r = simplify_xy(b['ring'], 0.25)
        for x, y in r:
            ring_xy.append(int(round(x * 100))); ring_xy.append(int(round(y * 100)))
        ring_start.append(len(ring_xy) // 2)
    N = len(blds)
    arrays = [
        ('ringStart', 'I', ring_start),
        ('ringXY', 'i', ring_xy),                       # centimetres from origin (east, north)
        ('base', 'f', [b['z0'] for b in blds]),           # orthometric metres (approx.)
        ('height', 'f', [b['h'] for b in blds]),
        ('floors', 'B', [min(255, b['floors']) for b in blds]),
        ('cls', 'B', [b['cls'] for b in blds]),
        ('hh', 'H', [min(65535, b['hh']) for b in blds]),
        ('single', 'H', [b['s'] if b['hh'] >= SMALL_BUILDING else 65535 for b in blds]),
        ('elderly', 'H', [b['e'] if b['hh'] >= SMALL_BUILDING else 65535 for b in blds]),
        ('block', 'H', [bindex.get(b['blk'], 65535) for b in blds]),
        ('area', 'H', [aindex.get(b['are'], 65535) for b in blds]),
        ('floodDepth', 'H', [int(round(b['fd'] * 100)) for b in blds]),   # cm
        ('floodHours', 'H', [int(round(b['fdur'])) if b['fdur'] else 0 for b in blds]),
        ('floodFloors', 'B', [min(255, b['ffl']) for b in blds]),
        ('floodHH', 'H', [min(65535, b['fhh']) for b in blds]),
        ('ground', 'h', [int(round(v * 10)) for row in grid['ground'] for v in row]),       # dm
        ('water', 'h', [int(round(v * 10)) if v is not None else -32768 for row in grid['water'] for v in row]),
    ]
    layout = {}; blob = bytearray()
    for name, t, vals in arrays:
        while len(blob) % 4:
            blob.append(0)
        layout[name] = {'type': t, 'offset': len(blob), 'length': len(vals)}
        blob += struct.pack('<%d%s' % (len(vals), t), *vals)
    open(os.path.join(a.out, 'area.bin'), 'wb').write(bytes(blob))

    blk_out = []
    for k in used_blocks:
        f = blocks[k]
        ring = max(f['parts'], key=lambda r: abs(area_xy(r)))
        ring = simplify_xy(ring, 1.0)
        sm = blk_small.get(k, [0, 0, 0])
        bs = by_blk.get(k, [])
        blk_out.append({
            'hh': f['a'].get('SETAI'), 'pop': f['a'].get('JINKO'),
            's': sum(b['s'] for b in bs), 'e': sum(b['e'] for b in bs),
            'small': sm,
            'ring': [[int(round(x)), int(round(y))] for x, y in ring],
        })
    area_out = []
    for k in used_areas:
        f = areas[k]; key = str(f['a'].get('KEY_CODE'))
        c = cen.get(group[key], {})
        bs = [b for b in blds if b['are'] == k]
        ring = simplify_xy(max(f['parts'], key=lambda r: abs(area_xy(r))), 3.0)
        cx, cy = centroid_xy(ring)
        area_out.append({
            'key': key, 'name': f['a'].get('S_NAME') or '', 'pooledWith': group[key] if group[key] != key else None,
            'census': {'households': f['a'].get('SETAI'), 'pop': f['a'].get('JINKO'),
                       'general': c.get('general'), 'single': c.get('single'), 'h65': c.get('h65'),
                       'p65': c.get('p65'), 'popT': c.get('pop'), 'elderlySingleEst': E_area.get(group[key])},
            'view': {'hh': sum(b['hh'] for b in bs), 's': sum(b['s'] for b in bs), 'e': sum(b['e'] for b in bs),
                     'floodHH': sum(b['fhh'] for b in bs), 'floodBuildings': sum(1 for b in bs if b['fd'] > 0 and b['hh'] > 0),
                     'floodE': sum(int(round(b['e'] * b['fhh'] / b['hh'])) for b in bs if b['hh'] > 0 and b['fhh'] > 0),
                     'allFloors': sum(b['hh'] for b in bs if b['hh'] > 0 and b['ffl'] >= b['floors']),
                     'longHH': sum(b['hh'] for b in bs if b['fdur'] and b['fdur'] >= 72 and b['fd'] >= 0.5)},
            'c': [int(round(cx)), int(round(cy))],
            'ring': [[int(round(x)), int(round(y))] for x, y in ring],
        })
    scen = defaultdict(int)
    for b in blds:
        if b['fsc']:
            scen[b['fsc']] += 1
    totals = {
        'buildings': N, 'residential': sum(1 for b in blds if b['hh'] > 0),
        'households': sum(b['hh'] for b in blds), 'single': sum(b['s'] for b in blds),
        'elderly': sum(b['e'] for b in blds), 'floodHH': sum(b['fhh'] for b in blds),
        'floodBuildings': sum(1 for b in blds if b['fd'] > 0),
        'allFloorsHH': sum(b['hh'] for b in blds if b['hh'] > 0 and b['fd'] > 0 and b['ffl'] >= b['floors']),
        'longHH': sum(b['hh'] for b in blds if b['fdur'] and b['fdur'] >= 72 and b['fd'] >= 0.5),
        'floodE': sum(int(round(b['e'] * b['fhh'] / b['hh'])) for b in blds if b['hh'] > 0 and b['fhh'] > 0),
        'unplacedHouseholds': blk_unplaced, 'blocksGuessed': blk_guess,
    }
    meta = {
        'name': a.name, 'city': a.city, 'cityName': a.city_name,
        'origin': [loc.lon0, loc.lat0], 'kx': loc.kx, 'ky': loc.ky, 'geoid': a.geoid,
        'bbox': bb, 'smallBuilding': SMALL_BUILDING,
        'usageClass': USAGE_CLASS,
        'grid': {k: grid[k] for k in ('x1', 'y1', 'cell', 'nx', 'ny')},
        'layout': layout, 'totals': totals, 'validation': validation,
        'wardElderlySingle': a.ward_elderly_single,
        'floodScenarios': dict(sorted(scen.items(), key=lambda t: -t[1])[:12]),
        'labels': labels_used,
        'sources': [
            '3D都市モデル（Project PLATEAU）板橋区（2025年度）（国土交通省）を加工して作成',
            '「令和2年国勢調査」小地域集計・境界データ（総務省統計局、e-Stat）を加工して作成',
        ],
        'note': '建物ごとの世帯数・世帯類型は、国勢調査の集計値を建物の用途・階数・面積で按分した推計値です。実際の居住状況を示すものではありません。',
    }
    json.dump({'meta': meta, 'blocks': blk_out, 'areas': area_out},
              open(os.path.join(a.out, 'area.json'), 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))
    rep = {'stats': dict(stats), 'totals': totals, 'validation': validation, 'labels': labels_used,
           'choAgreement': [agree, with_attr], 'warnings': warnings,
           'censusTotalsInView': {'blocksSETAI': sum((blocks[k]['a'].get('SETAI') or 0) for k in used_blocks)}}
    json.dump(rep, open(os.path.join(a.out, 'report.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    print(json.dumps(totals, ensure_ascii=False), file=sys.stderr)
    print('bin %.1f MB, json %.1f MB' % (len(blob) / 1e6, os.path.getsize(os.path.join(a.out, 'area.json')) / 1e6), file=sys.stderr)

if __name__ == '__main__':
    main()
