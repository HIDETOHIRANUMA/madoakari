"""Tests for tools/estimate.py (data contract v2).

  python3 tools/test/test_estimate.py

Builds a synthetic city with make_synth.py --real-estat --edge-cases in a temp folder,
runs the estimator on it and checks the published files against the rules.
"""
import contextlib, io, json, math, os, shutil, struct, subprocess, sys, tempfile, unittest, zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
TOOLS = os.path.dirname(HERE)
EST = os.path.join(TOOLS, 'estimate.py')
SYNTH = os.path.join(HERE, 'make_synth.py')
sys.dont_write_bytecode = True
sys.path.insert(0, TOOLS)
import estimate as est  # noqa: E402

SOURCES = ['「3D都市モデル（Project PLATEAU）板橋区（2025年度）」（国土交通省）を加工して作成',
           '「令和2年国勢調査」（総務省統計局）を加工して作成',
           '出典：政府統計の総合窓口(e-Stat)（https://www.e-stat.go.jp/）']
KX = 111320 * math.cos(math.radians(35.775)); KY = 110540     # make_synth's metres per degree
TOT = ('buildings', 'residential', 'households', 'single', 'elderly', 'floodHH', 'floodE',
       'floodBuildings', 'allFloorsHH', 'longHH')
VIEWK = ('hh', 's', 'e', 'floodHH', 'floodBuildings', 'floodE', 'allFloors', 'longHH')
T = {}


def rb(p):
    with open(p, 'rb') as f:
        return f.read()


def rjson(p):
    with open(p, encoding='utf-8') as f:
        return json.load(f)


def run_est(args, env=None):
    e = dict(os.environ); e.pop('MADOAKARI_DEBUG_DUMP', None); e['PYTHONIOENCODING'] = 'utf-8'
    e.update(env or {})
    return subprocess.run([sys.executable, EST] + args, capture_output=True, text=True,
                          encoding='utf-8', errors='replace', env=e)


def est_args(out, real=True, view=None):
    s = lambda n: os.path.join(T['syn'], n)
    if real:
        files = ['--blocks', s('r2kb13119.zip'), '--areas', s('r2ka13119.zip'), '--t083', s('tblT001083C13.zip'),
                 '--t084', s('tblT001084C13.zip'), '--t082', s('tblT001082C13.zip')]
    else:
        files = ['--blocks', s('blocks.shp'), '--areas', s('areas.shp'), '--t083', s('t083.txt'),
                 '--t084', s('t084.txt'), '--t082', s('t082.txt')]
    return ['--buildings', s('buildings.json')] + files + ['--ward-elderly-single', '7200',
            '--bbox', view or T['view'], '--name', '高島平とその周辺', '--out', out]


def load(d):
    doc = rjson(os.path.join(d, 'area.json'))
    raw = rb(os.path.join(d, 'area.bin'))
    A = {n: struct.unpack_from('<%d%s' % (L['length'], L['type']), raw, L['offset']) for n, L in doc['meta']['layout'].items()}
    return doc, A


def recount(doc, A):
    """Totals, area views and per-building counts recounted from the lights (the app's rules)."""
    N = len(A['hh'])
    tot = dict.fromkeys(TOT, 0); tot['buildings'] = N
    views = [dict.fromkeys(VIEWK, 0) for _ in doc['areas']]
    per = []; off = 0
    for i in range(N):
        n = A['hh'][i]; F = max(1, A['floors'][i]); nf = A['floodFloors'][i]
        t = A['lightType'][off:off + n]; off += n
        fl = [k for k in range(n) if (0 if F == 1 else k % F) < nf]
        s = sum(1 for v in t if v >= 1); e = sum(1 for v in t if v == 2); fe = sum(1 for k in fl if t[k] == 2)
        fb = int(A['floodDepth'][i] > 0 and n > 0)
        allf = n if fb and len(fl) == n else 0
        lng = n if A['floodDepth'][i] >= 50 and A['floodHours'][i] >= 72 else 0
        per.append({'s': s, 'e': e, 'fl': len(fl), 'fe': fe, 'types': t})
        for k, v in zip(TOT[1:], (int(n > 0), n, s, e, len(fl), fe, fb, allf, lng)):
            tot[k] += v
        if A['area'][i] != 65535:
            w = views[A['area'][i]]
            for k, v in zip(VIEWK, (n, s, e, len(fl), fb, fe, allf, lng)):
                w[k] += v
    return tot, views, per


