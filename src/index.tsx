import { Hono } from 'hono'
import { cors } from 'hono/cors'
import snapshot from './data/snapshot.json'
import {
  filterStocks,
  sortStocks,
  computeStats,
  industryFacets,
  parseFilters,
  type Stock,
  type SortKey,
} from './lib/screen'
import { Page } from './page'

type Bindings = {}

const app = new Hono<{ Bindings: Bindings }>()

app.use('/api/*', cors())

const DATA = snapshot as unknown as {
  meta: {
    source: string
    market: string
    collectedAt: string
    totalRowsScanned: number
    stockCount: number
    industries: string[]
    note: string
  }
  stocks: Stock[]
}

const SORT_KEYS: SortKey[] = [
  'marketCap',
  'per',
  'pbr',
  'opMargin',
  'debtRatio',
  'roe',
  'divYield',
  'revenue',
  'revenueCagr',
  'changeRate',
  'price',
  'name',
]

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

/* ------------------------------------------------------------------ */
/* 정적 파일                                                          */
/* ------------------------------------------------------------------ */
// Cloudflare Pages 는 public/ 자산을 자동 서빙하므로 별도 라우트 불필요.

/* ------------------------------------------------------------------ */
/* API                                                                */
/* ------------------------------------------------------------------ */

app.get('/api/meta', (c) => {
  return c.json({
    ...DATA.meta,
    sortKeys: SORT_KEYS,
  })
})

/**
 * 스크리너 조회
 * GET /api/stocks?marketCapMin=1000&debtRatioMax=200&opMarginMin=5&perMin=0&perMax=15
 */
app.get('/api/stocks', (c) => {
  const sp = new URL(c.req.url).searchParams
  const filters = parseFilters(sp)

  // 즐겨찾기만 보기: 클라이언트가 보유한 코드 목록을 화이트리스트로 전달
  // codes 파라미터가 존재하면 유효 코드가 0개여도 빈 배열로 적용해 "결과 없음"을 보장한다.
  const codesRaw = sp.get('codes')
  if (codesRaw != null) {
    const codes = codesRaw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => /^\d{6}$/.test(s))
      .slice(0, 1000)
    filters.codes = codes.length ? codes : []
  }

  const sortRaw = (sp.get('sort') || 'marketCap') as SortKey
  const sort: SortKey = SORT_KEYS.includes(sortRaw) ? sortRaw : 'marketCap'
  const dir = sp.get('dir') === 'asc' ? 'asc' : 'desc'

  const page = Math.max(1, Number(sp.get('page') || 1) || 1)
  const pageSize = Math.min(200, Math.max(10, Number(sp.get('pageSize') || 50) || 50))

  const filtered = filterStocks(DATA.stocks as Stock[], filters)
  const sorted = sortStocks(filtered, sort, dir)

  const total = sorted.length
  const start = (page - 1) * pageSize
  const rows = sorted.slice(start, start + pageSize)

  return c.json({
    total,
    page,
    pageSize,
    pageCount: Math.max(1, Math.ceil(total / pageSize)),
    sort,
    dir,
    stats: computeStats(filtered),
    facets: industryFacets(filtered).slice(0, 40),
    rows,
    meta: {
      collectedAt: DATA.meta.collectedAt,
      stockUniverse: DATA.meta.stockCount,
    },
  })
})

/** 단일 종목 요약 (스냅샷 기준) */
app.get('/api/stock/:code', (c) => {
  const code = c.req.param('code')
  const s = (DATA.stocks as Stock[]).find((x) => x.code === code)
  if (!s) return c.json({ error: 'not found' }, 404)
  return c.json(s)
})

/**
 * 단일 종목 실시간 상세 (네이버 금융 직접 조회)
 * - 스냅샷은 빌드 시점이므로, 개별 종목은 실시간으로 갱신할 수 있게 한다.
 * - 서브리퀘스트 2회만 사용하므로 Workers 제한 내에서 안전.
 */
const liveCache = new Map<string, { at: number; payload: unknown }>()
const LIVE_TTL = 120_000

app.get('/api/stock/:code/live', async (c) => {
  const code = c.req.param('code')
  if (!/^\d{6}$/.test(code)) return c.json({ error: 'invalid code' }, 400)

  const cached = liveCache.get(code)
  if (cached && Date.now() - cached.at < LIVE_TTL) {
    return c.json({ ...(cached.payload as object), cached: true })
  }

  const headers = {
    'User-Agent': UA,
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'ko-KR,ko;q=0.9',
    Referer: 'https://m.stock.naver.com/',
  }

  const [intRes, finRes] = await Promise.all([
    fetch(`https://m.stock.naver.com/api/stock/${code}/integration`, { headers }).catch(() => null),
    fetch(`https://m.stock.naver.com/api/stock/${code}/finance/annual`, { headers }).catch(() => null),
  ])

  const intJson: any = intRes && intRes.ok ? await intRes.json().catch(() => null) : null
  const finJson: any = finRes && finRes.ok ? await finRes.json().catch(() => null) : null

  const infos: Record<string, any> = {}
  for (const i of intJson?.totalInfos || []) infos[i.code] = i

  const strip = (v: string | undefined) =>
    v == null ? null : Number(String(v).replace(/,/g, '').replace(/%|배|원/g, '').trim()) || 0

  // 재무 시계열
  let finance: any = null
  const info = finJson?.financeInfo
  if (info?.trTitleList && info?.rowList) {
    const actual = info.trTitleList.filter((t: any) => t.isConsensus !== 'Y')
    const byTitle = new Map<string, any>(info.rowList.map((r: any) => [r.title, r.columns || {}]))
    const series = (title: string) => {
      const cols = byTitle.get(title)
      if (!cols) return []
      return actual.map((t: any) => {
        const raw = cols[t.key]?.value
        const n = raw == null || raw === '-' ? null : Number(String(raw).replace(/,/g, ''))
        return Number.isFinite(n as number) ? n : null
      })
    }
    finance = {
      years: actual.map((t: any) => t.title),
      revenue: series('매출액'),
      opIncome: series('영업이익'),
      netIncome: series('당기순이익'),
      opMargin: series('영업이익률'),
      debtRatio: series('부채비율'),
      roe: series('ROE'),
      per: series('PER'),
      pbr: series('PBR'),
      eps: series('EPS'),
      dps: series('주당배당금'),
    }
  }

  const payload = {
    code,
    name: intJson?.stockName || null,
    price: strip(infos.closePrice?.value ?? infos.lastClosePrice?.value),
    per: strip(infos.per?.value),
    pbr: strip(infos.pbr?.value),
    eps: strip(infos.eps?.value),
    bps: strip(infos.bps?.value),
    divYield: strip(infos.dividendYieldRatio?.value),
    dps: strip(infos.dividend?.value),
    foreignRate: strip(infos.foreignRate?.value),
    high52w: strip(infos.highPriceOf52Weeks?.value),
    low52w: strip(infos.lowPriceOf52Weeks?.value),
    marketCapText: infos.marketValue?.value || null,
    finance,
    fetchedAt: new Date().toISOString(),
  }

  liveCache.set(code, { at: Date.now(), payload })
  return c.json(payload)
})

/** 헬스체크 */
app.get('/api/health', (c) =>
  c.json({ ok: true, stocks: DATA.meta.stockCount, collectedAt: DATA.meta.collectedAt })
)

/* ------------------------------------------------------------------ */
/* 페이지                                                             */
/* ------------------------------------------------------------------ */

app.get('/', (c) => c.html(<Page meta={DATA.meta} />))

export default app
