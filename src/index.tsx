import { Hono } from 'hono'
import { cors } from 'hono/cors'
import snapshot from './data/snapshot.json'
import prices from './data/prices.json'
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

// 코스피 전용 가드.
// 수집기가 이미 sosok=0 만 남기지만, 스냅샷이 오염되거나 수동 편집되어도
// 코스닥/코넥스 종목이 화면에 노출되지 않도록 런타임에서 한 번 더 걸러낸다.
const KOSPI_STOCKS: Stock[] = (DATA.stocks as (Stock & { market?: string })[]).filter(
  (s) => s.market == null || s.market === 'KOSPI'
)

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
  // 분기 실적 정렬
  'qRevenue',
  'qOpIncome',
  'qOpMargin',
  'qYoY',
  'qQoQ',
  'qOpYoY',
  'opPositiveStreak',
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

  const filtered = filterStocks(KOSPI_STOCKS, filters)
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
  const s = KOSPI_STOCKS.find((x) => x.code === code)
  if (!s) return c.json({ error: 'not found' }, 404)
  return c.json(s)
})

/**
 * 종목명 인덱스 (분석 뷰의 종목 추가 자동완성용)
 * 942종목 × [코드, 이름] 배열 = 약 20KB. 입력창 포커스 시 지연 로드한다.
 */