def setUpModule():
    tmp = tempfile.mkdtemp(prefix='madoakari-test-')
    unittest.addModuleCleanup(shutil.rmtree, tmp, True)
    T['tmp'] = tmp; T['syn'] = os.path.join(tmp, 'syn')
    r = subprocess.run([sys.executable, SYNTH, T['syn'], '--real-estat', '--edge-cases'], capture_output=True, text=True)
    assert r.returncode == 0, r.stderr
    T['edge'] = rjson(os.path.join(T['syn'], 'edge.json'))
    T['estat'] = rjson(os.path.join(T['syn'], 'estat.json'))
    b = T['edge']['bbox']        # report.bbox in buildings.json = the extent; the view is 150 m inside
    T['view'] = ','.join('%.6f' % v for v in (b[0] + 150 / KX, b[1] + 150 / KY, b[2] - 150 / KX, b[3] - 150 / KY))
    T['dump'] = os.path.join(tmp, 'dump.json')
    for name, env in (('out1', {'MADOAKARI_DEBUG_DUMP': T['dump']}), ('out2', {})):
        T[name] = os.path.join(tmp, name)
        r = run_est(est_args(T[name]), env)
        assert r.returncode == 0, r.stderr
        T[name + '_err'] = r.stderr
    T['doc'], T['A'] = load(T['out1'])
    T['report'] = rjson(os.path.join(T['out1'], 'report.json'))
    T['dumpd'] = rjson(T['dump'])


