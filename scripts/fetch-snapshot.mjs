#!/usr/bin/env node
/**
 * 코스피 스크리너 스냅샷 수집기
 *
 * 데이터 출처: 네이버 금융 모바일 API (m.stock.naver.com)
 *  - 종목 목록/시총/현재가 : /api/stocks/marketValue/KOSPI
 *  - 업종 분류            : /api/stocks/industry
 *  - 재무제표(연간)        : /api/stock/{code}/finance/annual
 *  - 현재 투자지표         : /api/stock/{code}/integration
 *
 * 왜 빌드타임인가:
 *  Cloudflare Workers는 요청당 서브리퀘스트 50개 제한. 942종목 × 2콜은
 *  런타임에서 절대 불가능. 그래서 빌드 시점에 스냅샷을 만들어 번들에 넣는다.
 *
 * 사용법:
 *   node scripts/fetch-snapshot.mjs            # 전체
 *   node scripts/fetch-snapshot.mjs --limit 50 # 앞 50종목만 (테스트)
 */

import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const OUT = resolve(ROOT, 'src/data/snapshot.json')
const CACHE_DIR = resolve(ROOT, '.cache')

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

const args = process.argv.slice(2)
const LIMIT = (() => {
  const i = args.indexOf('--limit')
  return i >= 0 ? Number(args[i + 1]) || 0 : 0
})()
const CONCURRENCY = 12
const TIMEOUT_MS = 20000

/* ------------------------------------------------------------------ */
/* 유틸                                                               */
/* ------------------------------------------------------------------ */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function num(v) {
  if (v == null) return null
  const s = String(v).trim()
  if (!s || s === '-' || s === 'N/A' || s === 'n/a') return null
  const cleaned = s.replace(/,/g, '').replace(/%|배|원|억/g, '').trim()
  const n = Number(cleaned)
  return Number.isFinite(n) ? n : null
}

async function getJSON(url, { retries = 3 } = {}) {
  let lastErr
  for (let attempt = 1; attempt <= retries; attempt++) {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), TIMEOUT_MS)
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': UA,
          Accept: 'application/json, text/plain, */*',
          'Accept-Language': 'ko-KR,ko;q=0.9',
          Referer: 'https://m.stock.naver.com/',
        },
        signal: ac.signal,
      })
      clearTimeout(timer)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const text = await res.text()
      if (!text.trim().startsWith('{')) throw new Error('non-JSON response')
      return JSON.parse(text)
    } catch (e) {
      clearTimeout(timer)
      lastErr = e
      if (attempt < retries) await sleep(250 * attempt + Math.random() * 200)
    }
  }
  throw lastErr
}