app.get('/api/stocks/names', (c) => {
  const rows = KOSPI_STOCKS.map((s) => [s.code, s.name])
  return c.json({ count: rows.length, rows })
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
/* 주요 종목 분석 (종가 시계열)                                        */
/* ------------------------------------------------------------------ */

type PriceMeta = {
  source: string
  collectedAt: string
  start: string | null
  end: string | null
  tradingDays: number
  codes: string[]
  note: string
}
type PriceStock = { code: string; name: string }
type DailyRow = { date: string; c: Record<string, number | null> }
type MonthlyRow = { ym: string; c: Record<string, number | null>; r: Record<string, number | null> }
type AnnualRow = { year: string; c: Record<string, number | null>; r: Record<string, number | null> }
type PeriodStat = {
  closeHigh: number | null
  closeHighDate: string | null
  closeLow: number | null
  closeLowDate: string | null
  high: number | null
  highDate: string | null
}

const PRICES = prices as unknown as {
  meta: PriceMeta
  stocks: PriceStock[]
  daily: DailyRow[]
  monthly: MonthlyRow[]
  annual: AnnualRow[]
  period: Record<string, PeriodStat>
}

/**
 * 주요 종목 분석 요약 (차트용 경량 데이터)
 * daily 는 928행이라 기본 응답에서 제외하고 /api/prices/daily 로 분리한다.
 */
app.get('/api/prices', (c) => {
  const { stocks, monthly, annual, period, meta } = PRICES

  // 최신 종가 기준 파생 지표
  const latest = PRICES.daily[PRICES.daily.length - 1]
  const rows = stocks.map((s) => {
    const code = s.code
    const periodStat = period[code] || null
    // 2023년 말 종가 (첫 연간 행의 종가)
    const y2023 = annual.find((a) => a.year === '2023')
    const y2025 = annual.find((a) => a.year === '2025')
    const y2026 = annual.find((a) => a.year === '2026')
    const last = latest?.c[code] ?? null
    const base2023 = y2023?.c[code] ?? null
    const base2025 = y2025?.c[code] ?? null

    const ratio = (cur: number | null, base: number | null) =>
      cur != null && base != null && base !== 0 ? Number((((cur - base) / base) * 100).toFixed(2)) : null

    return {
      code,
      name: s.name,
      last,
      lastDate: latest?.date ?? null,
      // 엑셀 한장보고와 동일한 지표 구성
      vs2023Pct: ratio(last, base2023),
      vs2025Pct: ratio(last, base2025),
      y2026Pct: y2026?.r[code] == null ? null : Number((y2026.r[code]! * 100).toFixed(2)),
      closeHigh: periodStat?.closeHigh ?? null,
      closeHighDate: periodStat?.closeHighDate ?? null,
      closeLow: periodStat?.closeLow ?? null,
      highIntraday: periodStat?.high ?? null,
      highIntradayDate: periodStat?.highDate ?? null,
    }
  })

  return c.json({
    meta,
    stocks,
    summary: rows,
    monthly,
    annual,
    // 종목 추가/삭제 시 클라이언트가 기간 최고·최저를 그대로 재사용한다
    period,
  })
})

/* ------------------------------------------------------------------ */
/* 종목 추가 — 임의 코스피 종목 종가 런타임 수집                       */
/* ------------------------------------------------------------------ */

const PRICE_STOCK_TTL = 3_600_000 // 1시간
const PRICE_STOCK_CACHE_MAX = 40
const priceStockCache = new Map<string, { at: number; payload: any }>()

function todayCompact(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`
}

/**
 * 네이버 siseJson 은 작은따옴표 + 공백/탭이 섞인 JSON 이다.
 * 헤더 행([날짜,시가,고가,저가,종가,거래량,외국인소진율])은 버린다.
 */
function parseSiseJson(text: string) {
  const cleaned = text.trim().replace(/'/g, '"')
  const rows = JSON.parse(cleaned)
  const out: { date: string; high: number; close: number }[] = []
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i]
    if (!Array.isArray(r) || r.length < 5) continue
    const rawDate = String(r[0])
    if (rawDate.length !== 8) continue
    const close = Number(r[4])
    if (!Number.isFinite(close)) continue
    out.push({
      date: `${rawDate.slice(0, 4)}-${rawDate.slice(4, 6)}-${rawDate.slice(6, 8)}`,
      high: Number(r[2]),
      close,
    })
  }
  return out
}

/**
 * 종목 추가용 종가 시계열 조회
 *   GET /api/prices/stock/:code
 *
 * 설계 메모
 *  - KOSPI_STOCKS 스냅샷 화이트리스트에 있는 종목만 허용한다.
 *    이로써 코스피 전용 가드가 수집기 2겹 + 런타임 1겹 + 이 엔드포인트 1겹으로 총 4겹이 된다.
 *    스냅샷에 없는 코드(코스닥·코넥스·ETF)는 400 으로 거부된다.
 *  - 일별 종가는 기존 prices.json 의 거래일 축(928일)에 그대로 정렬해 내려준다.
 *    클라이언트가 인덱스만 맞추면 되므로 병합 로직이 단순해진다.
 *  - 네이버 서브리퀘스트 1회. 결과는 1시간 메모리 캐시 (Workers isolate 단위).
 */
app.get('/api/prices/stock/:code', async (c) => {
  const code = c.req.param('code')
  if (!/^\d{6}$/.test(code)) return c.json({ error: 'invalid code' }, 400)

  const target = KOSPI_STOCKS.find((s) => s.code === code)
  if (!target) {
    return c.json(
      { error: 'not_kospi', message: '코스피 종목이 아닙니다. 이 화면은 코스피 전용입니다.' },
      400
    )
  }

  const cached = priceStockCache.get(code)
  if (cached && Date.now() - cached.at < PRICE_STOCK_TTL) {
    return c.json({ ...(cached.payload as object), cached: true })
  }

  const start = (PRICES.meta.start || '2023-01-02').replace(/-/g, '')
  const url =
    `https://api.finance.naver.com/siseJson.naver?symbol=${code}` +
    `&requestType=1&startTime=${start}&endTime=${todayCompact()}&timeframe=day`

  let text: string
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': UA,
        Accept: 'application/json, text/plain, */*',
        'Accept-Language': 'ko-KR,ko;q=0.9',
        Referer: 'https://finance.naver.com/',
      },
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    text = await res.text()
  } catch (e) {
    return c.json({ error: 'upstream_failed', detail: String(e) }, 502)
  }

  let rows: { date: string; high: number; close: number }[]
  try {
    rows = parseSiseJson(text)
  } catch (e) {
    return c.json({ error: 'parse_failed', detail: String(e) }, 502)
  }

  if (!rows.length) {
    return c.json(
      { error: 'no_data', message: '해당 종목의 종가 데이터가 없습니다(거래정지·상장폐지 등).' },
      404
    )
  }

  const closeMap = new Map<string, number>()
  const highMap = new Map<string, number>()
  for (const r of rows) {
    closeMap.set(r.date, r.close)
    highMap.set(r.date, r.high)
  }

  // 기존 거래일 축에 정렬
  const closes: (number | null)[] = PRICES.daily.map((d) => {
    const v = closeMap.get(d.date)
    return v == null || !Number.isFinite(v) ? null : v
  })

  // 월별: 각 월의 마지막 비결측 종가
  const monthLast: Record<string, number | null> = {}
  for (let i = 0; i < PRICES.daily.length; i++) {
    const ym = PRICES.daily[i].date.slice(0, 7)
    const v = closes[i]
    if (v != null) monthLast[ym] = v
    else if (!(ym in monthLast)) monthLast[ym] = null
  }
  const monthly: Record<string, number | null> = {}
  for (const m of PRICES.monthly) {
    monthly[m.ym] = monthLast[m.ym] ?? null
  }

  // 연간: 각 연도의 마지막 비결측 종가
  const yearLast: Record<string, number | null> = {}
  for (let i = 0; i < PRICES.daily.length; i++) {
    const y = PRICES.daily[i].date.slice(0, 4)
    const v = closes[i]
    if (v != null) yearLast[y] = v
    else if (!(y in yearLast)) yearLast[y] = null
  }
  const annual: Record<string, number | null> = {}
  for (const a of PRICES.annual) {
    annual[a.year] = yearLast[a.year] ?? null
  }

  // 기간 최고/최저 (종가 기준) + 장중 최고가
  let closeHigh: number | null = null
  let closeHighDate: string | null = null
  let closeLow: number | null = null
  let closeLowDate: string | null = null
  let highIntraday: number | null = null
  let highIntradayDate: string | null = null
  for (let i = 0; i < PRICES.daily.length; i++) {
    const d = PRICES.daily[i].date
    const v = closes[i]
    if (v != null) {
      if (closeHigh == null || v > closeHigh) {
        closeHigh = v
        closeHighDate = d
      }
      if (closeLow == null || v < closeLow) {
        closeLow = v
        closeLowDate = d
      }
    }
    const h = highMap.get(d)
    if (h != null && Number.isFinite(h)) {
      if (highIntraday == null || h > highIntraday) {
        highIntraday = h
        highIntradayDate = d
      }
    }
  }

  const payload = {
    code,
    name: target.name,
    industry: target.industry ?? null,
    isPreferred: target.isPreferred ?? false,
    startDate: rows[0]?.date ?? null,
    endDate: rows[rows.length - 1]?.date ?? null,
    dataDays: rows.length,
    closes,
    monthly,
    annual,
    period: {
      closeHigh,
      closeHighDate,
      closeLow,
      closeLowDate,
      highIntraday,
      highIntradayDate,
    },
    fetchedAt: new Date().toISOString(),
  }

  // 캐시 (오래된 것부터 정리)
  if (priceStockCache.size >= PRICE_STOCK_CACHE_MAX) {
    const oldest = [...priceStockCache.entries()].sort((a, b) => a[1].at - b[1].at)[0]
    if (oldest) priceStockCache.delete(oldest[0])
  }
  priceStockCache.set(code, { at: Date.now(), payload })

  return c.json(payload)
})

