#!/usr/bin/env python3
r"""まどあかり: estimate households per building and pack the data for the web app.

Standard library only (Python 3.8+, Windows or Linux).

  python tools/estimate.py --buildings takashimadaira_buildings.json \
      --blocks r2kb13119.shp --areas r2ka13119.shp \
      --t083 tblT001083C13.zip --t084 tblT001084C13.zip --t082 tblT001082C13.zip \
      --ward-elderly-single 37998 --city 13119 --city-name 板橋区 \
      --extent 139.630,35.775,139.680,35.800 --bbox 139.6335,35.7777,139.6765,35.7973 \
      --name 高島平とその周辺 --out data

Inputs
  buildings  output of extract_b3dm.js (PLATEAU 3D Tiles -> footprints + attributes)
  blocks     e-Stat 2020 census basic unit blocks r2kb13119.shp (基本単位区, SETAI/JINKO),
             or a zip that holds r2kb13119.shp/.shx/.dbf
  areas      e-Stat 2020 census small areas r2ka13119.shp (小地域), or a zip that holds it
  t083/t084/t082  e-Stat small area tables as downloaded: tblT001083C13.zip (世帯人員),
             tblT001084C13.zip (世帯の家族類型), tblT001082C13.zip (年齢別人口)
  --extent   where the buildings file is complete (the extractor's bbox). Default:
             report.bbox of the buildings file, else the box around all building centroids
  --bbox     the view: only buildings whose centroid is inside it are packed and drawn
  --name     name of the view, shown in the app (e.g. 高島平とその周辺)
Output (--out): area.json, area.bin (for the app) and report.json (aggregates only).
MADOAKARI_DEBUG_DUMP=<path> also writes internal values there (for tests; never into --out).

Method (details in docs/method.md)
  1. Each building gets an expected number of dwellings from its use, floors and footprint.
  2. Census households of each basic unit block are shared out in that proportion. A block
     cut by the extent edge keeps the share of its area inside the extent. A block with no
     residential building centred in it gives them to residential buildings reaching into it.
  3. Single-person households of each small area are shared out with weights by building
     type and dwelling size (water-filling under caps, then cumulative rounding).
  4. Elderly single households: ward total -> small areas -> buildings, the same way.
  5. Flood: deepest L2 depth; floors whose floor level is under it are flooded, and
     households are placed one per floor from the lowest floor up.
  6. One light per household. Buildings under 10 households never show their own
     types: those come from pools of at least 3 buildings and 10 households.
All per-building numbers are estimates.  Only area totals are census figures.
"""
import argparse, csv, io, json, math, os, re, struct, sys, tempfile, zipfile
from collections import Counter, defaultdict

GEOID_DEFAULT = 36.7          # m, geoid height around Itabashi (ellipsoid - orthometric)
SMALL_BUILDING = 10           # below this many households, types come from pools only
POOL_MIN_HH, POOL_MIN_BLD = 10, 3   # a pool needs this many households and buildings
FULL = 0.999                  # a block with this share inside counts as whole
GRID_PAD = 80.0               # m, ground/water grid margin around the view
REACH_SHARE, REACH_M2 = 0.05, 50.0  # a building reaches into a block with this much of its footprint

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
SOURCES = ['「3D都市モデル（Project PLATEAU）{city}（{year}年度）」（国土交通省）を加工して作成',
           '「令和2年国勢調査」（総務省統計局）を加工して作成',
           '出典：政府統計の総合窓口(e-Stat)（https://www.e-stat.go.jp/）']
RANGE = {'B': (0, 255), 'H': (0, 65535), 'h': (-32768, 32767), 'w': (-32767, 32767),
         'i': (-2 ** 31, 2 ** 31 - 1), 'I': (0, 2 ** 32 - 1)}

warnings = []
def warn(msg):
    if len(warnings) < 300:
        warnings.append(msg)

def read_bytes(path):
    with open(path, 'rb') as f:
        return f.read()

def write_json(path, obj, **kw):
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(obj, f, ensure_ascii=False, **kw)

def num(v):
    """float(v) if v is a finite number (or a numeric string), else None."""
    if isinstance(v, bool):
        return None
    try:
        x = float(v)
    except (TypeError, ValueError):
        return None
    return x if math.isfinite(x) else None

def cint(v):
    """A census count as published: int, or None when the field holds no number."""
    x = num(v)
    return None if x is None else int(round(x))

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

def clip_rect(r, x1, y1, x2, y2):
    """Sutherland-Hodgman clip of a ring to a rectangle (orientation is kept)."""
    for ax, c, lo in ((0, x1, True), (0, x2, False), (1, y1, True), (1, y2, False)):
        if not r:
            break
        out = []
        for i in range(len(r)):
            p, q = r[i - 1], r[i]
            pin = p[ax] >= c if lo else p[ax] <= c
            qin = q[ax] >= c if lo else q[ax] <= c
            if pin != qin:
                t = (c - p[ax]) / (q[ax] - p[ax])
                out.append((c, p[1] + t * (q[1] - p[1])) if ax == 0 else (p[0] + t * (q[0] - p[0]), c))
            if qin:
                out.append(q)
        r = out
    return r

def rect_share(ft, rect):
    """Share of a feature's net area (|sum of signed ring areas| per record) inside rect."""
    x1, y1, x2, y2 = rect
    bx1, by1, bx2, by2 = ft['bb']
    if bx1 >= x1 and by1 >= y1 and bx2 <= x2 and by2 <= y2:
        return 1.0
    if bx2 <= x1 or bx1 >= x2 or by2 <= y1 or by1 >= y2 or ft['net'] <= 0:
        return 0.0
    inside = sum(abs(sum(area_xy(clip_rect(r, x1, y1, x2, y2)) for r in g)) for g in ft['groups'])
    return min(1.0, inside / ft['net'])

def ring_samples(r, n=64):
    """About n grid points inside ring r (for shares of a footprint)."""
    xs = [p[0] for p in r]; ys = [p[1] for p in r]
    st = max(0.25, math.sqrt(abs(area_xy(r)) / n))
    out = []
    for i in range(int((max(xs) - min(xs)) / st) + 1):
        for j in range(int((max(ys) - min(ys)) / st) + 1):
            x, y = min(xs) + (i + 0.5) * st, min(ys) + (j + 0.5) * st
            if point_in_ring(x, y, r):
                out.append((x, y))
    return out

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
            if x1 <= x <= x2 and y1 <= y <= y2 and any(point_in_parts(x, y, g) for g in ft['groups']):
                return i
        return None