/** 동시성 제한 풀 */
async function pool(items, limit, worker, onProgress) {
  const results = new Array(items.length)
  let cursor = 0
  let done = 0
  async function run() {
    while (true) {
      const i = cursor++
      if (i >= items.length) return
      try {
        results[i] = await worker(items[i], i)
      } catch (e) {
        results[i] = { __error: String(e && e.message ? e.message : e) }
      }
      done++
      if (onProgress && (done % 25 === 0 || done === items.length)) {
        onProgress(done, items.length)
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run))
  return results
}

/* ------------------------------------------------------------------ */
/* 1. 코스피 종목 목록                                                 */
/* ------------------------------------------------------------------ */

async function fetchStockList() {
  const pageSize = 100
  const first = await getJSON(
    `https://m.stock.naver.com/api/stocks/marketValue/KOSPI?page=1&pageSize=${pageSize}`
  )
  const totalCount = first.totalCount || 0
  const pages = Math.ceil(totalCount / pageSize)
  console.error(`  총 ${totalCount}행 / ${pages}페이지`)

  const rows = [...(first.stocks || [])]
  // 나머지 페이지 병렬 수집
  const rest = []
  for (let p = 2; p <= pages; p++) rest.push(p)
  const chunks = []
  for (let i = 0; i < rest.length; i += 6) chunks.push(rest.slice(i, i + 6))
  for (const chunk of chunks) {
    const got = await Promise.all(
      chunk.map((p) =>
        getJSON(
          `https://m.stock.naver.com/api/stocks/marketValue/KOSPI?page=${p}&pageSize=${pageSize}`
        ).catch(() => ({ stocks: [] }))
      )
    )
    for (const g of got) rows.push(...(g.stocks || []))
    await sleep(120)
  }
  return { rows, totalCount }
}

/* ------------------------------------------------------------------ */
/* 2. 업종 매핑                                                        */
/* ------------------------------------------------------------------ */

async function fetchIndustryMap() {
  const map = new Map() // itemCode -> { industry, industryNo }
  let groups = []
  try {
    const g = await getJSON('https://m.stock.naver.com/api/stocks/industry?page=1&pageSize=100')
    groups = g.groups || []
  } catch (e) {
    console.error('  업종 목록 실패:', e.message)
    return map
  }
  console.error(`  업종 그룹 ${groups.length}개`)

  for (const grp of groups) {
    if (grp.no === 25) continue // '기타' 1555건 - 노이즈, 건너뜀
    const pageSize = 100
    const pages = Math.max(1, Math.ceil((grp.totalCount || 1) / pageSize))
    for (let p = 1; p <= pages; p++) {
      try {
        const d = await getJSON(
          `https://m.stock.naver.com/api/stocks/industry/${grp.no}?page=${p}&pageSize=${pageSize}`
        )
        for (const s of d.stocks || []) {
          // 이미 배정된 종목은 첫 업종 유지
          if (!map.has(s.itemCode)) {
            map.set(s.itemCode, { industry: grp.name, industryNo: grp.no })
          }
        }
        if ((d.stocks || []).length < pageSize) break
      } catch {
        break
      }
      await sleep(60)
    }
  }
  return map
}

/* ------------------------------------------------------------------ */
/* 3. 종목별 재무 + 현재지표                                           */
/* ------------------------------------------------------------------ */

const PICK_ROWS = {
  매출액: 'revenue',
  영업이익: 'opIncome',
  당기순이익: 'netIncome',
  영업이익률: 'opMargin',
  순이익률: 'netMargin',
  ROE: 'roe',
  부채비율: 'debtRatio',
  유보율: 'reserveRatio',
  당좌비율: 'currentRatio',
  EPS: 'eps',
  PER: 'perFin',
  BPS: 'bps',
  PBR: 'pbrFin',
  주당배당금: 'dps',
}

function parseFinance(json) {
  const info = json?.financeInfo
  if (!info || !Array.isArray(info.trTitleList) || !Array.isArray(info.rowList)) return null

  // 실제(확정) 연도만 — 컨센서스(isConsensus='Y') 제외
  const actual = info.trTitleList.filter((t) => t.isConsensus !== 'Y')
  if (!actual.length) return null

  const out = { years: actual.map((t) => t.key) }
  const byTitle = new Map(info.rowList.map((r) => [r.title, r.columns || {}]))

  for (const [title, key] of Object.entries(PICK_ROWS)) {
    const cols = byTitle.get(title)
    if (!cols) {
      out[key] = null
      out[key + 'Series'] = []
      continue
    }
    const series = actual.map((t) => num(cols[t.key]?.value))
    out[key] = series.length ? series[series.length - 1] : null
    out[key + 'Series'] = series
  }

  // 3년 매출 CAGR (실제 연도 기준, 첫/끝)
  const rev = out.revenueSeries
  if (rev && rev.length >= 2) {
    const a = rev[0]
    const b = rev[rev.length - 1]
    if (a > 0 && b > 0 && rev.length > 1) {
      const yrs = rev.length - 1
      out.revenueCagr = Number(((Math.pow(b / a, 1 / yrs) - 1) * 100).toFixed(2))
    } else out.revenueCagr = null
  } else out.revenueCagr = null

  // 최근 영업이익 흑자 전환 여부 등 보조
  const op = out.opIncomeSeries || []
  out.opIncomeYoY =
    op.length >= 2 && op[op.length - 2] != null && op[op.length - 2] !== 0
      ? Number((((op[op.length - 1] - op[op.length - 2]) / Math.abs(op[op.length - 2])) * 100).toFixed(2))
      : null

  return out
}

function parseIntegration(json) {
  const out = {}
  for (const info of json?.totalInfos || []) {
    out[info.code] = info.value
  }
  return {
    per: num(out.per),
    pbr: num(out.pbr),
    eps: num(out.eps),
    bps: num(out.bps),
    divYield: num(out.dividendYieldRatio),
    dps: num(out.dividend),
    foreignRate: num(out.foreignRate),
    high52w: num(out.highPriceOf52Weeks),
    low52w: num(out.lowPriceOf52Weeks),
    cnsPer: num(out.cnsPer),
  }
}

/* ------------------------------------------------------------------ */
/* 분기 실적 파서                                                      */
/* ------------------------------------------------------------------ */

/**
 * 네이버 finance/quarter 응답을 파싱한다.
 *
 * ⚠ 검증된 사실 (2026-10-24 실측):
 *   이 API 의 분기 값은 **누적이 아니라 단일분기** 값이다.
 *   삼성전자 2025 연간 매출 3,336,059억 vs 분기 202512 값 938,374억 →
 *   938,374 + 860,617 + 745,663 + Q1(791,405) = 3,336,059 로 정확히 일치.
 *   만약 누적으로 착각하고 차분을 취하면 QoQ/YoY 가 전부 틀어진다.
 *
 * 확정 실적만 사용한다 (isConsensus === 'Y' 제외).
 */
function parseQuarter(json) {
  const info = json?.financeInfo
  if (!info || !Array.isArray(info.trTitleList) || !Array.isArray(info.rowList)) return null

  const actual = info.trTitleList.filter((t) => t.isConsensus !== 'Y')
  if (!actual.length) return null

  const keys = actual.map((t) => t.key) // 예: ['202506','202509','202512','202603','202606']
  const labels = keys.map((k) =>
    k.length === 6 ? `${k.slice(0, 4)}.${k.slice(4)}` : k
  )

  const byTitle = new Map(info.rowList.map((r) => [r.title, r.columns || {}]))
  const seriesOf = (title) => {
    const cols = byTitle.get(title)
    if (!cols) return keys.map(() => null)
    return keys.map((k) => num(cols[k]?.value))
  }

  const revenue = seriesOf('매출액')
  const opIncome = seriesOf('영업이익')
  const netIncome = seriesOf('당기순이익')
  const opMargin = seriesOf('영업이익률')

  const last = keys.length - 1
  const lastKey = keys[last]

  // 전년 동기 키: 연도만 -1 (202606 → 202506)
  const yoyKey = String(Number(lastKey.slice(0, 4)) - 1) + lastKey.slice(4)
  const idxByKey = new Map(keys.map((k, i) => [k, i]))
  const yoyIdx = idxByKey.has(yoyKey) ? idxByKey.get(yoyKey) : -1

  const growth = (cur, prev) => {
    if (cur == null || prev == null || prev === 0) return null
    return Number((((cur - prev) / Math.abs(prev)) * 100).toFixed(2))
  }

  // 직전 분기 대비 (QoQ)
  const qQoQ = last >= 1 ? growth(revenue[last], revenue[last - 1]) : null
  const qOpQoQ = last >= 1 ? growth(opIncome[last], opIncome[last - 1]) : null

  // 전년 동기 대비 (YoY)
  const qYoY = yoyIdx >= 0 ? growth(revenue[last], revenue[yoyIdx]) : null
  const qOpYoY = yoyIdx >= 0 ? growth(opIncome[last], opIncome[yoyIdx]) : null

  // 영업이익 흑자 연속 분기수 (최근부터 역산)
  let opPositiveStreak = 0
  for (let i = last; i >= 0; i--) {
    if (opIncome[i] != null && opIncome[i] > 0) opPositiveStreak++
    else break
  }

  // 영업이익 연속 증가 분기수 (최근부터 역산, 2분기 이상 비교)
  let opImproveStreak = 0
  for (let i = last; i >= 1; i--) {
    if (opIncome[i] != null && opIncome[i - 1] != null && opIncome[i] > opIncome[i - 1]) {
      opImproveStreak++
    } else break
  }

  return {
    quarters: labels,
    qRevenueSeries: revenue,
    qOpIncomeSeries: opIncome,
    qNetIncomeSeries: netIncome,
    qOpMarginSeries: opMargin,

    quarterLabel: labels[last] || null,
    qRevenue: revenue[last] ?? null,
    qOpIncome: opIncome[last] ?? null,
    qNetIncome: netIncome[last] ?? null,
    qOpMargin: opMargin[last] ?? null,

    qQoQ,
    qYoY,
    qOpQoQ,
    qOpYoY,
    opPositiveStreak,
    opImproveStreak,
  }
}

async function fetchOne(stock) {
  const code = stock.itemCode
  const [finRes, qtrRes, intRes] = await Promise.all([
    getJSON(`https://m.stock.naver.com/api/stock/${code}/finance/annual`).catch(() => null),
    getJSON(`https://m.stock.naver.com/api/stock/${code}/finance/quarter`).catch(() => null),
    getJSON(`https://m.stock.naver.com/api/stock/${code}/integration`).catch(() => null),
  ])
  const fin = finRes ? parseFinance(finRes) : null
  const qtr = qtrRes ? parseQuarter(qtrRes) : null
  const cur = intRes ? parseIntegration(intRes) : {}
  return { fin, qtr, cur }
}

/* ------------------------------------------------------------------ */
/* 메인                                                               */
/* ------------------------------------------------------------------ */

async function main() {
  const t0 = Date.now()
  console.error('■ 1) 코스피 종목 목록 수집')
  const { rows, totalCount } = await fetchStockList()

  // 1차: 실주식만 (ETF/ETN/리츠 제외) — stockEndType === 'stock'
  const stocks = rows.filter((r) => r.stockEndType === 'stock')

  // 2차: 코스피 강제 검증.
  // 네이버 응답의 sosok 은 '0'=코스피, '1'=코스닥, '2'=코넥스.
  // 엔드포인트를 KOSPI 로 호출하고 있지만 응답을 신뢰하지 않고 명시적으로 재검증한다.
  // 코스닥/코넥스가 단 1건이라도 섞이면 조용히 넘기지 않고 즉시 중단한다.
  const nonKospi = stocks.filter((r) => r.sosok !== '0')
  if (nonKospi.length) {
    const sample = nonKospi.slice(0, 10).map((r) => `${r.itemCode} ${r.stockName}(sosok=${r.sosok})`)
    console.error(`✘ 코스피가 아닌 종목 ${nonKospi.length}건 발견: ${sample.join(', ')}`)
    console.error('  → 코스피 전용 스크리너이므로 수집을 중단합니다.')
    process.exit(1)
  }

  // 3차: 중복 제거
  const seen = new Set()
  const uniq = stocks.filter((s) => {
    if (seen.has(s.itemCode)) return false
    seen.add(s.itemCode)
    return true
  })
  console.error(`  실주식 ${uniq.length}종목 (전체 ${totalCount}행 중) · 코스피 검증 통과(sosok=0)`)

  console.error('■ 2) 업종 매핑 수집')
  const industryMap = await fetchIndustryMap()
  console.error(`  업종 배정 ${industryMap.size}종목`)

  const targets = LIMIT > 0 ? uniq.slice(0, LIMIT) : uniq
  console.error(`■ 3) 재무/현재지표 수집 (${targets.length}종목, 동시 ${CONCURRENCY})`)

  const detail = await pool(
    targets,
    CONCURRENCY,
    (s) => fetchOne(s),
    (d, t) => {
      const el = ((Date.now() - t0) / 1000).toFixed(0)
      console.error(`  ${d}/${t} (${el}s)`)
    }
  )

  const failed = detail.filter((d) => !d || d.__error).length
  if (failed) console.error(`  ⚠ 실패 ${failed}건`)

  console.error('■ 4) 레코드 조립')
  const records = targets.map((s, i) => {
    const d = detail[i] || {}
    const fin = d.fin || {}
    const qtr = d.qtr || {}
    const cur = d.cur || {}
    const price = num(s.closePrice)
    const marketCap = num(s.marketValue) // 억원

    // PER: 현재 PER(integration) 우선, 없으면 연간 재무 PER, 없으면 계산
    let per = cur.per
    if (per == null) per = fin.perFin
    if (per == null && cur.eps && cur.eps > 0 && price) per = Number((price / cur.eps).toFixed(2))
    if (per != null && per <= 0) per = null

    let pbr = cur.pbr
    if (pbr == null) pbr = fin.pbrFin

    let divYield = cur.divYield
    if (divYield == null && cur.dps && price) {
      divYield = Number(((cur.dps / price) * 100).toFixed(2))
    }
    if (divYield == null && fin.dps && price) {
      divYield = Number(((fin.dps / price) * 100).toFixed(2))
    }

    // 52주 위치 (0%=저점, 100%=고점)
    let pos52 = null
    if (cur.high52w != null && cur.low52w != null && price != null) {
      const span = cur.high52w - cur.low52w
      if (span > 0) pos52 = Number((((price - cur.low52w) / span) * 100).toFixed(1))
    }

    const ind = industryMap.get(s.itemCode)

    return {
      code: s.itemCode,
      name: s.stockName,
      market: 'KOSPI', // 코스피 전용. 코스닥은 수집 대상에서 제외된다.
      price,
      change: num(s.compareToPreviousClosePrice),
      changeRate: num(s.fluctuationsRatio),
      marketCap, // 억원
      volume: num(s.accumulatedTradingVolume),
      isPreferred: /(우|우B|우C|\d우)$/.test(s.stockName),
      industry: ind ? ind.industry : null,
      industryNo: ind ? ind.industryNo : null,

      revenue: fin.revenue ?? null,
      opIncome: fin.opIncome ?? null,
      netIncome: fin.netIncome ?? null,
      opMargin: fin.opMargin ?? null,
      netMargin: fin.netMargin ?? null,
      roe: fin.roe ?? null,
      debtRatio: fin.debtRatio ?? null,
      reserveRatio: fin.reserveRatio ?? null,
      revenueCagr: fin.revenueCagr ?? null,
      opIncomeYoY: fin.opIncomeYoY ?? null,
      finYear: fin.years && fin.years.length ? fin.years[fin.years.length - 1] : null,

      per: per ?? null,
      pbr: pbr ?? null,
      divYield: divYield ?? null,
      foreignRate: cur.foreignRate ?? null,
      pos52: pos52 ?? null,

      // ── 분기 실적 (단일분기 기준, 확정 실적만) ──
      quarterLabel: qtr?.quarterLabel ?? null,
      qRevenue: qtr?.qRevenue ?? null,
      qOpIncome: qtr?.qOpIncome ?? null,
      qNetIncome: qtr?.qNetIncome ?? null,
      qOpMargin: qtr?.qOpMargin ?? null,
      qQoQ: qtr?.qQoQ ?? null,
      qYoY: qtr?.qYoY ?? null,
      qOpQoQ: qtr?.qOpQoQ ?? null,
      qOpYoY: qtr?.qOpYoY ?? null,
      opPositiveStreak: qtr?.opPositiveStreak ?? null,
      opImproveStreak: qtr?.opImproveStreak ?? null,
      quarters: qtr?.quarters ?? null,
      qRevenueSeries: qtr?.qRevenueSeries ?? null,
      qOpIncomeSeries: qtr?.qOpIncomeSeries ?? null,
      qNetIncomeSeries: qtr?.qNetIncomeSeries ?? null,
      qOpMarginSeries: qtr?.qOpMarginSeries ?? null,
    }
  })

  // 유효성 요약
  const filled = (k) => records.filter((r) => r[k] != null).length
  console.error('■ 5) 필드 채움률')
  for (const k of [
    'marketCap',
    'revenue',
    'opMargin',
    'debtRatio',
    'per',
    'pbr',
    'roe',
    'divYield',
    'qRevenue',
    'qYoY',
    'qOpMargin',
    'qQoQ',
    'opPositiveStreak',
  ]) {
    console.error(`  ${k.padEnd(16)} ${filled(k)}/${records.length}`)
  }

  // 정렬: 시총 내림차순
  records.sort((a, b) => (b.marketCap || 0) - (a.marketCap || 0))

  const industries = [...new Set(records.map((r) => r.industry).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b, 'ko')
  )

  const payload = {
    meta: {
      source: 'NAVER Finance (m.stock.naver.com)',
      market: 'KOSPI',
      collectedAt: new Date().toISOString(),
      totalRowsScanned: totalCount,
      stockCount: records.length,
      industries,
      // 스냅샷 신뢰도 표기용
      note:
        '재무지표는 각 사 최근 확정 연간 실적(연결) 기준이며, PER/PBR/배당수익률은 수집 시점 시세 기준입니다.',
    },
    stocks: records,
  }

  mkdirSync(dirname(OUT), { recursive: true })
  writeFileSync(OUT, JSON.stringify(payload))
  const kb = (Buffer.byteLength(JSON.stringify(payload)) / 1024).toFixed(0)
  console.error(`\n✔ 저장: ${OUT} (${kb} KB, ${records.length}종목)`)
  console.error(`  소요: ${((Date.now() - t0) / 1000).toFixed(1)}초`)
}

main().catch((e) => {
  console.error('✘ 실패:', e)
  process.exit(1)
})
