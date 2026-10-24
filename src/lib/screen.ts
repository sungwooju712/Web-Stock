/**
 * 스크리닝 로직 (순수 함수)
 * - Cloudflare Workers 런타임에서도 안전하게 실행되도록 외부 의존성 없음
 */

export interface Stock {
  code: string
  name: string
  price: number | null
  change: number | null
  changeRate: number | null
  marketCap: number | null // 억원
  volume: number | null
  isPreferred: boolean
  industry: string | null
  revenue: number | null // 억원
  opIncome: number | null
  netIncome: number | null
  opMargin: number | null // %
  netMargin: number | null // %
  roe: number | null // %
  debtRatio: number | null // %
  reserveRatio: number | null
  revenueCagr: number | null // %
  opIncomeYoY: number | null // %
  finYear: string | null
  per: number | null
  pbr: number | null
  divYield: number | null // %
  foreignRate: number | null // %
  pos52: number | null // 0~100
}

export interface Filters {
  q?: string
  marketCapMin?: number | null
  marketCapMax?: number | null
  debtRatioMax?: number | null
  opMarginMin?: number | null
  perMin?: number | null
  perMax?: number | null
  revenueMin?: number | null
  roeMin?: number | null
  pbrMax?: number | null
  divYieldMin?: number | null
  revenueGrowthMin?: number | null
  industry?: string | null
  excludePreferred?: boolean
  /** 코드 화이트리스트 (즐겨찾기만 보기 등). 비어있으면 미적용 */
  codes?: string[] | null
}

export type SortKey =
  | 'marketCap'
  | 'per'
  | 'pbr'
  | 'opMargin'
  | 'debtRatio'
  | 'roe'
  | 'divYield'
  | 'revenue'
  | 'revenueCagr'
  | 'changeRate'
  | 'price'
  | 'name'

/**
 * 조건 통과 여부.
 * 주의: 값이 null(데이터 없음)인 지표에 대해 "최소값" 조건이 걸려 있으면
 *       통과시키지 않는다. 없는 데이터를 통과시키면 스크리너가 거짓말을 한다.
 *       단, 최대값 조건(debtRatioMax 등)은 null 을 "알 수 없음"으로 보고 제외한다.
 */
export function passes(s: Stock, f: Filters): boolean {
  if (f.excludePreferred && s.isPreferred) return false

  // 화이트리스트가 지정되면(null 이 아닌 배열) 그 안에 있어야 통과.
  // 빈 배열이면 "해당 없음"을 의미하므로 아무것도 통과하지 않는다.
  if (f.codes != null) {
    if (f.codes.indexOf(s.code) === -1) return false
  }

  if (f.q) {
    const q = f.q.trim().toLowerCase()
    if (q) {
      const hit =
        s.name.toLowerCase().includes(q) ||
        s.code.includes(q) ||
        (s.industry ? s.industry.toLowerCase().includes(q) : false)
      if (!hit) return false
    }
  }

  if (f.industry && s.industry !== f.industry) return false

  // 시가총액 (억원)
  if (f.marketCapMin != null) {
    if (s.marketCap == null || s.marketCap < f.marketCapMin) return false
  }
  if (f.marketCapMax != null) {
    if (s.marketCap == null || s.marketCap > f.marketCapMax) return false
  }

  // 부채비율 상한
  if (f.debtRatioMax != null) {
    if (s.debtRatio == null || s.debtRatio > f.debtRatioMax) return false
  }

  // 영업이익률 하한
  if (f.opMarginMin != null) {
    if (s.opMargin == null || s.opMargin < f.opMarginMin) return false
  }

  // PER 구간
  if (f.perMin != null) {
    if (s.per == null || s.per < f.perMin) return false
  }
  if (f.perMax != null) {
    if (s.per == null || s.per > f.perMax) return false
  }

  // 매출액 하한
  if (f.revenueMin != null) {
    if (s.revenue == null || s.revenue < f.revenueMin) return false
  }

  // ROE 하한
  if (f.roeMin != null) {
    if (s.roe == null || s.roe < f.roeMin) return false
  }

  // PBR 상한
  if (f.pbrMax != null) {
    if (s.pbr == null || s.pbr > f.pbrMax) return false
  }

  // 배당수익률 하한
  if (f.divYieldMin != null) {
    if (s.divYield == null || s.divYield < f.divYieldMin) return false
  }

  // 매출 성장률(CAGR) 하한
  if (f.revenueGrowthMin != null) {
    if (s.revenueCagr == null || s.revenueCagr < f.revenueGrowthMin) return false
  }

  return true
}