/** 일별 종가 시계열 (기간 필터 지원) */
app.get('/api/prices/daily', (c) => {
  const sp = new URL(c.req.url).searchParams
  const from = sp.get('from')
  const to = sp.get('to')
  const step = Math.max(1, Math.min(30, Number(sp.get('step') || 1) || 1))

  let rows = PRICES.daily
  if (from) rows = rows.filter((r) => r.date >= from)
  if (to) rows = rows.filter((r) => r.date <= to)
  // step: 차트 렌더링 부담을 줄이기 위한 샘플링
  if (step > 1) rows = rows.filter((_, i) => i % step === 0 || i === rows.length - 1)

  return c.json({
    codes: PRICES.meta.codes,
    stocks: PRICES.stocks,
    from: rows[0]?.date ?? null,
    to: rows[rows.length - 1]?.date ?? null,
    count: rows.length,
    rows,
  })
})

/* ------------------------------------------------------------------ */
/* 페이지                                                             */
/* ------------------------------------------------------------------ */

app.get('/', (c) =>
  c.html(
    <Page
      meta={DATA.meta}
      prices={{
        collectedAt: PRICES.meta.collectedAt,
        tradingDays: PRICES.meta.tradingDays,
        start: PRICES.meta.start,
        end: PRICES.meta.end,
      }}
    />
  )
)

export default app
