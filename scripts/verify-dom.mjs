/**
 * 실제 DOM 검증 하네스
 * - 서버가 내려준 SSR HTML 을 jsdom 으로 파싱
 * - /static/analysis.js 를 실제로 실행
 * - 차트 라이브러리는 스텁(Chart)으로 대체해 렌더 경로만 검증
 * - 종목 추가/삭제를 실제 이벤트로 발생시켜 DOM 변화를 확인
 */
import { JSDOM } from 'jsdom'
import { readFileSync } from 'node:fs'

const BASE = 'http://localhost:3000'
const html = await (await fetch(BASE + '/')).text()

// runScripts: 'outside-only' → window.eval 이 window 컨텍스트(document/window)에서 실행된다.
// (이 옵션이 없으면 eval 이 Node 스코프에서 돌아 document 를 못 찾는다)
const dom = new JSDOM(html, {
  url: BASE + '/',
  pretendToBeVisual: true,
  runScripts: 'outside-only',
})
const { window } = dom

// --- fetch 주입 (상대경로 → 절대경로) ---
window.fetch = (input, init) => {
  const url = typeof input === 'string' && input.startsWith('/') ? BASE + input : input
  return fetch(url, init)
}

// --- Chart 스텁 (실제 캔버스 렌더는 브라우저 필요) ---
let chartInstances = 0
window.Chart = class Chart {
  constructor(ctx, cfg) {
    chartInstances++
    this.ctx = ctx
    this.cfg = cfg
    this.datasets = (cfg.data && cfg.data.datasets) || []
    this.labels = (cfg.data && cfg.data.labels) || []
  }
  destroy() {}
  resize() {}
}

const errors = []
window.addEventListener('error', (e) => errors.push(String(e.message || e.error)))
window.onerror = (m) => errors.push(String(m))

// --- analysis.js 실제 실행 ---
const js = readFileSync('public/static/analysis.js', 'utf8')
window.eval(js)

// --- 대기 헬퍼 ---
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function waitFor(fn, label, timeout = 8000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeout) {
    try {
      if (fn()) return true
    } catch {}
    await sleep(80)
  }
  throw new Error('timeout waiting: ' + label)
}

const $ = (id) => window.document.getElementById(id)
const qsa = (sel) => [...window.document.querySelectorAll(sel)]

const results = []
function check(name, ok, detail) {
  results.push({ name, ok, detail })
  console.log((ok ? '  OK   ' : '  FAIL ') + name + (detail ? '  → ' + detail : ''))
}

/* ───────── 1. 초기 렌더 ───────── */
await waitFor(() => qsa('#picked-stocks .picked-chip').length > 0, 'chips')
check('종목 칩 4개 렌더', qsa('#picked-stocks .picked-chip').length === 4,
  qsa('#picked-stocks .picked-chip').map((e) => e.querySelector('.nm').textContent).join(','))

check('요약 카드 4개', qsa('#summary-cards .summary-card').length === 4,
  String(qsa('#summary-cards .summary-card').length))

const headCols = qsa('#summary-table-head tr th').length
check('요약표 헤더 = 라벨1 + 종목4 = 5', headCols === 5, '실제 ' + headCols)

const firstRowCells = qsa('#summary-table-body tr')[0].querySelectorAll('th,td').length
check('요약표 첫 행 셀 5개', firstRowCells === 5, '실제 ' + firstRowCells)

/* 최신 종가는 스냅샷과 일치해야 한다 */
const priceRow = qsa('#summary-table-body tr')[0]
const priceTexts = [...priceRow.querySelectorAll('td')].map((td) => td.textContent.trim())
console.log('        최신 종가 행:', priceTexts.join(' | '))
check('삼성전자 종가 213,500', priceTexts[0].replace(/,/g, '') === '213500', priceTexts[0])
check('SK하이닉스 종가 1,263,000', priceTexts[1].replace(/,/g, '') === '1263000', priceTexts[1])

/* 2023년말 대비 수익률 검증 (171.97%) */
const vs2023 = [...qsa('#summary-table-body tr')[1].querySelectorAll('td')].map((td) => td.textContent.trim())
console.log('        2023년말 대비:', vs2023.join(' | '))
check('삼성전자 2023대비 +171.97%', vs2023[0].includes('171.97'), vs2023[0])
check('SK하이닉스 2023대비 +792.58%', vs2023[1].includes('792.58'), vs2023[1])

check('월별표 헤더 5칸', qsa('#monthly-table-head tr th').length === 5,
  String(qsa('#monthly-table-head tr th').length))
check('월별표 46행', qsa('#monthly-table-body tr').length === 46,
  String(qsa('#monthly-table-body tr').length))
check('연간표 4행', qsa('#annual-table-body tr').length === 4,
  String(qsa('#annual-table-body tr').length))
check('차트 3개 생성', chartInstances === 3, '인스턴스 ' + chartInstances)

/* ───────── 2. 종목 추가 (카카오) ───────── */
// 실제 사용자 흐름과 동일하게: 입력창을 클릭(포커스) → 타이핑
const input = $('add-stock-input')
input.focus()
input.dispatchEvent(new window.Event('focus', { bubbles: false }))
check('입력창 포커스됨', window.document.activeElement === input,
  String(window.document.activeElement && window.document.activeElement.id))

