import type { FC } from 'hono/jsx'

/**
 * 주요 종목 분석 뷰 (엑셀 "한장보고 / 전체보고 / 일일종가 / 월별종가 / 연간데이터" 재현)
 *
 * 설계 원칙
 *  - 서버는 데이터만 내려주고(/api/prices, /api/prices/daily), 그리기는 클라이언트가 한다.
 *  - 928거래일 × 4종목을 SSR HTML 로 그리면 페이로드가 터진다.
 *  - 차트/엑셀 라이브러리는 CDN 으로 불러와 Worker 번들을 가볍게 유지한다.
 */
export const Analysis: FC<{ collectedAt: string; tradingDays: number; start: string | null; end: string | null }> = ({
  collectedAt,
  tradingDays,
  start,
  end,
}) => {
  const collected = new Date(collectedAt)
  const collectedText = isNaN(collected.getTime())
    ? collectedAt
    : collected.toLocaleString('ko-KR', {
        timeZone: 'Asia/Seoul',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      })

  return (
    <section id="analysis-panel" aria-label="주요 종목 종가 분석">
      <div class="analysis-head">
        <div>
          <h2>주요 종목 종가 분석</h2>
          <p class="analysis-sub">
            삼성전자 · SK하이닉스 · KB금융 · 신한지주 · <strong>{tradingDays.toLocaleString()}</strong>거래일
            {start && end ? ` (${start} ~ ${end})` : ''}
          </p>
        </div>
        <div class="analysis-actions">
          <button id="btn-report" class="btn btn-primary" type="button">보고서 다운로드</button>
          <button id="btn-print" class="btn btn-ghost" type="button">인쇄 / PDF</button>
          <button id="btn-xlsx" class="btn btn-ghost" type="button">엑셀 다운로드</button>
        </div>
      </div>

      <p class="analysis-note">
        종가 출처는 <strong>네이버금융</strong> 단일 기준입니다. 스냅샷 {collectedText} 수집.
      </p>

      {/* ── 종목 구성: 추가 / 삭제 ── */}
      <section id="analysis-picker" aria-label="분석 종목 구성">
        <div class="picker-head">
          <h3 class="analysis-h3">분석 종목</h3>
          <p class="picker-hint">
            코스피 종목을 검색해 추가하세요. 최대 <strong>8종목</strong>까지 그래프에 함께 표시됩니다.
          </p>
        </div>

        <div id="picked-stocks" class="picked-stocks" aria-live="polite">
          <span class="picked-loading">불러오는 중…</span>
        </div>

        <div class="picker-row">
          <div class="stock-search-box">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <circle cx="11" cy="11" r="7" />
              <path d="M20 20l-3.5-3.5" />
            </svg>
            <input
              id="add-stock-input"
              type="search"
              placeholder="종목명 또는 종목코드 (예: 카카오, 035720)"
              autocomplete="off"
              aria-label="추가할 종목 검색"
              aria-autocomplete="list"
              aria-controls="add-stock-suggest"
            />
            <div id="add-stock-suggest" class="suggest-list" role="listbox" hidden></div>
          </div>
          <button id="btn-restore-default" class="btn btn-ghost" type="button">
            기본 4종목으로
          </button>
        </div>
        <p id="picker-msg" class="picker-msg" role="status" aria-live="polite"></p>
      </section>

      {/* ── 한장보고: 요약 지표 ── */}
      <section id="analysis-summary" aria-label="한눈에 보기">
        <h3 class="analysis-h3">한눈에 보기</h3>
        <div class="summary-cards" id="summary-cards">
          <div class="summary-card skeleton-card"></div>
        </div>

        <div class="table-wrap analysis-table-wrap">
          <table id="summary-table" class="analysis-table">
            <thead id="summary-table-head">
              <tr>
                <th scope="col">지표</th>
              </tr>
            </thead>
            <tbody id="summary-table-body">
              <tr>
                <td colspan="5"><div class="skeleton-loading">불러오는 중…</div></td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      {/* ── 그래프 1: 일별 종가 ── */}
      <section id="analysis-chart-daily" aria-label="일별 종가 추이">
        <div class="chart-head">
          <h3 class="analysis-h3">그래프 1 · 일별 종가 추이</h3>
          <div class="chart-tools">
            <label class="chart-scale">
              <input id="chk-log" type="checkbox" />
              <span>로그 스케일</span>
            </label>
            <select id="sel-range" aria-label="기간 선택">
              <option value="3M">최근 3개월</option>
              <option value="6M">최근 6개월</option>
              <option value="1Y">최근 1년</option>
              <option value="ALL" selected>전체 기간</option>
            </select>
          </div>
        </div>
        <div class="chart-box">
          <canvas id="chart-daily" height="360"></canvas>
        </div>
      </section>

      {/* ── 그래프 2: 월별 종가 ── */}
      <section id="analysis-chart-monthly" aria-label="월별 종가 추이">
        <h3 class="analysis-h3">그래프 2 · 월별 종가 추이</h3>
        <div class="chart-box">
          <canvas id="chart-monthly" height="320"></canvas>
        </div>
      </section>

      {/* ── 그래프 3: 연간 수익률 ── */}
      <section id="analysis-chart-annual" aria-label="연간 수익률">
        <h3 class="analysis-h3">
          그래프 3 · 연간 수익률 <span class="hint">2026년은 연초 대비(YTD)</span>
        </h3>
        <div class="chart-box">
          <canvas id="chart-annual" height="300"></canvas>
        </div>
      </section>

      {/* ── 월별 종가 표 ── */}
      <section id="analysis-monthly-table" aria-label="월별 종가 표">
        <h3 class="analysis-h3">월별 종가 <span class="hint">각 월 마지막 거래일 종가 · 단위 원</span></h3>
        <div class="table-wrap analysis-table-wrap">
          <table class="analysis-table" id="monthly-table">
            <thead id="monthly-table-head">
              <tr>
                <th scope="col">연-월</th>
              </tr>
            </thead>
            <tbody id="monthly-table-body">
              <tr>
                <td colspan="5"><div class="skeleton-loading">불러오는 중…</div></td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      {/* ── 연간 데이터 표 ── */}
      <section id="analysis-annual-table" aria-label="연간 종가 및 수익률">
        <h3 class="analysis-h3">
          연간 종가 및 수익률 <span class="hint">연말 종가 기준 · 2026년은 YTD</span>
        </h3>
        <div class="table-wrap analysis-table-wrap">
          <table class="analysis-table" id="annual-table">
            <thead id="annual-table-head">
              <tr>
                <th scope="row">연도</th>
              </tr>
            </thead>
            <tbody id="annual-table-body">
              <tr>
                <td colspan="5"><div class="skeleton-loading">불러오는 중…</div></td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <p class="analysis-disclaimer">
        본 분석은 네이버금융 공개 종가 데이터를 집계한 <strong>정보 제공용 자료</strong>이며 투자 권유가 아닙니다.
        원본 엑셀은 Yahoo Finance 가 혼합되어 있어 종가가 소폭 다를 수 있습니다.
      </p>
    </section>
  )
}
