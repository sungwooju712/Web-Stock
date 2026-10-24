#!/usr/bin/env node
/**
 * 종가 시계열 수집기 (주요 종목 분석용)
 *
 * 데이터 출처: 네이버 금융 siseJson API (api.finance.naver.com)
 *   - 일별 OHLCV + 외국인소진율을 한 번에 준다.
 *   - m.stock.naver.com 의 chart 엔드포인트는 HTML 을 돌려주므로 사용하지 않는다.
 *
 * 출력: src/data/prices.json
 *   {
 *     meta: { collectedAt, start, end, codes, source },
 *     stocks: [{code, name}],
 *     daily:   [{date, c:{code:price}}]        // 928거래일
 *     monthly: [{ym, c:{code:price,ret}}]
 *     annual:  [{year, c:{code:price}, r:{code:ret}}]
 *   }
 *
 * 사용법:
 *   node scripts/fetch-prices.mjs
 *   node scripts/fetch-prices.mjs --from 20230101
 */

import { writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const OUT = resolve(ROOT, 'src/data/prices.json')

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

const args = process.argv.slice(2)
const argVal = (flag, dflt) => {
  const i = args.indexOf(flag)
  return i >= 0 ? args[i + 1] : dflt
}

const START = argVal('--from', '20230101')
const CONCURRENCY = 6
const TIMEOUT_MS = 20000
const RETRIES = 3

/** 분석 대상 종목. 여기에 추가하면 그대로 UI/엑셀/보고서에 반영된다. */
const STOCKS = [
  { code: '005930', name: '삼성전자' },
  { code: '000660', name: 'SK하이닉스' },
  { code: '105560', name: 'KB금융' },
  { code: '055550', name: '신한지주' },
]

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function fetchText(url) {
  let lastErr
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), TIMEOUT_MS)
    try {
      const res = await fetch(url, {
        signal: ac.signal,
        headers: {
          'User-Agent': UA,
          Accept: 'application/json, text/plain, */*',
          'Accept-Language': 'ko-KR,ko;q=0.9',
          Referer: 'https://finance.naver.com/',
        },
      })
      clearTimeout(timer)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return await res.text()
    } catch (e) {
      clearTimeout(timer)
      lastErr = e
      if (attempt < RETRIES) await sleep(600 * attempt)
    }
  }
  throw lastErr
}