# ------------------------------------------------------------------ shapefile

def read_dbf(path, encoding):
    data = read_bytes(path)
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
    data = read_bytes(path)
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

def read_shapefile(path, loc, what):
    """Polygon features of a .shp (or of a .zip holding .shp/.shx/.dbf), one per KEY_CODE.
    Returns (features, number of KEY_CODEs that had several records)."""
    if not os.path.isfile(path):
        sys.exit('%s: no such file: %s' % (what, path))
    if path.lower().endswith('.zip'):
        with zipfile.ZipFile(path) as z, tempfile.TemporaryDirectory() as tmp:
            names = [n for n in z.namelist() if not n.endswith('/')]
            shps = [n for n in names if n.lower().endswith('.shp')]
            zbase = os.path.splitext(os.path.basename(path))[0].lower()
            if not shps:
                sys.exit('%s: %s holds no .shp file' % (what, path))
            if len(shps) > 1:
                same = [n for n in shps if os.path.basename(n)[:-4].lower() == zbase]
                if len(same) != 1:
                    sys.exit('%s: %s holds several .shp files (%s) and none is named %s.shp; '
                             'unzip it and pass the .shp to use' % (what, path, ', '.join(shps), zbase))
                shps = same
            stem = shps[0][:-4]
            for n in names:
                ext = n[len(stem):].lower()
                if n[:len(stem)].lower() == stem.lower() and ext in ('.shp', '.shx', '.dbf', '.cpg'):
                    with open(os.path.join(tmp, 'x' + ext), 'wb') as f:
                        f.write(z.read(n))
            if not os.path.exists(os.path.join(tmp, 'x.dbf')):
                sys.exit('%s: %s has no %s.dbf next to %s' % (what, path, os.path.basename(stem), shps[0]))
            return read_shapefile(os.path.join(tmp, 'x.shp'), loc, what)
    base = path[:-4]
    dbf = next((base + e for e in ('.dbf', '.DBF') if os.path.exists(base + e)), None)
    if dbf is None:
        sys.exit('%s: %s has no .dbf next to it (the .shp, .shx and .dbf must be together)' % (what, path))
    enc = 'cp932'
    for e in ('.cpg', '.CPG'):
        if os.path.exists(base + e) and b'utf' in read_bytes(base + e).lower():
            enc = 'utf-8'
    recs = []
    for g, at in zip(read_shp(path), read_dbf(dbf, enc)):
        if at is None or not g:
            continue
        recs.append((at, [[loc.xy(x, y) for x, y in r] for r in g]))
    return merge_records(recs, what)

def merge_records(recs, what):
    """Records sharing a KEY_CODE become one feature: parts joined, attributes from the
    largest record, SETAI/JINKO taken once if all equal, else summed."""
    order = []; by = {}
    for at, parts in recs:
        k = str(at.get('KEY_CODE') or '').strip()
        if not k:
            order.append([(at, parts)]); continue
        if k not in by:
            by[k] = []; order.append(by[k])
        by[k].append((at, parts))
    feats = []; ndup = 0
    for grp in order:
        nets = [abs(sum(area_xy(r) for r in parts)) for _, parts in grp]
        at = dict(grp[max(range(len(grp)), key=lambda i: nets[i])][0])
        if len(grp) > 1:
            ndup += 1; how = []
            for fld in ('SETAI', 'JINKO'):
                vs = [v for v in (num(g[0].get(fld)) for g in grp) if v is not None]
                if vs:
                    v = vs[0] if all(x == vs[0] for x in vs) else sum(vs)
                    at[fld] = int(v) if v == int(v) else v
                    how.append('%s %s (%s)' % (fld, at[fld], 'repeated, taken once' if len(set(vs)) == 1 else 'summed'))
            msg = '%s: merged %d records of KEY_CODE %s: %s' % (what, len(grp), at.get('KEY_CODE'), ', '.join(how) or 'no SETAI/JINKO')
            if ndup <= 20:
                print(msg, file=sys.stderr)
            warn(msg)
        groups = [parts for _, parts in grp]
        xs = [p[0] for parts in groups for r in parts for p in r]; ys = [p[1] for parts in groups for r in parts for p in r]
        feats.append({'a': at, 'parts': [r for parts in groups for r in parts], 'groups': groups,
                      'bb': (min(xs), min(ys), max(xs), max(ys)), 'net': sum(nets)})
    if ndup:
        print('%s: %d KEY_CODEs had several records (%d records merged away)' % (what, ndup, len(recs) - len(feats)), file=sys.stderr)
    return feats, ndup

# ------------------------------------------------------------------ e-Stat tables

def read_table(path):
    """{KEY_CODE: {'_row': {...}, label: value}}; '-' -> 0, '*'/'X' -> None.
    A 町 without 丁目 (9-digit row only) is also found under its 11-digit boundary key (+'00')."""
    raw = read_bytes(path)
    if path.lower().endswith('.zip'):
        z = zipfile.ZipFile(io.BytesIO(raw))
        n = next((n for n in z.namelist() if n.lower().endswith(('.txt', '.csv'))), None)
        if n is None:
            sys.exit('%s holds no .txt/.csv table' % path)
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
    has_chome = {k[:9] for k in out if len(k) == 11}
    for k in [k for k in out if len(k) == 9 and k not in has_chome]:
        out.setdefault(k + '00', out[k])
    return out, [l for l, c in zip(labels, codes) if c.upper().startswith('T')]

def hidden_target(key, to):
    """Area key that carries the numbers of hidden area `key` (HTKSAKI `to`), or None."""
    to = to.strip()
    if not to.isdigit():
        return None
    if len(to) == 11:
        return to
    if len(to) == 9:
        return to + '00'
    if len(to) == 6:
        return key[:5] + to
    if len(to) == 4:
        return key[:5] + to + '00'
    return None

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
    """Integer shares under caps (used for the ward -> small area step)."""
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