export function filterStocks(stocks: Stock[], f: Filters): Stock[] {
  return stocks.filter((s) => passes(s, f))
}

export function sortStocks(stocks: Stock[], key: SortKey, dir: 'asc' | 'desc'): Stock[] {
  const sign = dir === 'asc' ? 1 : -1
  const copy = stocks.slice()
  copy.sort((a, b) => {
    if (key === 'name') return sign * a.name.localeCompare(b.name, 'ko')
    const av = a[key] as number | null
    const bv = b[key] as number | null
    // null 은 항상 뒤로
    if (av == null && bv == null) return 0
    if (av == null) return 1
    if (bv == null) return -1
    return sign * (av - bv)
  })
  return copy
}

function median(nums: number[]): number | null {
  if (!nums.length) return null
  const s = nums.slice().sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

function avg(nums: number[]): number | null {
  if (!nums.length) return null
  return nums.reduce((a, b) => a + b, 0) / nums.length
}

const round = (v: number | null, d = 2): number | null =>
  v == null ? null : Number(v.toFixed(d))

export interface Stats {
  count: number
  medianPer: number | null
  medianPbr: number | null
  avgDebtRatio: number | null
  medianOpMargin: number | null
  avgDivYield: number | null
  totalMarketCap: number | null
}

export function computeStats(list: Stock[]): Stats {
  const pick = (k: keyof Stock) =>
    list.map((s) => s[k] as number | null).filter((v): v is number => v != null)

  return {
    count: list.length,
    medianPer: round(median(pick('per'))),
    medianPbr: round(median(pick('pbr'))),
    avgDebtRatio: round(avg(pick('debtRatio'))),
    medianOpMargin: round(median(pick('opMargin'))),
    avgDivYield: round(avg(pick('divYield'))),
    totalMarketCap: round(
      pick('marketCap').reduce((a, b) => a + b, 0),
      0
    ),
  }
}

/** 업종별 종목 수 집계 (필터된 결과 기준) */
export function industryFacets(list: Stock[]): { industry: string; count: number }[] {
  const m = new Map<string, number>()
  for (const s of list) {
    if (!s.industry) continue
    m.set(s.industry, (m.get(s.industry) || 0) + 1)
  }
  return [...m.entries()]
    .map(([industry, count]) => ({ industry, count }))
    .sort((a, b) => b.count - a.count)
}

/** 쿼리스트링 → Filters 파싱 */
export function parseFilters(sp: URLSearchParams): Filters {
  const n = (k: string): number | null => {
    const v = sp.get(k)
    if (v == null || v.trim() === '') return null
    const x = Number(v)
    return Number.isFinite(x) ? x : null
  }
  return {
    q: sp.get('q') || undefined,
    marketCapMin: n('marketCapMin'),
    marketCapMax: n('marketCapMax'),
    debtRatioMax: n('debtRatioMax'),
    opMarginMin: n('opMarginMin'),
    perMin: n('perMin'),
    perMax: n('perMax'),
    revenueMin: n('revenueMin'),
    roeMin: n('roeMin'),
    pbrMax: n('pbrMax'),
    divYieldMin: n('divYieldMin'),
    revenueGrowthMin: n('revenueGrowthMin'),
    industry: sp.get('industry') || null,
    excludePreferred: sp.get('excludePreferred') === '1',
  }
}