class TestEstimate(unittest.TestCase):

    def test_01_light_invariants(self):
        doc, A = T['doc'], T['A']; M = doc['meta']
        self.assertEqual(M['version'], 2)
        self.assertEqual(len(A['lightType']), sum(A['hh']))
        self.assertTrue(set(A['lightType']) <= {0, 1, 2})
        tot, views, per = recount(doc, A)
        for i, p in enumerate(per):
            if A['hh'][i] >= M['smallBuilding']:
                self.assertEqual((A['single'][i], A['elderly'][i]), (p['s'], p['e']), 'building %d' % i)
            else:
                self.assertEqual((A['single'][i], A['elderly'][i]), (65535, 65535), 'building %d' % i)
            n, F = A['hh'][i], max(1, A['floors'][i]); m = min(A['floodFloors'][i], F)
            self.assertEqual(A['floodHH'][i], p['fl'])
            self.assertEqual(A['floodHH'][i], m * (n // F) + min(m, n % F))
        for k in TOT:
            self.assertEqual(M['totals'][k], tot[k], k)
        self.assertGreater(tot['floodE'], 0)
        for a, v in zip(doc['areas'], views):
            self.assertEqual(a['view'], v, a['key'])
        self.assertEqual(T['report']['totals'], M['totals'])

    def test_02_privacy(self):
        doc, A, dm = T['doc'], T['A'], T['dumpd']
        for b in doc['blocks']:
            self.assertEqual(set(b), {'hh', 'pop', 'partial', 'ring'})
        pools = {p['id']: p for p in dm['pools']}
        for p in pools.values():
            self.assertGreaterEqual(p['buildings'], 3); self.assertGreaterEqual(p['H'], 10)
        kinds = {p['kind'] for p in pools.values()}
        self.assertTrue({'block', 'area', 'view'} <= kinds, kinds)
        ids = {b['id']: b for b in dm['buildings']}
        for k in T['edge']['sparse']:          # blocks of 1-2 small buildings never pool alone
            self.assertIn(pools[ids[k]['pool']]['kind'], ('area', 'view'))
        _, _, per = recount(doc, A)
        got = {}
        for b in dm['buildings']:
            if b['idx'] is None or not 0 < b['hh'] < 10:
                continue
            t = per[b['idx']]
            if b['pool'] is None:
                self.assertEqual((t['s'], t['e']), (0, 0))
            else:
                g = got.setdefault(b['pool'], [0, 0, 0, 0]); g[0] += 1; g[1] += b['hh']; g[2] += t['s']; g[3] += t['e']
        for pid, g in got.items():           # each pool's lights hold exactly its [H, S, E]
            p = pools[pid]
            self.assertEqual(g, [p['buildings'], p['H'], p['S'], p['E']])
        # the subtraction route (area numbers minus the published big buildings) only yields pooled draws
        rest = [[a['view']['s'], a['view']['e'], 0, 0] for a in doc['areas']]
        for i in range(len(A['hh'])):
            if A['area'][i] == 65535 or not A['hh'][i]:
                continue
            r = rest[A['area'][i]]
            if A['hh'][i] >= 10:
                r[0] -= A['single'][i]; r[1] -= A['elderly'][i]
            else:
                r[2] += per[i]['s']; r[3] += per[i]['e']
        for a, r in zip(doc['areas'], rest):
            self.assertEqual(r[:2], r[2:], a['key'])

    def test_02b_privacy_invariance(self):
        """Moving singles/elderly between the members of a pool (pool sums kept), or changing
        unpooled small buildings, must not change a single published byte."""
        orig = est.make_pools; changed = [0]
        def perturbed(packed):
            pools, unpooled = orig(packed)
            for p in pools:
                m = p['members']; S, E = p['S'], p['E']
                old = [(packed[i]['s'], packed[i]['e']) for i in m]
                for i in reversed(m):
                    packed[i]['s'] = min(packed[i]['hh'], S); S -= packed[i]['s']
                for i in m:
                    packed[i]['e'] = min(packed[i]['s'], E); E -= packed[i]['e']
                changed[0] += sum(1 for i, o in zip(m, old) if (packed[i]['s'], packed[i]['e']) != o)
            for i in unpooled:
                packed[i]['s'] = packed[i]['e'] = packed[i]['hh']
            return orig(packed)
        out3 = os.path.join(T['tmp'], 'out3')
        argv, env = sys.argv, os.environ.pop('MADOAKARI_DEBUG_DUMP', None)
        try:
            est.make_pools = perturbed
            sys.argv = ['estimate.py'] + est_args(out3)
            with contextlib.redirect_stderr(io.StringIO()):
                est.main()
        finally:
            est.make_pools = orig; sys.argv = argv
            if env is not None:
                os.environ['MADOAKARI_DEBUG_DUMP'] = env
        self.assertGreater(changed[0], 100)
        for f in ('area.json', 'area.bin', 'report.json'):
            self.assertEqual(rb(os.path.join(T['out1'], f)), rb(os.path.join(out3, f)), f)

    def test_03_cho_without_chome(self):
        doc, es = T['doc'], T['estat']
        a = next(a for a in doc['areas'] if a['key'] == es['choless'])
        self.assertTrue(a['key'].endswith('00'))
        for k in ('general', 'single', 'h65', 'pop', 'p65', 'elderlySingleEst'):
            self.assertIsNotNone(a['census'][k], k)
        self.assertGreater(a['view']['s'], 0); self.assertGreater(a['view']['e'], 0)
        h = next(a for a in doc['areas'] if a['key'] == es['hidden'])
        self.assertEqual(h['pooledWith'], es['choless'])       # HTKSAKI with 9 digits
        self.assertEqual(T['report']['nomatch'], [])
        self.assertEqual(doc['meta']['labels']['single'], '世帯人員１人')
        # table aliases: a 9-digit 町 row without 丁目 rows is also found as key + '00'
        p = os.path.join(T['tmp'], 'alias.txt')
        rows = ['KEY_CODE,HYOSYO,CITYNAME,NAME,HTKSYORI,HTKSAKI,GASSAN,T001083001', ',,,,,,,世帯人員１人',
                '131190200,2,板橋区,だいもん,0,,,5', '131190100,2,板橋区,あかつき,0,,,9',
                '13119010001,3,板橋区,あかつき一丁目,0,,,9', '13119010002,3,板橋区,あかつき二丁目,1,13119010001,,X']
        with open(p, 'w', encoding='cp932', newline='') as fh:
            fh.write('\r\n'.join(rows) + '\r\n')
        t, labels = est.read_table(p)
        self.assertEqual(t['13119020000']['世帯人員１人'], 5)
        self.assertNotIn('13119010000', t)
        self.assertIsNone(t['13119010002']['世帯人員１人'])
        ht = est.hidden_target
        self.assertEqual(ht('13119013002', '13119012001'), '13119012001')
        self.assertEqual(ht('13119013002', '131190200'), '13119020000')
        self.assertEqual(ht('13119013002', '012001'), '13119012001')
        self.assertEqual(ht('13119013002', '0200'), '13119020000')
        self.assertIsNone(ht('13119013002', '12345'))
        self.assertIsNone(ht('13119013002', '1311901300a'))

    def test_04_block_shares(self):
        doc, A, dm = T['doc'], T['A'], T['dumpd']
        hh_of = {}
        for b in dm['buildings']:
            if b['blk'] is not None:
                hh_of[b['blk']] = hh_of.get(b['blk'], 0) + b['hh']
        cut = [(k, f) for k, f in enumerate(dm['blocks']) if 1e-6 < f['shareExt'] < 0.999 and f['cand'] > 0 and not f['spill']]
        self.assertGreaterEqual(len(cut), 10)
        for k, f in cut:
            self.assertEqual(hh_of.get(k, 0), f['eff'])
            self.assertLessEqual(abs(f['eff'] - round(f['setai'] * f['shareExt'])), 1)
        keys = {f['key']: f for f in dm['blocks']}
        for key in T['edge']['cutBlocks']:
            if key in keys:
                self.assertAlmostEqual(keys[key]['shareExt'], 0.5, delta=0.02)
        by_idx = {f['idx']: f for f in dm['blocks'] if f['idx'] is not None}
        packed = {}
        for i in range(len(A['hh'])):
            if A['block'][i] != 65535:
                packed[A['block'][i]] = packed.get(A['block'][i], 0) + A['hh'][i]
        whole = 0
        for j, b in enumerate(doc['blocks']):
            if not b['partial'] and by_idx[j]['cand'] > 0:
                self.assertEqual(packed.get(j, 0), b['hh']); whole += 1
            if by_idx[j]['shareView'] < 0.999:
                self.assertTrue(b['partial'])
        self.assertGreater(whole, 500)
        # duplicate KEY_CODE records: merged once, SETAI taken once (repeated) or summed (split)
        self.assertEqual(T['report']['duplicates'], {'blocks': 2, 'areas': 1})
        for key, d in T['edge']['dupBlocks'].items():
            self.assertEqual([f['setai'] for f in dm['blocks'] if f['key'] == key], [d['SETAI']])
        ar = [a for a in doc['areas'] if a['key'] == T['edge']['dupArea']]
        self.assertEqual(len(ar), 1); self.assertEqual(ar[0]['coverage'], 1.0)
        tot = doc['meta']['totals']
        for k in ('unplacedHouseholds', 'blocksGuessed', 'partialBlocks'):
            self.assertIsInstance(tot[k], int)
        counts = [v for b in doc['blocks'] for v in (b['hh'], b['pop'])] + \
                 [a['census'][k] for a in doc['areas'] for k in ('households', 'pop')]
        self.assertTrue(all(v is None or type(v) is int for v in counts))       # never a raw dbf string
        self.assertEqual(tot['partialBlocks'], sum(1 for b in doc['blocks'] if b['partial']))
        cov = [a['coverage'] for a in doc['areas']]
        self.assertTrue(all(0 < c <= 1 for c in cov) and min(cov) < 0.95)

    def test_05_fractional_allocation(self):
        bs = T['dumpd']['buildings']
        for b in bs:
            self.assertTrue(0 <= b['s'] <= b['hh'] and 0 <= b['e'] <= b['s'], b)
            self.assertLessEqual(b['xs'], b['hh'] + 1e-9); self.assertLessEqual(b['xe'], b['s'] + 1e-9)
            self.assertLess(abs(b['s'] - b['xs']), 1 + 1e-9); self.assertLess(abs(b['e'] - b['xe']), 1 + 1e-9)
        h = [b for b in bs if b['usage'] == '411' and b['hh'] == 1]
        xs = sum(b['xs'] for b in h); xe = sum(b['xe'] for b in h)
        self.assertGreater(xs, 100); self.assertGreater(xe, 20)
        self.assertGreaterEqual(sum(b['s'] for b in h), 0.8 * xs)
        self.assertGreaterEqual(sum(b['e'] for b in h), 0.6 * xe)
        x, out = est.frac_allocation(21, [1, 100], [3, 20])
        self.assertEqual(out, [1, 20]); self.assertAlmostEqual(x[0], 1.0)
        self.assertEqual(est.frac_allocation(25, [1, 100], [3, 20])[1], [3, 20])
        x, out = est.frac_allocation(7, [1.0] * 10, [1] * 10)
        self.assertEqual(sum(out), 7); self.assertTrue(all(o in (0, 1) for o in out))
        x, out = est.frac_allocation(5, [0, 2, 0], [4, 9, 4])
        self.assertEqual(out, [0, 5, 0])
        # the courtyard building uses its net footprint fp (1200 m2) next to a solid twin (1600 m2)
        ids = {b['id']: b for b in bs}
        c, s = ids[T['edge']['courtyard']], ids[T['edge']['solid']]
        self.assertEqual(c['blk'], s['blk'])
        self.assertAlmostEqual(c['area'], 1200.0)
        self.assertTrue(0.65 < c['hh'] / s['hh'] < 0.85, (c['hh'], s['hh']))

    def test_06_flood_of(self):
        f = est.flood_of
        L2a, L2b, L1 = '入間川_L2（想定最大規模）', '荒川水系隅田川・新河岸川_L2（想定最大規模）', '入間川_L1（計画規模）'
        self.assertEqual(f({L2a + '_浸水深': 3.0, L2a + '_浸水継続時間': 336, L2b + '_浸水深': 3.1}), (3.1, 336.0, L2b))
        a = {L2a + '_浸水深': 2.4, L2b + '_浸水深': 2.4, L2b + '_浸水継続時間': 20}
        b = {L2b + '_浸水継続時間': 20, L2b + '_浸水深': 2.4, L2a + '_浸水深': 2.4}
        self.assertEqual(f(a), f(b)); self.assertEqual(f(a), (2.4, 20.0, min(L2a, L2b)))
        st = {'floodInvalid': 0, 'floodL1Fallback': 0}
        self.assertEqual(f({L2a + '_浸水深': -9999, L2b + '_浸水深': 1.0, L2b + '_浸水継続時間': -9999}, st), (1.0, None, L2b))
        self.assertEqual(st['floodInvalid'], 2)
        self.assertEqual(f({L1 + '_浸水深': 1.2, L1 + '_浸水継続時間': 30}, st), (1.2, 30.0, L1))
        self.assertEqual(st['floodL1Fallback'], 1)
        self.assertEqual(f({L2a + '_浸水深': 2.0, L1 + '_浸水深': 1.0, L1 + '_浸水継続時間': 48}), (2.0, 48.0, L2a))
        self.assertEqual(f({L2a + '_浸水深': 99, L1 + '_浸水深': 'abc'}), (0.0, None, None))
        self.assertEqual(f({L2a + '_浸水深': 0, L1 + '_浸水深': 0.8}), (0.8, None, L1))
        self.assertEqual(f({}), (0.0, None, None))
        st = T['report']['stats']
        self.assertEqual((st['floodInvalid'], st['floodL1Fallback']), (2, 1))
        self.assertIn('荒川水系新河岸川_L2（想定最大規模）', T['doc']['meta']['floodScenarios'])
        # in the pipeline: a deeper second L2 without duration keeps the other L2's duration
        src = {b['id']: b for b in rjson(os.path.join(T['syn'], 'buildings.json'))['buildings']}
        ids = {b['id']: b for b in T['dumpd']['buildings']}; A = T['A']; n = 0
        P = '荒川水系荒川（国管理区間）_L2（想定最大規模）'
        for k in T['edge']['twoL2']:
            i = ids.get(k, {}).get('idx')
            if i is None:
                continue
            at = src[k]['a']; n += 1
            self.assertEqual(A['floodDepth'][i], int(round(at['荒川水系新河岸川_L2（想定最大規模）_浸水深'] * 100)))
            self.assertEqual(A['floodHours'][i], int(round(at[P + '_浸水継続時間'])))
        self.assertGreater(n, 100)

    def test_07_cli(self):
        a = est_args(os.path.join(T['tmp'], 'noname'))
        i = a.index('--name')
        self.assertEqual(run_est(a[:i] + a[i + 2:]).returncode, 2)
        self.assertEqual(run_est(a[:i + 1] + ['  '] + a[i + 2:]).returncode, 2)
        self.assertFalse(os.path.exists(os.path.join(T['tmp'], 'noname')))
        r = run_est(est_args(os.path.join(T['tmp'], 'noext'), view='140.01,36.01,140.02,36.02') + ['--extent', '140.0,36.0,140.1,36.1'])
        self.assertEqual(r.returncode, 1); self.assertIn('has its centroid inside the extent', r.stderr)
        # zipped shapefiles and zipped CP932 tables (out1) were read
        lab = T['doc']['meta']['labels']
        self.assertEqual((lab['single'], lab['pop'], lab['p65']), ('世帯人員１人', '総数（年齢「不詳」含む）', '総数６５歳以上'))
        self.assertNotIn('Traceback', T['out1_err'])
        # plain .shp/.txt inputs, one area missing from the tables, a view bigger than the extent
        out = os.path.join(T['tmp'], 'out_tidy'); gone = '13119010002'
        a = est_args(out, real=False, view='139.62,35.77,139.70,35.81')
        for t in ('t083', 't084', 't082'):
            p = os.path.join(T['tmp'], t + '.txt')
            with open(os.path.join(T['syn'], t + '.txt'), 'rb') as f, open(p, 'wb') as g:
                g.write(b''.join(l for l in f if not l.startswith(gone.encode())))
            a[a.index('--' + t) + 1] = p
        r = run_est(a, {'MADOAKARI_DEBUG_DUMP': os.path.join(out, 'dump.json')})
        self.assertEqual(r.returncode, 0, r.stderr)
        for s in ('WARNING: the view', 'is not inside the extent', 'WARNING: 1 areas with buildings in the view have no census',
                  'WARNING: MADOAKARI_DEBUG_DUMP points into --out'):
            self.assertIn(s, r.stderr)
        doc, A = load(out); m = doc['meta']
        self.assertEqual(m['bbox'], m['extent'])
        self.assertEqual(sorted(os.listdir(out)), ['area.bin', 'area.json', 'report.json'])
        self.assertEqual(rjson(os.path.join(out, 'report.json'))['nomatch'], [gone])
        g = next(x for x in doc['areas'] if x['key'] == gone)
        self.assertIsNone(g['census']['single']); self.assertIsNone(g['census']['elderlySingleEst'])
        self.assertEqual(recount(doc, A)[0], {k: m['totals'][k] for k in TOT})
        # broken shapefile zips stop with a clear message
        z1 = os.path.join(T['tmp'], 'nodbf.zip')
        with zipfile.ZipFile(z1, 'w') as z:
            z.write(os.path.join(T['syn'], 'blocks.shp'), 'r2kb13119.shp'); z.write(os.path.join(T['syn'], 'blocks.shx'), 'r2kb13119.shx')
        with self.assertRaises(SystemExit) as cm:
            est.read_shapefile(z1, est.Local(139.65, 35.78), 'blocks')
        self.assertIn('.dbf', str(cm.exception.code))
        z2 = os.path.join(T['tmp'], 'bnd.zip')
        with zipfile.ZipFile(z2, 'w') as z:
            for n in ('blocks', 'areas'):
                for e in ('.shp', '.shx', '.dbf'):
                    z.write(os.path.join(T['syn'], n + e), n + e)
        with self.assertRaises(SystemExit) as cm:
            est.read_shapefile(z2, est.Local(139.65, 35.78), 'blocks')
        self.assertIn('several', str(cm.exception.code))
        with contextlib.redirect_stderr(io.StringIO()):
            feats, nd = est.read_shapefile(os.path.join(T['syn'], 'r2ka13119.zip'), est.Local(139.65, 35.78), 'areas')
        self.assertEqual((len(feats), nd), (28, 1))

    def test_08_sources(self):
        self.assertEqual(T['doc']['meta']['sources'], SOURCES)
        self.assertEqual(T['doc']['meta']['name'], '高島平とその周辺')

    def test_09_determinism(self):
        for f in ('area.json', 'area.bin', 'report.json'):
            self.assertEqual(rb(os.path.join(T['out1'], f)), rb(os.path.join(T['out2'], f)), f)

    def test_10_out_contents(self):
        self.assertEqual(sorted(os.listdir(T['out1'])), ['area.bin', 'area.json', 'report.json'])
        self.assertTrue(os.path.exists(T['dump']))
        r = T['report']
        self.assertEqual(set(r), {'stats', 'totals', 'validation', 'labels', 'choAgreement', 'warnings', 'censusTotalsInView',
                                  'duplicates', 'nomatch', 'extent', 'view', 'unplacedExtent'})
        self.assertLessEqual(len(r['warnings']), 300)
        M = T['doc']['meta']
        self.assertEqual(M['poolMin'], {'households': 10, 'buildings': 3})
        self.assertEqual(M['extent'], T['edge']['bbox'])
        self.assertEqual(M['layout']['lightType']['length'], sum(T['A']['hh']))

    def test_11_view_independent(self):
        """Allocation runs over the extent: another view leaves every kept building's numbers as they are."""
        b = T['edge']['bbox']
        view = ','.join('%.6f' % v for v in (b[0] + 400 / KX, b[1] + 150 / KY, b[2] - 900 / KX, b[3] - 300 / KY))
        out = os.path.join(T['tmp'], 'out_view2'); dump = os.path.join(T['tmp'], 'dump2.json')
        r = run_est(est_args(out, view=view), {'MADOAKARI_DEBUG_DUMP': dump})
        self.assertEqual(r.returncode, 0, r.stderr)
        K = ('hh', 's', 'e', 'xs', 'xe', 'area', 'blk', 'are')
        one = {x['id']: [x[k] for k in K] for x in T['dumpd']['buildings']}
        two = {x['id']: [x[k] for k in K] for x in rjson(dump)['buildings']}
        bad = [k for k in one if one[k] != two.get(k)]
        self.assertEqual((len(one), bad[:3]), (len(two), []), '%d buildings differ' % len(bad))
        doc, A = load(out)
        self.assertLess(doc['meta']['totals']['buildings'], T['doc']['meta']['totals']['buildings'])
        self.assertEqual(recount(doc, A)[0], {k: doc['meta']['totals'][k] for k in TOT})

    def test_12_reach(self):
        """A block with households but no residential building centred in it gives them to a slab reaching in."""
        dm, r = T['dumpd'], T['edge']['reach']
        ids = {b['id']: b for b in dm['buildings']}
        slab, shed = ids[r['slab']], ids[r['shed']]
        a, b = dm['blocks'][slab['blk']], dm['blocks'][shed['blk']]
        self.assertEqual((a['setai'], b['setai'], b['cand']), (40, 20, 1))
        self.assertEqual((slab['hh'], shed['hh']), (60, 0))
        self.assertTrue(a['spill'] and b['spill'])
        self.assertTrue(T['doc']['blocks'][a['idx']]['partial'] and T['doc']['blocks'][b['idx']]['partial'])
        self.assertEqual(T['report']['stats']['blocksReached'], 1)


if __name__ == '__main__':
    unittest.main(verbosity=2)