def water_fill(target, weights, caps):
    """x_i = min(cap_i, lam * w_i) with sum(x) = min(target, sum of caps where w > 0)."""
    x = [0.0] * len(weights)
    act = [i for i in range(len(weights)) if weights[i] > 0 and caps[i] > 0]
    capsum = sum(caps[i] for i in act)
    if target <= 0 or not act:
        return x
    if target >= capsum:
        for i in act:
            x[i] = float(caps[i])
        return x
    act.sort(key=lambda i: (caps[i] / weights[i], i))
    wrest = [0.0] * (len(act) + 1)          # sum of the weights from position j on
    for j in range(len(act) - 1, -1, -1):
        wrest[j] = wrest[j + 1] + weights[act[j]]
    sat = 0                                  # caps of the buildings already full
    for j, i in enumerate(act):
        if sat + caps[i] / weights[i] * wrest[j] >= target:
            break
        sat += caps[i]
    else:
        return [float(caps[i]) if i in set(act) else 0.0 for i in range(len(weights))]
    lam = (target - sat) / wrest[j]
    for jj, i in enumerate(act):
        x[i] = float(caps[i]) if jj < j else min(float(caps[i]), lam * weights[i])
    return x

def frac_round(x):
    """Cumulative rounding in a fixed pseudo-random order (in units of 1e-9 to stay exact):
    each value becomes its floor or ceiling and the total is kept."""
    out = [0] * len(x); acc = 0; prev = 0
    for i in sorted(range(len(x)), key=lambda i: (i * 2654435761) % 4294967296):
        acc += int(round(x[i] * 1e9))
        cur = (acc + 500000000) // 1000000000
        out[i] = cur - prev; prev = cur
    return out

def frac_allocation(target, weights, caps):
    """Water-filled shares under caps and their rounding: (fractions, integers)."""
    x = water_fill(target, weights, caps)
    out = frac_round(x)
    assert all(0 <= o <= c for o, c in zip(out, caps)) and sum(out) == int(round(sum(x))), 'allocation broke a cap'
    return x, out

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
    return max(1, min(255, int(round(height / 3.0)))), False

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

def flood_of(a, stats=None):
    """(depth m, duration h or None, scenario) from the PLATEAU flood attributes.
    Depth: deepest valid L2 (想定最大規模) scenario, else the deepest other one.
    Duration: longest valid duration among the flooded scenarios of that level; for L2,
    if none has one, the longest of the flooded L1 scenarios."""
    sc = {}; bad = 0
    for k, v in a.items():
        if not k.endswith('_浸水深'):
            continue
        p = k[:-len('_浸水深')]
        d = num(v)
        if d is None or not 0 < d < 50:
            if d != 0:      # 0 means dry, not a bad value
                bad += 1
            d = None
        dur = None
        if p + '_浸水継続時間' in a:
            dur = num(a[p + '_浸水継続時間'])
            if dur is None or not 0 <= dur < 65535:
                bad += 1; dur = None
        sc[p] = (d, dur, 'L2' in p or '想定最大' in p)
    l2 = {p: t for p, t in sc.items() if t[2] and t[0] is not None}
    other = {p: t for p, t in sc.items() if not t[2] and t[0] is not None}
    if stats is not None:
        stats['floodInvalid'] += bad
    use = l2 or other
    if not use:
        return 0.0, None, None
    if not l2 and stats is not None:
        stats['floodL1Fallback'] += 1
    depth = max(t[0] for t in use.values())
    label = min(p for p, t in use.items() if t[0] == depth)
    durs = [t[1] for t in use.values() if t[1] is not None]
    if not durs and l2:
        durs = [t[1] for t in other.values() if t[1] is not None]
    return depth, (max(durs) if durs else None), label

def build_grid(loc, blds, rect, cell=20.0):
    """Ground heights from building bases, and the expected flood water surface."""
    x1, y1, x2, y2 = rect
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

# ------------------------------------------------------------------ lights

def rng(seed):
    """Port of rng() in js/app.js (mulberry32)."""
    a = [seed & 0xFFFFFFFF]
    def r():
        a[0] = (a[0] + 0x6D2B79F5) & 0xFFFFFFFF
        t = a[0]
        t = ((t ^ (t >> 15)) * (t | 1)) & 0xFFFFFFFF
        t ^= (t + (((t ^ (t >> 7)) * (t | 61)) & 0xFFFFFFFF)) & 0xFFFFFFFF
        return ((t ^ (t >> 14)) & 0xFFFFFFFF) / 4294967296.0
    return r

def shuffle(arr, R):
    """Fisher-Yates exactly as in js/app.js."""
    for i in range(len(arr) - 1, 0, -1):
        j = int(math.floor(R() * (i + 1)))
        arr[i], arr[j] = arr[j], arr[i]
    return arr

def make_pools(packed):
    """Pools of buildings under SMALL_BUILDING households (indices in packing order):
    block, else 町丁目, else the whole view; each needs POOL_MIN_BLD buildings and
    POOL_MIN_HH households. Returns (pools, small buildings left without a pool)."""
    def ok(m):
        return len(m) >= POOL_MIN_BLD and sum(packed[i]['hh'] for i in m) >= POOL_MIN_HH
    by_blk = defaultdict(list); left = []
    for i, b in enumerate(packed):
        if 0 < b['hh'] < SMALL_BUILDING:
            (by_blk[b['blk']] if b['blk'] is not None else left).append(i)
    groups = []
    for k in sorted(by_blk):
        if ok(by_blk[k]):
            groups.append(('block', by_blk[k]))
        else:
            left += by_blk[k]
    by_area = defaultdict(list); rest = []
    for i in sorted(left):
        (by_area[packed[i]['are']] if packed[i]['are'] is not None else rest).append(i)
    for k in sorted(by_area):
        if ok(by_area[k]):
            groups.append(('area', by_area[k]))
        else:
            rest += by_area[k]
    rest.sort()
    unpooled = []
    if ok(rest):
        groups.append(('view', rest))
    else:
        unpooled = rest
    pools = [{'id': p, 'kind': kind, 'members': m, 'H': sum(packed[i]['hh'] for i in m),
              'S': sum(packed[i]['s'] for i in m), 'E': sum(packed[i]['e'] for i in m)}
             for p, (kind, m) in enumerate(groups)]
    return pools, unpooled

def deal_lights(packed, pools):
    """Type of every light (0 other, 1 single, 2 elderly single), buildings in packing order."""
    types = [None] * len(packed)
    for i, b in enumerate(packed):
        if b['hh'] >= SMALL_BUILDING:
            types[i] = shuffle([2] * b['e'] + [1] * (b['s'] - b['e']) + [0] * (b['hh'] - b['s']), rng(1000003 + i))
    for p in pools:
        lst = shuffle([2] * p['E'] + [1] * (p['S'] - p['E']) + [0] * (p['H'] - p['S']), rng(9001 + p['id']))
        pos = 0
        for i in p['members']:
            types[i] = lst[pos:pos + packed[i]['hh']]; pos += packed[i]['hh']
    out = []
    for i, b in enumerate(packed):
        out += types[i] if types[i] is not None else [0] * b['hh']
    return out