/** 네이버 siseJson 응답은 작은따옴표 + 공백이 섞인 JSON 이다. */
function parseSiseJson(text) {
  const cleaned = text.trim().replace(/'/g, '"')
  const rows = JSON.parse(cleaned)
  // 첫 행은 헤더
  const header = rows[0]
  const body = rows.slice(1).filter((r) => Array.isArray(r) && r.length >= 5)
  return { header, body }
}

const ymd = (s) => `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`

async function fetchOne(stock) {
  const url =
    `https://api.finance.naver.com/siseJson.naver?symbol=${stock.code}` +
    `&requestType=1&startTime=${START}&endTime=${todayCompact()}&timeframe=day`
  const text = await fetchText(url)
  const { body } = parseSiseJson(text)
  const rows = body.map((r) => ({
    date: ymd(String(r[0])),
    open: Number(r[1]),
    high: Number(r[2]),
    low: Number(r[3]),
    close: Number(r[4]),
    volume: Number(r[5]),
    foreign: r[6] == null ? null : Number(r[6]),
  }))
  return { code: stock.code, name: stock.name, rows }
}

function todayCompact() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`
}

/** 제한 동시성으로 처리 */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length)
  let idx = 0
  async function worker() {
    while (idx < items.length) {
      const i = idx++
      out[i] = await fn(items[i], i)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

const round = (v, d = 4) => (v == null || !Number.isFinite(v) ? null : Number(v.toFixed(d)))

async function main() {
  console.log('■ 1) 종가 시계열 수집')
  console.log(`  대상: ${STOCKS.map((s) => `${s.name}(${s.code})`).join(', ')}`)
  console.log(`  기간: ${START} ~ ${todayCompact()}`)

  const raw = await mapLimit(STOCKS, CONCURRENCY, async (s) => {
    const r = await fetchOne(s)
    console.log(`  ${s.name.padEnd(10)} ${r.rows.length}행  (${r.rows[0]?.date} ~ ${r.rows[r.rows.length - 1]?.date})`)
    return r
  })

  // ── 거래일 합집합 (종목별 상장/거래정지 차이를 흡수) ──
  const dateSet = new Set()
  for (const r of raw) for (const row of r.rows) dateSet.add(row.date)
  const dates = [...dateSet].sort()

  const closeByCode = new Map()
  const highByCode = new Map()
  const lowByCode = new Map()
  for (const r of raw) {
    const cm = new Map()
    const hm = new Map()
    const lm = new Map()
    for (const row of r.rows) {
      cm.set(row.date, row.close)
      hm.set(row.date, row.high)
      lm.set(row.date, row.low)
    }
    closeByCode.set(r.code, cm)
    highByCode.set(r.code, hm)
    lowByCode.set(r.code, lm)
  }

  const daily = dates.map((date) => {
    const c = {}
    for (const s of STOCKS) {
      const v = closeByCode.get(s.code)?.get(date)
      c[s.code] = v == null || !Number.isFinite(v) ? null : v
    }
    return { date, c }
  })

  // ── 월별 (각 월의 마지막 거래일 종가) ──
  const monthMap = new Map() // ym -> {code: close}
  for (const d of daily) {
    const ym = d.date.slice(0, 7)
    monthMap.set(ym, d.c) // 날짜 오름차순이므로 마지막 값이 월말
  }
  const yms = [...monthMap.keys()].sort()
  const monthly = yms.map((ym, i) => {
    const c = monthMap.get(ym)
    const prev = i > 0 ? monthMap.get(yms[i - 1]) : null
    const ret = {}
    for (const s of STOCKS) {
      const cur = c[s.code]
      const p = prev ? prev[s.code] : null
      ret[s.code] = cur != null && p != null && p !== 0 ? round(((cur - p) / p) * 100, 2) : null
    }
    return { ym, c, r: ret }
  })

  // ── 연간 (연말 종가 = 각 연도의 마지막 거래일) ──
  const yearMap = new Map()
  for (const d of daily) {
    yearMap.set(d.date.slice(0, 4), d.c)
  }
  const years = [...yearMap.keys()].sort()
  const annual = years.map((year, i) => {
    const c = yearMap.get(year)
    const prev = i > 0 ? yearMap.get(years[i - 1]) : null
    const ret = {}
    for (const s of STOCKS) {
      const cur = c[s.code]
      const p = prev ? prev[s.code] : null
      // 수익률은 소수 비율 (0.7911 = +79.11%) — 엑셀 원본과 동일 규격
      ret[s.code] = cur != null && p != null && p !== 0 ? round((cur - p) / p, 6) : null
    }
    return { year, c, r: ret }
  })

  // ── 기간 최고/최저 (종가 기준) ──
  const period = {}
  for (const s of STOCKS) {
    const cm = closeByCode.get(s.code)
    let hi = null
    let hiDate = null
    let lo = null
    let loDate = null
    for (const d of dates) {
      const v = cm?.get(d)
      if (v == null) continue
      if (hi == null || v > hi) {
        hi = v
        hiDate = d
      }
      if (lo == null || v < lo) {
        lo = v
        loDate = d
      }
    }
    // 장중 최고가 (high 컬럼 기준)
    const hm = highByCode.get(s.code)
    let hiIntra = null
    let hiIntraDate = null
    for (const d of dates) {
      const v = hm?.get(d)
      if (v == null) continue
      if (hiIntra == null || v > hiIntra) {
        hiIntra = v
        hiIntraDate = d
      }
    }
    period[s.code] = { closeHigh: hi, closeHighDate: hiDate, closeLow: lo, closeLowDate: loDate, high: hiIntra, highDate: hiIntraDate }
  }

  const last = daily[daily.length - 1]
  const first = daily[0]

  const out = {
    meta: {
      source: '네이버금융 siseJson (api.finance.naver.com)',
      collectedAt: new Date().toISOString(),
      start: first?.date || null,
      end: last?.date || null,
      tradingDays: daily.length,
      codes: STOCKS.map((s) => s.code),
      note: '종가는 네이버금융 단일 출처. 원본 엑셀은 Yahoo Finance 가 혼합되어 종가가 소폭 다를 수 있음.',
    },
    stocks: STOCKS,
    daily,
    monthly,
    annual,
    period,
  }

  writeFileSync(OUT, JSON.stringify(out), 'utf8')

  console.log('■ 2) 집계')
  console.log(`  일별 ${daily.length}건 · 월별 ${monthly.length}건 · 연간 ${annual.length}건`)
  console.log('■ 3) 최신 종가')
  for (const s of STOCKS) {
    console.log(`  ${s.name.padEnd(10)} ${String(last.c[s.code]).padStart(9)}원  (${last.date})`)
  }
  const bytes = JSON.stringify(out).length
  console.log(`✔ 저장: ${OUT} (${Math.round(bytes / 1024)} KB)`)
}

main().catch((e) => {
  console.error('✘ 실패:', e.message)
  process.exit(1)
})