input.value = '카카오'
input.dispatchEvent(new window.Event('input', { bubbles: true }))
await waitFor(() => !$('add-stock-suggest').hidden && $('add-stock-suggest').children.length > 0, 'suggest')
const items = [...$('add-stock-suggest').querySelectorAll('[data-pick]')]
check('자동완성에서 카카오 검색', items.some((b) => b.textContent.includes('카카오')),
  items.map((b) => b.textContent.replace(/\s+/g, ' ').trim()).slice(0, 3).join(' ; '))

const kakao = items.find((b) => b.getAttribute('data-pick') === '035720')
kakao.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true, cancelable: true }))
await waitFor(() => qsa('#picked-stocks .picked-chip').length === 5, 'add kakao')

check('카카오 추가 → 칩 5개', qsa('#picked-stocks .picked-chip').length === 5,
  qsa('#picked-stocks .picked-chip').map((e) => e.querySelector('.nm').textContent).join(','))
check('카카오 추가 → 카드 5개', qsa('#summary-cards .summary-card').length === 5,
  String(qsa('#summary-cards .summary-card').length))
check('카카오 추가 → 표 헤더 6칸', qsa('#summary-table-head tr th').length === 6,
  String(qsa('#summary-table-head tr th').length))
check('카카오 추가 → 첫 행 6셀', qsa('#summary-table-body tr')[0].querySelectorAll('th,td').length === 6,
  String(qsa('#summary-table-body tr')[0].querySelectorAll('th,td').length))
check('카카오 추가 → 차트 재생성', chartInstances === 6, '누적 ' + chartInstances)

const kakaoCol = [...qsa('#summary-table-body tr')[0].querySelectorAll('td')][4]
check('카카오 최신 종가 29,800', kakaoCol.textContent.replace(/,/g, '').trim() === '29800',
  kakaoCol.textContent.trim())

/* 2023년말 대비: (29800-54300)/54300 = -45.12% */
const kakaoVs = [...qsa('#summary-table-body tr')[1].querySelectorAll('td')][4]
check('카카오 2023대비 -45.12%', kakaoVs.textContent.includes('45.12'), kakaoVs.textContent.trim())
check('카카오 하락 색상(down)', kakaoVs.className.includes('down'), kakaoVs.className)

/* ───────── 3. 종목 삭제 ───────── */
const delBtn = $('picked-stocks').querySelector('[data-remove="000660"]')
check('삭제 버튼 존재(SK하이닉스)', !!delBtn, delBtn ? delBtn.getAttribute('aria-label') : 'none')
delBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }))
await waitFor(() => qsa('#picked-stocks .picked-chip').length === 4, 'remove')

const afterNames = qsa('#picked-stocks .picked-chip').map((e) => e.querySelector('.nm').textContent)
check('SK하이닉스 삭제 → 4종목', afterNames.length === 4, afterNames.join(','))
check('SK하이닉스가 목록에서 사라짐', !afterNames.includes('SK하이닉스'), afterNames.join(','))
check('삭제 후 표 헤더 5칸', qsa('#summary-table-head tr th').length === 5,
  String(qsa('#summary-table-head tr th').length))

/* localStorage 저장 확인 */
const saved = JSON.parse(window.localStorage.getItem('madmoney:analysis:stocks:v1') || '[]')
check('선택 종목 localStorage 저장', saved.length === 4, JSON.stringify(saved.map((s) => s.name)))

/* ───────── 4. 최소 1종목 가드 ───────── */
for (const code of ['005930', '105560', '055550']) {
  const b = $('picked-stocks').querySelector('[data-remove="' + code + '"]')
  if (b) {
    b.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }))
    await sleep(120)
  }
}
check('1종목까지 삭제 가능', qsa('#picked-stocks .picked-chip').length === 1,
  String(qsa('#picked-stocks .picked-chip').length))
const lastDel = $('picked-stocks').querySelector('[data-remove]')
lastDel.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }))
await sleep(150)
check('마지막 1종목은 삭제 차단', qsa('#picked-stocks .picked-chip').length === 1,
  String(qsa('#picked-stocks .picked-chip').length))
check('차단 안내 문구 노출', $('picker-msg').textContent.includes('최소 1종목'),
  $('picker-msg').textContent)

/* ───────── 5. 기본 복원 ───────── */
$('btn-restore-default').dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }))
await waitFor(() => qsa('#picked-stocks .picked-chip').length === 4, 'restore')
check('기본 4종목 복원', qsa('#picked-stocks .picked-chip').length === 4,
  qsa('#picked-stocks .picked-chip').map((e) => e.querySelector('.nm').textContent).join(','))

/* ───────── 6. 런타임 에러 ───────── */
check('JS 런타임 에러 없음', errors.length === 0, errors.join(' | ') || 'none')

/* ───────── 요약 ───────── */
const failed = results.filter((r) => !r.ok)
console.log('\n────────────────────────────')
console.log(`총 ${results.length}개 검증 · 성공 ${results.length - failed.length} · 실패 ${failed.length}`)
if (failed.length) {
  console.log('실패 항목:')
  failed.forEach((f) => console.log('  ✗ ' + f.name + ' → ' + f.detail))
  process.exit(1)
}
console.log('전체 통과')
process.exit(0)