# ------------------------------------------------------------------ main

def parse_rect(s, what, ap):
    try:
        v = [float(t) for t in s.split(',')]
    except ValueError:
        v = []
    if len(v) != 4 or not all(math.isfinite(t) for t in v) or not (v[0] < v[2] and v[1] < v[3]):
        ap.error('%s must be lon1,lat1,lon2,lat2 with lon1 < lon2 and lat1 < lat2' % what)
    return v

def main():
    del warnings[:]
    try:
        sys.stderr.reconfigure(errors='backslashreplace')
    except AttributeError:
        pass
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--buildings', required=True)
    ap.add_argument('--blocks', required=True, help='r2kb13119.shp, or a zip holding it')
    ap.add_argument('--areas', required=True, help='r2ka13119.shp, or a zip holding it')
    ap.add_argument('--t083', required=True, help='tblT001083C13.zip')
    ap.add_argument('--t084', required=True, help='tblT001084C13.zip')
    ap.add_argument('--t082', required=True, help='tblT001082C13.zip')
    ap.add_argument('--ward-elderly-single', type=int, required=True, help='65歳以上の単独世帯数（区全体）')
    ap.add_argument('--city', default='13119')
    ap.add_argument('--city-name', default='板橋区')
    ap.add_argument('--plateau-year', type=int, default=2025, help='PLATEAU data year, for the source credit')
    ap.add_argument('--extent', help='lon1,lat1,lon2,lat2 where the buildings file is complete')
    ap.add_argument('--bbox', required=True, help='lon1,lat1,lon2,lat2 of the view')
    ap.add_argument('--name', required=True, help='name of the view, e.g. 高島平とその周辺')
    ap.add_argument('--geoid', type=float, default=GEOID_DEFAULT)
    ap.add_argument('--out', required=True)
    a = ap.parse_args()
    if not a.name.strip():
        ap.error('--name must not be empty')
    name = a.name.strip()
    view = parse_rect(a.bbox, '--bbox', ap)
    ext = parse_rect(a.extent, '--extent', ap) if a.extent else None

    with open(a.buildings, encoding='utf-8') as f:
        src = json.load(f)
    raw = src.get('buildings') or []
    print('buildings in file:', len(raw), file=sys.stderr)

    # ---- extent (where the file is complete) and view (what is drawn)
    ext_from = '--extent'
    if ext is None:
        rb = (src.get('report') or {}).get('bbox')
        if isinstance(rb, list) and len(rb) == 4 and all(num(v) is not None for v in rb) and rb[0] < rb[2] and rb[1] < rb[3]:
            ext = [float(v) for v in rb]; ext_from = 'report.bbox'
        else:
            l0 = Local((view[0] + view[2]) / 2, (view[1] + view[3]) / 2)
            cs = [l0.ll(*centroid_xy([l0.xy(p[0], p[1]) for p in r['ring']])) for r in raw if len(r.get('ring') or []) >= 3]
            if not cs:
                sys.exit('no buildings in %s' % a.buildings)
            ext = [min(c[0] for c in cs), min(c[1] for c in cs), max(c[0] for c in cs), max(c[1] for c in cs)]
            ext_from = 'building centroids'
    cv = [max(view[0], ext[0]), max(view[1], ext[1]), min(view[2], ext[2]), min(view[3], ext[3])]
    if cv != view:
        if not (cv[0] < cv[2] and cv[1] < cv[3]):
            sys.exit('the view %s does not overlap the extent %s' % (view, ext))
        msg = 'the view %s is not inside the extent %s; clamped to %s' % (view, ext, cv)
        print('WARNING:', msg, file=sys.stderr); warn(msg)
        view = cv
    print('extent (%s): %s  view: %s' % (ext_from, ext, view), file=sys.stderr)
    loc = Local((ext[0] + ext[2]) / 2, (ext[1] + ext[3]) / 2)     # centred on the extent: the view never changes the allocation
    EXT = loc.xy(ext[0], ext[1]) + loc.xy(ext[2], ext[3])
    VIEW = loc.xy(view[0], view[1]) + loc.xy(view[2], view[3])
    ex1, ey1, ex2, ey2 = EXT; vx1, vy1, vx2, vy2 = VIEW

    # ---- buildings
    blds = []
    stats = defaultdict(int)
    for k in ('kept', 'inview', 'res', 'outsideExtent', 'other_city', 'bad_ring', 'fpUsed', 'floodInvalid', 'floodL1Fallback'):
        stats[k] = 0
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
        if not (ex1 <= cx <= ex2 and ey1 <= cy <= ey2):
            stats['outsideExtent'] += 1; continue
        z0 = float(r['z0']); z1 = float(r['z1'])
        hgt = z1 - z0
        mh = num(at.get('bldg:measuredHeight'))
        if hgt <= 0.5 and mh and mh > 0:
            hgt = mh
        hgt = max(hgt, 2.0)
        fp = num(r.get('fp'))         # net footprint from the extractor (courtyards, several solids)
        if fp is not None and fp > 0:
            stats['fpUsed'] += 1
        else:
            fp = ar
        code, cls = usage_of(at)
        fl, fl_known = floors_of(at, hgt)
        fd, fdur, fsc = flood_of(at, stats)
        b = {'id': r.get('id'), 'ring': ring, 'area': fp, 'cx': cx, 'cy': cy,
             'inview': vx1 <= cx <= vx2 and vy1 <= cy <= vy2,
             'z0': z0 - a.geoid, 'h': hgt, 'usage': code, 'cls': cls,
             'res': code in USAGE and USAGE[code][0] == code, 'floors': fl, 'fl_known': fl_known,
             'fd': fd, 'fdur': fdur, 'fsc': fsc,
             'cho_attr': str(at.get('13+区市町村コード+大字・町コード+町・丁目コード') or ''),
             'addr': str(at.get('bldg:address') or '')}
        b['exp'] = expected_households(b)
        blds.append(b)
        stats['kept'] += 1
        stats['inview'] += 1 if b['inview'] else 0
        stats['res'] += 1 if b['res'] else 0
    print('buildings kept (in extent):', len(blds), dict(stats), file=sys.stderr)
    if not blds:
        sys.exit('no building of %s (city %s) has its centroid inside the extent %s' % (a.buildings, a.city, ext))

    # ---- census geography
    blocks, ndup_blk = read_shapefile(a.blocks, loc, 'blocks')
    areas, ndup_are = read_shapefile(a.areas, loc, 'areas')
    areas = [f for f in areas if not a.city or str(f['a'].get('KEY_CODE', ''))[:5] == a.city]
    for f in blocks:
        f['shareExt'] = rect_share(f, EXT)
    nblk = len(blocks)
    blocks = [f for f in blocks if f['shareExt'] > 1e-6]
    if not blocks or not any(rect_share(f, EXT) > 0 for f in areas):
        sys.exit('no %s of %s lies in the extent %s: is the file in longitude/latitude (世界測地系緯度経度)%s?'
                 % ('block' if not blocks else 'small area of city %s' % a.city, a.blocks if not blocks else a.areas, ext,
                    ' and is --city right' if blocks else ''))
    for f in blocks:
        f['shareView'] = rect_share(f, VIEW)
    for f in areas:
        f['coverage'] = rect_share(f, VIEW)
    print('blocks: %d in file, %d in the extent (%d cut by its edge); areas: %d'
          % (nblk, len(blocks), sum(1 for f in blocks if f['shareExt'] < FULL), len(areas)), file=sys.stderr)
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
    akeys = [str(f['a'].get('KEY_CODE')) for f in areas]
    anames = [str(f['a'].get('S_NAME') or '') for f in areas]   # PLATEAU's 町丁目 codes are not e-Stat's: also compare names
    agree = sum(1 for b in blds if b['are'] is not None and (b['cho_attr'] == akeys[b['are']] or
                                                           (anames[b['are']] and anames[b['are']] in b['addr'])))
    with_attr = sum(1 for b in blds if b['cho_attr'] or b['addr'])
    print('cho-chome agreement (code or address): %d / %d' % (agree, with_attr), file=sys.stderr)

    # ---- step 1-2: block households -> buildings (all kept buildings)
    by_blk = defaultdict(list)
    for b in blds:
        b['hh'] = 0; b['guess'] = False
        if b['blk'] is not None:
            by_blk[b['blk']].append(b)
    cells = defaultdict(list)          # residential buildings by 100 m cell of their bbox
    for i, b in enumerate(blds):
        if b['res'] and b['exp'] > 0:
            xs = [p[0] for p in b['ring']]; ys = [p[1] for p in b['ring']]
            b['bb'] = (min(xs), min(ys), max(xs), max(ys))
            for gx in range(int(b['bb'][0] // 100), int(b['bb'][2] // 100) + 1):
                for gy in range(int(b['bb'][1] // 100), int(b['bb'][3] // 100) + 1):
                    cells[(gx, gy)].append(i)
    def reaching(f):
        """Residential buildings centred elsewhere with enough of their footprint in block f, and their weights."""
        x1, y1, x2, y2 = f['bb']; seen = set(); out = []
        for gx in range(int(x1 // 100), int(x2 // 100) + 1):
            for gy in range(int(y1 // 100), int(y2 // 100) + 1):
                for i in cells.get((gx, gy), ()):
                    b = blds[i]; bb = b['bb']
                    if i in seen or bb[2] < x1 or bb[0] > x2 or bb[3] < y1 or bb[1] > y2:
                        continue
                    seen.add(i)
                    pts = b.get('smp') or b.setdefault('smp', ring_samples(b['ring']))
                    sh = sum(1 for x, y in pts if any(point_in_parts(x, y, g) for g in f['groups'])) / max(1, len(pts))
                    if sh >= REACH_SHARE and sh * b['area'] >= REACH_M2:
                        out.append((i, sh))
        out.sort()
        return [blds[i] for i, _ in out], [blds[i]['exp'] * sh for i, sh in out]
    unplaced_view = unplaced_ext = 0; blk_guess = 0; bad_setai = 0; stats['blocksReached'] = 0
    for k, f in enumerate(blocks):
        v = num(f['a'].get('SETAI'))
        if v is None:
            bad_setai += 1; v = 0
        f['setai'] = setai = max(0, int(round(v)))
        f['eff'] = setai if f['shareExt'] >= FULL else int(round(setai * f['shareExt']))
        bs = by_blk.get(k, [])
        cand = [b for b in bs if b['exp'] > 0]; wts = [b['exp'] for b in cand]
        if f['eff'] > 0 and not cand:
            # no residential building centred here: residential buildings that reach in (slabs over several blocks)
            cand, wts = reaching(f)
            if cand:
                stats['blocksReached'] += 1; f['spill'] = True
                for b in cand:
                    if b['blk'] is not None:
                        blocks[b['blk']]['spill'] = True
        if f['eff'] > 0 and not cand:
            # households but no residential building: offices, schools etc. of 30 m2 or more
            cand = [b for b in bs if b['area'] >= 30 and b['cls'] != 9]
            for b in cand:
                b['exp'] = b['area'] * b['floors'] / 300.0; b['guess'] = True
            wts = [b['exp'] for b in cand]
            if cand and f['shareView'] > 0:
                blk_guess += 1
        f['cand'] = len(cand)
        if f['eff'] > 0 and not cand:
            unplaced_ext += f['eff']; unplaced_view += int(round(setai * f['shareView'])); continue
        for b, n in zip(cand, largest_remainder(f['eff'], wts)):
            b['hh'] += n
    if bad_setai:
        msg = '%d blocks have no numeric SETAI; counted as 0 households' % bad_setai
        print('WARNING:', msg, file=sys.stderr); warn(msg)

    # ---- census tables
    t083, l083 = read_table(a.t083)
    t084, l084 = read_table(a.t084)
    t082, l082 = read_table(a.t082)
    L_gen = find_label(l084, r'^一般世帯総数$', r'^一般世帯数$', r'一般世帯') or find_label(l083, r'一般世帯')
    L_single = find_label(l084, r'^単独世帯$', r'単独世帯')
    L_single83 = find_label(l083, r'1人$', r'1人世帯', r'世帯人員が1人')
    L_h65 = find_label(l084, r'65歳以上世帯員のいる', r'65歳以上の世帯員のいる')
    L_pop = find_label(l082, r'^総数$', r'^総数[(、,]?年齢', r'^総数総数$', r'^人口総数$')    # real: 総数、年齢「不詳」含む
    L_p65 = find_label(l082, r'^総数65歳以上$', r'65歳以上$', r'65歳以上')
    labels_used = {'general': L_gen, 'single': L_single or L_single83, 'h65': L_h65, 'pop': L_pop, 'p65': L_p65}
    print('labels:', labels_used, file=sys.stderr)
    missing = [k for k, v in labels_used.items() if v is None]
    if missing:
        msg = 'no table column found for %s (labels: %s)' % (', '.join(missing), ' | '.join(l083 + l084 + l082))
        print('WARNING:', msg, file=sys.stderr); warn(msg[:2000])

    def val(t, key, lab):
        if lab is None:
            return None
        d = t.get(key)
        return None if d is None else d.get(lab)

    # small areas: merge hidden ones into the area that carries their numbers
    group = {}
    for key in akeys:
        d = t084.get(key) or t083.get(key)
        tgt = key
        if d is not None and val(t084, key, L_gen) is None:
            to = (d['_row'].get('HTKSAKI') or '').strip()
            if to:
                t = hidden_target(key, to)
                if t is not None and t not in akeys and t.endswith('00') and t[:9] in akeys:
                    t = t[:9]          # the real r2ka keys a 町 without 丁目 with 9 digits
                if t is None:
                    msg = 'area %s is hidden but its HTKSAKI %r is not a key; kept on its own' % (key, to)
                    print('WARNING:', msg, file=sys.stderr)
                else:
                    tgt = t; msg = 'area %s is hidden in the tables; pooled with %s' % (key, tgt)
                    print(msg, file=sys.stderr)
                warn(msg)
        group[key] = tgt
    cen = {}
    for key in sorted(set(group.values())):
        g = val(t084, key, L_gen)
        if g is None:      # 0 is a real count
            g = val(t083, key, L_gen)
        s = val(t084, key, L_single) if L_single else None
        if s is None:
            s = val(t083, key, L_single83)
        cen[key] = {'general': g, 'single': s, 'h65': val(t084, key, L_h65),
                    'pop': val(t082, key, L_pop), 'p65': val(t082, key, L_p65)}
    nomatch = sorted(k for k in akeys if any(cen[group[k]][f] is None for f in ('general', 'single', 'p65')))
    if nomatch:
        shown = {akeys[b['are']] for b in blds if b['inview'] and b['are'] is not None}
        print('areas without census numbers (general/single/65+): %d of %d: %s'
              % (len(nomatch), len(akeys), ' '.join(nomatch)), file=sys.stderr)
        bad = [k for k in nomatch if k in shown]
        if bad:
            print('WARNING: %d areas with buildings in the view have no census numbers (no singles there): %s'
                  % (len(bad), ' '.join(bad)), file=sys.stderr)
        warn('areas without census numbers: %s' % ' '.join(nomatch))

    # ---- step 3: singles per small-area group -> buildings
    by_grp = defaultdict(list)
    for b in blds:
        b['s'] = 0; b['e'] = 0; b['xs'] = 0.0; b['xe'] = 0.0
        if b['are'] is not None:
            by_grp[group[akeys[b['are']]]].append(b)
    setai_grp = defaultdict(int)
    for key, f in zip(akeys, areas):
        v = num(f['a'].get('SETAI'))
        setai_grp[group[key]] += v if v is not None else 0
    def single_weight(b):
        if b['hh'] <= 0:
            return 0.0
        code = b['usage'] if b['res'] else None
        k = {'412': 1.6, '414': 1.45, '413': 0.6, '415': 0.55, '411': 0.45}.get(code, 0.9)
        if code in ('412', '414'):
            per = b['area'] * b['floors'] * USAGE[code][2] / max(1, b['hh'])
            k *= min(1.8, max(0.6, 55.0 / max(per, 15.0)))
        return b['hh'] * k
    for key in sorted(by_grp):
        bs = by_grp[key]
        c = cen.get(key, {})
        tot = setai_grp.get(key) or c.get('general') or 0
        hh_in = sum(b['hh'] for b in bs)
        if c.get('single') is None or not tot:
            warn('no single-household count for %s' % key); continue
        target = min(hh_in, int(round(c['single'] * hh_in / tot)))
        xs, out = frac_allocation(target, [single_weight(b) for b in bs], [b['hh'] for b in bs])
        for b, x, n in zip(bs, xs, out):
            b['xs'] = x; b['s'] = n

    # ---- step 4: elderly singles. ward total -> areas -> buildings
    W = {}
    for key, c in sorted(cen.items()):
        if c.get('single') and c.get('pop') and c.get('p65') is not None:
            W[key] = c['single'] * c['p65'] / c['pop']
    caps = {k: min(cen[k]['single'], cen[k]['h65'] if cen[k].get('h65') is not None else cen[k]['single']) for k in W}
    keys = sorted(W)
    E_area = dict(zip(keys, capped_allocation(a.ward_elderly_single, [W[k] for k in keys], [int(caps[k]) for k in keys])))
    for key in sorted(by_grp):
        bs = by_grp[key]
        c = cen.get(key, {})
        tot = setai_grp.get(key) or c.get('general') or 0
        if key not in E_area or not tot:
            continue
        hh_in = sum(b['hh'] for b in bs)
        target = min(sum(b['s'] for b in bs), int(round(E_area[key] * hh_in / tot)))
        ws = [b['s'] * (1.15 if b['usage'] in ('411', '413', '415') else 1.0) for b in bs]
        xe, out = frac_allocation(target, ws, [b['s'] for b in bs])
        for b, x, n in zip(bs, xe, out):
            b['xe'] = x; b['e'] = n

    # ---- step 5: flood floors (floor k is flooded when 0.5 m + k * storey height < depth)
    for b in blds:
        b['ffl'] = 0
        if b['fd'] > 0:
            fh = min(3.6, max(2.6, b['h'] / b['floors']))
            b['ffl'] = sum(1 for k in range(b['floors']) if 0.5 + k * fh < b['fd'])

    # ---- validation: share small-area totals without block numbers, compare with whole blocks
    def crossval(weight):
        pred = defaultdict(float)
        for key in sorted(by_grp):
            bs = by_grp[key]
            tot = sum(b['hh'] for b in bs)
            ws = [weight(b) for b in bs]
            s = sum(ws)
            if s <= 0:
                continue
            for b, w in zip(bs, ws):
                if b['blk'] is not None:
                    pred[b['blk']] += tot * w / s
        obs = {k: blocks[k]['setai'] for k in by_blk if blocks[k]['shareExt'] >= FULL and num(blocks[k]['a'].get('SETAI')) is not None}
        ks = sorted(k for k in obs if obs[k] >= 20)
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

    # ---- grid: the view plus a margin, from all kept buildings
    grid = build_grid(loc, blds, (max(ex1, vx1 - GRID_PAD), max(ey1, vy1 - GRID_PAD),
                                  min(ex2, vx2 + GRID_PAD), min(ey2, vy2 + GRID_PAD)))

    # ---- pack the buildings in the view
    packed = [b for b in blds if b['inview']]
    packed.sort(key=lambda b: (b['blk'] if b['blk'] is not None else 1 << 30, b['cy'], b['cx']))
    for i, b in enumerate(packed):
        b['pidx'] = i
    N = len(packed)
    used_blocks = sorted(set(b['blk'] for b in packed if b['blk'] is not None))
    bindex = {k: i for i, k in enumerate(used_blocks)}
    used_areas = sorted(set(b['are'] for b in packed if b['are'] is not None))
    aindex = {k: i for i, k in enumerate(used_areas)}
    clamps = {}
    def clamp(name, t, vals):
        lo, hi = RANGE[t]; n = 0; out = []
        for v in vals:
            if v < lo or v > hi:
                v = lo if v < lo else hi; n += 1
            out.append(v)
        if n:
            clamps[name] = clamps.get(name, 0) + n
            msg = '%s: %d value(s) clamped to %d..%d' % (name, n, lo, hi)
            print('WARNING:', msg, file=sys.stderr); warn(msg)
        return out
    hh = clamp('hh', 'H', [b['hh'] for b in packed])
    for b, v in zip(packed, hh):
        if v != b['hh']:
            b['hh'] = v; b['s'] = min(b['s'], v); b['e'] = min(b['e'], b['s'])
    floors = clamp('floors', 'B', [b['floors'] for b in packed])
    ffl = clamp('floodFloors', 'B', [b['ffl'] for b in packed])
    fdep = clamp('floodDepth', 'H', [int(round(b['fd'] * 100)) for b in packed])          # cm
    fhrs = clamp('floodHours', 'H', [int(round(b['fdur'])) if b['fdur'] else 0 for b in packed])

    # ---- lights: one per household; small buildings take their types from pools
    pools, unpooled = make_pools(packed)
    lt = deal_lights(packed, pools)
    pool_of = {i: p['id'] for p in pools for i in p['members']}

    # ---- every published number is counted from the packed buildings and their lights
    T = dict.fromkeys(('residential', 'households', 'single', 'elderly', 'floodHH', 'floodE',
                       'floodBuildings', 'allFloorsHH', 'longHH'), 0)
    VW = [dict.fromkeys(('hh', 's', 'e', 'floodHH', 'floodBuildings', 'floodE', 'allFloors', 'longHH'), 0) for _ in used_areas]
    fhh = []; off = 0
    for i, b in enumerate(packed):
        n, F, nf = hh[i], max(1, floors[i]), ffl[i]
        s = e = fl = fe = 0
        for k in range(n):
            t = lt[off + k]
            s += t > 0; e += t == 2
            if (0 if F == 1 else k % F) < nf:
                fl += 1; fe += t == 2
        off += n
        m = min(nf, F)
        assert fl == m * (n // F) + min(m, n % F)
        fhh.append(fl)
        fb = 1 if fdep[i] > 0 and n > 0 else 0
        allf = n if fb and fl == n else 0
        lng = n if fdep[i] >= 50 and fhrs[i] >= 72 else 0
        T['residential'] += n > 0
        for key, v in (('households', n), ('single', s), ('elderly', e), ('floodHH', fl), ('floodE', fe),
                       ('floodBuildings', fb), ('allFloorsHH', allf), ('longHH', lng)):
            T[key] += v
        if b['are'] is not None:
            w = VW[aindex[b['are']]]
            for key, v in (('hh', n), ('s', s), ('e', e), ('floodHH', fl), ('floodBuildings', fb),
                           ('floodE', fe), ('allFloors', allf), ('longHH', lng)):
                w[key] += v
    ring_start = [0]; ring_xy = []
    for b in packed:
        for x, y in simplify_xy(b['ring'], 0.25):
            ring_xy.append(int(round(x * 100))); ring_xy.append(int(round(y * 100)))
        ring_start.append(len(ring_xy) // 2)
    wv = [None if v is None else int(round(v * 10)) for row in grid['water'] for v in row]
    wreal = iter(clamp('water', 'w', [v for v in wv if v is not None]))
    arrays = [
        ('ringStart', 'I', ring_start),
        ('ringXY', 'i', clamp('ringXY', 'i', ring_xy)),            # centimetres from origin (east, north)
        ('base', 'f', [b['z0'] for b in packed]),                   # orthometric metres (approx.)
        ('height', 'f', [b['h'] for b in packed]),
        ('floors', 'B', floors),
        ('cls', 'B', [b['cls'] for b in packed]),
        ('hh', 'H', hh),
        ('single', 'H', [b['s'] if b['hh'] >= SMALL_BUILDING else 65535 for b in packed]),
        ('elderly', 'H', [b['e'] if b['hh'] >= SMALL_BUILDING else 65535 for b in packed]),
        ('block', 'H', clamp('block', 'H', [bindex.get(b['blk'], 65535) for b in packed])),
        ('area', 'H', clamp('area', 'H', [aindex.get(b['are'], 65535) for b in packed])),
        ('floodDepth', 'H', fdep),
        ('floodHours', 'H', fhrs),
        ('floodFloors', 'B', ffl),
        ('floodHH', 'H', clamp('floodHH', 'H', fhh)),
        ('ground', 'h', clamp('ground', 'h', [int(round(v * 10)) for row in grid['ground'] for v in row])),   # dm
        ('water', 'h', [-32768 if v is None else next(wreal) for v in wv]),                                    # dm, -32768 dry
        ('lightType', 'B', lt),
    ]
    os.makedirs(a.out, exist_ok=True)
    layout = {}; blob = bytearray()
    for nm, t, vals in arrays:
        while len(blob) % 4:
            blob.append(0)
        layout[nm] = {'type': t, 'offset': len(blob), 'length': len(vals)}
        blob += struct.pack('<%d%s' % (len(vals), t), *vals)
    with open(os.path.join(a.out, 'area.bin'), 'wb') as f:
        f.write(bytes(blob))

    kept_n = Counter(b['blk'] for b in blds if b['blk'] is not None)
    packed_n = Counter(b['blk'] for b in packed if b['blk'] is not None)
    blk_out = []
    for k in used_blocks:
        f = blocks[k]
        ring = simplify_xy(max(f['parts'], key=lambda r: abs(area_xy(r))), 1.0)
        blk_out.append({'hh': cint(f['a'].get('SETAI')), 'pop': cint(f['a'].get('JINKO')),
                        'partial': f['shareView'] < FULL or f['shareExt'] < FULL or packed_n[k] < kept_n[k] or 'spill' in f,
                        'ring': [[int(round(x)), int(round(y))] for x, y in ring]})
    area_out = []
    for k in used_areas:
        f = areas[k]; key = akeys[k]
        c = cen.get(group[key], {})
        ring = simplify_xy(max(f['parts'], key=lambda r: abs(area_xy(r))), 3.0)
        inner = clip_rect(ring, vx1, vy1, vx2, vy2)       # label point inside the view
        cx, cy = centroid_xy(inner if len(inner) >= 3 and abs(area_xy(inner)) > 1.0 else ring)
        area_out.append({
            'key': key, 'name': f['a'].get('S_NAME') or '', 'pooledWith': group[key] if group[key] != key else None,
            'coverage': round(f['coverage'], 3),
            'census': {'households': cint(f['a'].get('SETAI')), 'pop': cint(f['a'].get('JINKO')),
                       'general': c.get('general'), 'single': c.get('single'), 'h65': c.get('h65'),
                       'p65': c.get('p65'), 'popT': c.get('pop'), 'elderlySingleEst': E_area.get(group[key])},
            'view': VW[aindex[k]],
            'c': [int(round(cx)), int(round(cy))],
            'ring': [[int(round(x)), int(round(y))] for x, y in ring],
        })
    scen = defaultdict(int)
    for b in packed:
        if b['fsc']:
            scen[b['fsc']] += 1
    totals = dict({'buildings': N}, **T)
    totals.update({
        'unplacedHouseholds': unplaced_view, 'blocksGuessed': blk_guess,
        'partialBlocks': sum(1 for x in blk_out if x['partial']),
        'pooled': {'blockPools': sum(1 for p in pools if p['kind'] == 'block'),
                   'areaPools': sum(1 for p in pools if p['kind'] == 'area'),
                   'viewPool': sum(1 for p in pools if p['kind'] == 'view'),
                   'pooledBuildings': len(pool_of),
                   'untypedHouseholds': sum(packed[i]['hh'] for i in unpooled)},
    })
    if clamps:
        stats['clamped'] = clamps
    meta = {
        'version': 2, 'name': name, 'city': a.city, 'cityName': a.city_name,
        'origin': [loc.lon0, loc.lat0], 'kx': loc.kx, 'ky': loc.ky, 'geoid': a.geoid,
        'extent': ext, 'bbox': view, 'smallBuilding': SMALL_BUILDING,
        'poolMin': {'households': POOL_MIN_HH, 'buildings': POOL_MIN_BLD},
        'usageClass': USAGE_CLASS,
        'grid': {k: grid[k] for k in ('x1', 'y1', 'cell', 'nx', 'ny')},
        'layout': layout, 'totals': totals, 'validation': validation,
        'wardElderlySingle': a.ward_elderly_single,
        'floodScenarios': dict(sorted(scen.items(), key=lambda t: -t[1])[:12]),
        'labels': labels_used,
        'sources': [s.format(city=a.city_name, year=a.plateau_year) for s in SOURCES],
        'note': '建物ごとの世帯数・世帯類型は、国勢調査の集計値を建物の用途・階数・面積で按分した推計値です。実際の居住状況を示すものではありません。',
    }
    write_json(os.path.join(a.out, 'area.json'), {'meta': meta, 'blocks': blk_out, 'areas': area_out}, separators=(',', ':'))
    rep = {'stats': dict(stats), 'totals': totals, 'validation': validation, 'labels': labels_used,
           'choAgreement': [agree, with_attr], 'warnings': warnings,
           'censusTotalsInView': {'blocksSETAI': int(sum(num(blocks[k]['a'].get('SETAI')) or 0 for k in used_blocks)),
                                  'viewShareSETAI': int(round(sum(f['setai'] * f['shareView'] for f in blocks)))},
           'duplicates': {'blocks': ndup_blk, 'areas': ndup_are}, 'nomatch': nomatch,
           'extent': ext, 'view': view, 'unplacedExtent': unplaced_ext}
    write_json(os.path.join(a.out, 'report.json'), rep, indent=1)

    dump = os.environ.get('MADOAKARI_DEBUG_DUMP')
    if dump:
        try:
            inside = os.path.commonpath([os.path.abspath(a.out), os.path.abspath(dump)]) == os.path.abspath(a.out)
        except ValueError:
            inside = False
        if inside:
            print('WARNING: MADOAKARI_DEBUG_DUMP points into --out; not written', file=sys.stderr)
        else:
            write_json(dump, {'buildings': [{'id': b['id'], 'idx': b.get('pidx'), 'inview': b['inview'], 'blk': b['blk'],
                                      'are': b['are'], 'usage': b['usage'], 'area': b['area'], 'hh': b['hh'],
                                      's': b['s'], 'e': b['e'], 'xs': b['xs'], 'xe': b['xe'],
                                      'pool': pool_of.get(b['pidx']) if 'pidx' in b else None} for b in blds],
                       'pools': [{'id': p['id'], 'kind': p['kind'], 'buildings': len(p['members']),
                                  'H': p['H'], 'S': p['S'], 'E': p['E']} for p in pools],
                       'blocks': [{'key': f['a'].get('KEY_CODE'), 'idx': bindex.get(k), 'setai': f['setai'],
                                   'eff': f['eff'], 'shareExt': f['shareExt'], 'shareView': f['shareView'],
                                   'cand': f['cand'], 'spill': 'spill' in f} for k, f in enumerate(blocks)],
                       'areas': [{'key': key, 'idx': aindex.get(k), 'group': group[key]} for k, key in enumerate(akeys)]})
    print('pools: %s' % json.dumps(totals['pooled']), file=sys.stderr)
    print(json.dumps(totals, ensure_ascii=False), file=sys.stderr)
    print('bin %.1f MB, json %.1f MB' % (len(blob) / 1e6, os.path.getsize(os.path.join(a.out, 'area.json')) / 1e6), file=sys.stderr)

if __name__ == '__main__':
    main()
