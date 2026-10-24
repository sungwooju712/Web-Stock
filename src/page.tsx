import type { FC } from 'hono/jsx'
import { Analysis } from './analysis'

interface Meta {
  source: string
  market: string
  collectedAt: string
  totalRowsScanned: number
  stockCount: number
  industries: string[]
  note: string
}

interface PricesMeta {
  collectedAt: string
  tradingDays: number
  start: string | null
  end: string | null
}

export const Page: FC<{ meta: Meta; prices: PricesMeta }> = ({ meta, prices }) => {
  const collected = new Date(meta.collectedAt)
  const collectedText = isNaN(collected.getTime())
    ? meta.collectedAt
    : collected.toLocaleString('ko-KR', {
        timeZone: 'Asia/Seoul',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      })

  return (
    <html lang="ko">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>KOSPI 스크리너 · 시총·부채비율·영업이익률·PER·분기실적</title>
        <meta
          name="description"
          content="코스피 전 종목(942개)을 시가총액, 부채비율, 영업이익률, PER, ROE, 배당수익률, 분기 실적(매출·영업이익 YoY/QoQ)으로 조건 검색하는 무료 스크리너."
        />
        <link rel="icon" type="image/svg+xml" href="/static/favicon.svg" />
        <link rel="apple-touch-icon" href="/static/favicon.svg" />
        <meta name="theme-color" content="#1a56db" />
        <link rel="preconnect" href="https://cdn.jsdelivr.net" />
        <link
          rel="stylesheet"
          href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable-dynamic-subset.min.css"
        />
        <link rel="stylesheet" href="/static/style.css" />
      </head>
      <body>
        <header id="app-header">
          <div class="header-inner">
            <div class="brand">
              <div class="brand-mark" aria-hidden="true">
                K
              </div>
              <div class="brand-text">
                <h1>KOSPI 스크리너</h1>
                <p class="brand-sub">
                  <span class="kospi-only-badge">코스피 전용</span> 코스피 전 종목{' '}
                  <strong>{meta.stockCount.toLocaleString()}</strong>개 · 재무지표 조건검색
                </p>
              </div>
            </div>

            <div class="header-actions">
              <div class="search-box">
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <circle cx="11" cy="11" r="7" />
                  <path d="M20 20l-3.5-3.5" />
                </svg>
                <input
                  id="f-q"
                  type="search"
                  placeholder="종목명 · 종목코드 · 업종 검색"
                  autocomplete="off"
                  aria-label="종목 검색"
                />
              </div>
              <button id="btn-fav-toggle" class="btn btn-ghost" type="button" aria-pressed="false">
                <span class="star-ico" aria-hidden="true">★</span>
                즐겨찾기 <span id="fav-count-badge" class="badge">0</span>
              </button>
              <button id="btn-export" class="btn btn-ghost" type="button">CSV</button>
            </div>
          </div>

          <div class="source-line">
            <span class="dot" aria-hidden="true"></span>
            데이터 출처 네이버금융 ·{' '}
            <time datetime={meta.collectedAt}>스냅샷 {collectedText}</time>
            <span class="sep">|</span>
            확정 연간·분기 실적 기준 · 스냅샷 이후 변동은 종목 상세에서 실시간 갱신
            <span class="sep">|</span>
            전체 {meta.totalRowsScanned.toLocaleString()}행 중 ETF·ETN 제외 실주식 {meta.stockCount}종목
          </div>
        </header>

        <main id="app-main">
          <nav id="view-tabs" aria-label="화면 전환">
            <button type="button" class="view-tab active" data-view="analysis" aria-selected="true">
              주요 종목 분석
            </button>
            <button type="button" class="view-tab" data-view="screener" aria-selected="false">
              종목 스크리너
            </button>
          </nav>

          <div id="view-screener" class="view" hidden>
          <section id="stats-strip" aria-label="조건 충족 요약">
            <div class="stat-card">
              <span class="stat-label">조건 충족</span>
              <strong class="stat-value" id="stat-count">–</strong>
              <span class="stat-unit">종목</span>
            </div>
            <div class="stat-card">
              <span class="stat-label">PER 중앙값</span>
              <strong class="stat-value" id="stat-per">–</strong>
              <span class="stat-unit">배</span>
            </div>
            <div class="stat-card">
              <span class="stat-label">PBR 중앙값</span>
              <strong class="stat-value" id="stat-pbr">–</strong>
              <span class="stat-unit">배</span>
            </div>
            <div class="stat-card">
              <span class="stat-label">부채비율 평균</span>
              <strong class="stat-value" id="stat-debt">–</strong>
              <span class="stat-unit">%</span>
            </div>
            <div class="stat-card">
              <span class="stat-label">영업이익률 중앙값</span>
              <strong class="stat-value" id="stat-op">–</strong>
              <span class="stat-unit">%</span>
            </div>
            <div class="stat-card">
              <span class="stat-label">합산 시가총액</span>
              <strong class="stat-value" id="stat-cap">–</strong>
              <span class="stat-unit">억원</span>
            </div>
          </section>

          <div class="layout">
            <aside id="filter-panel" aria-label="조회 조건">
              <div class="panel-head">
                <h2>조회 조건</h2>
                <button id="btn-reset" class="link-btn" type="button">초기화</button>
              </div>

              <form id="filter-form" onsubmit="return false">
                <fieldset class="filter-group">
                  <legend>빠른 조건</legend>
                  <div class="chips" id="preset-chips">
                    <button type="button" class="chip" data-preset="value">가치주</button>
                    <button type="button" class="chip" data-preset="growth">성장주</button>
                    <button type="button" class="chip" data-preset="dividend">배당주</button>
                    <button type="button" class="chip" data-preset="lowdebt">저부채</button>
                    <button type="button" class="chip" data-preset="largecap">대형주</button>
                  </div>
                </fieldset>

                <fieldset class="filter-group">
                  <legend>
                    시가총액 <span class="unit">억원</span>
                  </legend>
                  <div class="range-row">
                    <label>
                      <span class="sr-only">시가총액 최소</span>
                      <input id="f-marketcap-min" type="number" inputmode="numeric" placeholder="최소 (예 1000)" min="0" step="100" />
                    </label>
                    <span class="range-dash">~</span>
                    <label>
                      <span class="sr-only">시가총액 최대</span>
                      <input id="f-marketcap-max" type="number" inputmode="numeric" placeholder="최대" min="0" step="100" />
                    </label>
                  </div>
                  <div class="chips small">
                    <button type="button" class="chip" data-cap="1000">1,000억↑</button>
                    <button type="button" class="chip" data-cap="3000">3,000억↑</button>
                    <button type="button" class="chip" data-cap="10000">1조↑</button>
                    <button type="button" class="chip" data-cap="50000">5조↑</button>
                  </div>
                </fieldset>

                <fieldset class="filter-group">
                  <legend>
                    부채비율 <span class="unit">% 이하</span>
                  </legend>
                  <input id="f-debt-max" type="number" inputmode="numeric" placeholder="예 200" min="0" step="10" />
                  <div class="chips small">
                    <button type="button" class="chip" data-debt="100">100%↓</button>
                    <button type="button" class="chip" data-debt="200">200%↓</button>
                    <button type="button" class="chip" data-debt="400">400%↓</button>
                  </div>
                </fieldset>

                <fieldset class="filter-group">
                  <legend>
                    영업이익률 <span class="unit">% 이상</span>
                  </legend>
                  <input id="f-opmargin-min" type="number" inputmode="decimal" placeholder="예 5" step="0.5" />
                  <div class="chips small">
                    <button type="button" class="chip" data-op="0">흑자</button>
                    <button type="button" class="chip" data-op="5">5%↑</button>
                    <button type="button" class="chip" data-op="10">10%↑</button>
                    <button type="button" class="chip" data-op="20">20%↑</button>
                  </div>
                </fieldset>

                <fieldset class="filter-group">
                  <legend>
                    PER <span class="unit">배</span>
                  </legend>
                  <div class="range-row">
                    <label>
                      <span class="sr-only">PER 최소</span>
                      <input id="f-per-min" type="number" inputmode="decimal" placeholder="최소 (예 0)" step="0.5" min="0" />
                    </label>
                    <span class="range-dash">~</span>
                    <label>
                      <span class="sr-only">PER 최대</span>
                      <input id="f-per-max" type="number" inputmode="decimal" placeholder="최대 (예 15)" step="0.5" min="0" />
                    </label>
                  </div>
                  <div class="chips small">
                    <button type="button" class="chip" data-per="10">10배↓</button>
                    <button type="button" class="chip" data-per="15">15배↓</button>
                    <button type="button" class="chip" data-per="20">20배↓</button>
                  </div>
                </fieldset>

                <fieldset class="filter-group">
                  <legend>
                    매출액 <span class="unit">억원 이상</span>
                  </legend>
                  <input id="f-revenue-min" type="number" inputmode="numeric" placeholder="예 5000" min="0" step="100" />
                </fieldset>

                <details class="filter-more" open>
                  <summary>추가 지표</summary>

                  <fieldset class="filter-group">
                    <legend>
                      ROE <span class="unit">% 이상</span>
                    </legend>
                    <input id="f-roe-min" type="number" inputmode="decimal" placeholder="예 8" step="0.5" />
                  </fieldset>

                  <fieldset class="filter-group">
                    <legend>
                      PBR <span class="unit">배 이하</span>
                    </legend>
                    <input id="f-pbr-max" type="number" inputmode="decimal" placeholder="예 1.5" step="0.1" min="0" />
                  </fieldset>

                  <fieldset class="filter-group">
                    <legend>
                      배당수익률 <span class="unit">% 이상</span>
                    </legend>
                    <input id="f-div-min" type="number" inputmode="decimal" placeholder="예 2" step="0.1" />
                  </fieldset>

                  <fieldset class="filter-group">
                    <legend>
                      매출 3년 CAGR <span class="unit">% 이상</span>
                    </legend>
                    <input id="f-growth-min" type="number" inputmode="decimal" placeholder="예 10" step="1" />
                  </fieldset>
                </details>

                <details class="filter-more" open>
                  <summary>분기 실적</summary>

                  <fieldset class="filter-group">
                    <legend>
                      분기 매출 YoY <span class="unit">% 이상</span>
                    </legend>
                    <input id="f-qyoy-min" type="number" inputmode="decimal" placeholder="예 10" step="1" />
                    <div class="chips small">
                      <button type="button" class="chip" data-qyoy="0">플러스</button>
                      <button type="button" class="chip" data-qyoy="10">10%↑</button>
                      <button type="button" class="chip" data-qyoy="20">20%↑</button>
                      <button type="button" class="chip" data-qyoy="30">30%↑</button>
                    </div>
                  </fieldset>

                  <fieldset class="filter-group">
                    <legend>
                      분기 영업이익 YoY <span class="unit">% 이상</span>
                    </legend>
                    <input id="f-qopyoy-min" type="number" inputmode="decimal" placeholder="예 15" step="1" />
                    <div class="chips small">
                      <button type="button" class="chip" data-qopyoy="0">플러스</button>
                      <button type="button" class="chip" data-qopyoy="20">20%↑</button>
                      <button type="button" class="chip" data-qopyoy="50">50%↑</button>
                    </div>
                  </fieldset>

                  <fieldset class="filter-group">
                    <legend>
                      분기 영업이익률 <span class="unit">% 이상</span>
                    </legend>
                    <input id="f-qopmargin-min" type="number" inputmode="decimal" placeholder="예 8" step="0.5" />
                  </fieldset>

                  <fieldset class="filter-group">
                    <legend>
                      분기 매출 QoQ <span class="unit">% 이상</span>
                    </legend>
                    <input id="f-qqoq-min" type="number" inputmode="decimal" placeholder="예 0" step="1" />
                  </fieldset>

                  <fieldset class="filter-group">
                    <legend>
                      영업이익 흑자 연속 <span class="unit">분기 이상</span>
                    </legend>
                    <input id="f-opstreak-min" type="number" inputmode="numeric" placeholder="예 4 (최대 5)" min="0" step="1" max="5" />
                    <div class="chips small">
                      <button type="button" class="chip" data-streak="2">2분기↑</button>
                      <button type="button" class="chip" data-streak="4">4분기↑</button>
                      <button type="button" class="chip" data-streak="5">5분기↑</button>
                    </div>
                  </fieldset>

                  <p class="filter-hint">
                    네이버금융이 제공하는 분기 창은 <strong>최근 5개 분기</strong>입니다. 따라서 흑자연속은 최대 5분기까지이며,
                    5는 "제공된 5개 분기 전부 흑자"를 뜻합니다. 분기 값은 <strong>단일분기(비누적)</strong> 확정 실적 기준이고,
                    YoY는 전년 동기 대비, QoQ는 직전 분기 대비입니다.
                  </p>
                </details>

                <fieldset class="filter-group">
                  <legend>업종</legend>
                  <select id="f-industry">
                    <option value="">전체 업종</option>
                    {meta.industries.map((name) => (
                      <option value={name}>{name}</option>
                    ))}
                  </select>
                </fieldset>

                <fieldset class="filter-group checks">
                  <label class="check">
                    <input id="f-exclude-preferred" type="checkbox" checked />
                    <span>우선주 제외</span>
                  </label>
                  <label class="check">
                    <input id="f-favonly" type="checkbox" />
                    <span>즐겨찾기만 보기</span>
                  </label>
                </fieldset>
              </form>

              <p class="filter-note">
                지표가 없는 종목(적자·무배당 등)은 해당 조건 입력 시 결과에서 제외됩니다. 숫자를 비우면 조건 미적용.
              </p>
            </aside>

            <section id="results-panel" aria-label="조회 결과">
              <div id="results-toolbar">
                <p class="result-summary" id="result-summary" aria-live="polite">불러오는 중…</p>
                <div class="toolbar-right">
                  <label class="page-size">
                    <span>표시</span>
                    <select id="f-pagesize">
                      <option value="25">25</option>
                      <option value="50" selected>50</option>
                      <option value="100">100</option>
                      <option value="200">200</option>
                    </select>
                    <span>개</span>
                  </label>
                </div>
              </div>

              <div class="table-wrap">
                <table id="results-table">
                  <thead>
                    <tr>
                      <th class="col-fav" scope="col"><span class="sr-only">즐겨찾기</span></th>
                      <th class="col-name" scope="col" data-sort="name" tabindex="0">
                        종목 <span class="sort-ind"></span>
                      </th>
                      <th class="num" scope="col" data-sort="price" tabindex="0">
                        현재가 <span class="sort-ind"></span>
                      </th>
                      <th class="num" scope="col" data-sort="changeRate" tabindex="0">
                        등락률 <span class="sort-ind"></span>
                      </th>
                      <th class="num" scope="col" data-sort="marketCap" tabindex="0">
                        시가총액 <span class="sort-ind"></span>
                      </th>
                      <th class="num" scope="col" data-sort="per" tabindex="0">
                        PER <span class="sort-ind"></span>
                      </th>
                      <th class="num" scope="col" data-sort="pbr" tabindex="0">
                        PBR <span class="sort-ind"></span>
                      </th>
                      <th class="num" scope="col" data-sort="opMargin" tabindex="0">
                        영업이익률 <span class="sort-ind"></span>
                      </th>
                      <th class="num" scope="col" data-sort="debtRatio" tabindex="0">
                        부채비율 <span class="sort-ind"></span>
                      </th>
                      <th class="num" scope="col" data-sort="roe" tabindex="0">
                        ROE <span class="sort-ind"></span>
                      </th>
                      <th class="num" scope="col" data-sort="divYield" tabindex="0">
                        배당 <span class="sort-ind"></span>
                      </th>
                      <th class="num" scope="col" data-sort="revenueCagr" tabindex="0">
                        매출성장 <span class="sort-ind"></span>
                      </th>
                      <th class="num col-q" scope="col" data-sort="qYoY" tabindex="0" title="직전 확정 분기 매출액의 전년 동기 대비 증가율">
                        분기매출YoY <span class="sort-ind"></span>
                      </th>
                      <th class="num col-q" scope="col" data-sort="qOpMargin" tabindex="0" title="직전 확정 분기의 영업이익률">
                        분기영업이익률 <span class="sort-ind"></span>
                      </th>
                      <th class="col-ind" scope="col">업종</th>
                      <th class="col-edit" scope="col"><span class="sr-only">편집</span></th>
                    </tr>
                  </thead>
                  <tbody id="results-body">
                    <tr class="skeleton-row">
                      <td colspan="16">
                        <div class="skeleton-loading">데이터를 불러오는 중입니다…</div>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>

              <nav id="pagination" aria-label="페이지 이동"></nav>
            </section>
          </div>
          </div>

          <div id="view-analysis" class="view active">
            <Analysis
              collectedAt={prices.collectedAt}
              tradingDays={prices.tradingDays}
              start={prices.start}
              end={prices.end}
            />
          </div>

          <footer id="app-footer">
            <p>
              본 서비스는 네이버금융 공개 데이터를 수집한 <strong>정보 제공용 스크리너</strong>입니다.
              재무지표는 각 사 최근 확정 연간 실적(연결) 기준이며, 스냅샷 시점 이후 변동될 수 있습니다.
              <strong> 투자 판단의 근거로 단독 사용하지 마세요.</strong> 투자 손익은 투자자 본인에게 귀속됩니다.
            </p>
            <p class="footer-meta">
              스냅샷 수집 {collectedText} · 종목 {meta.stockCount}개 · 업종 {meta.industries.length}개
            </p>
          </footer>
        </main>

        {/* 종목 상세 드로어 */}
        <aside id="detail-drawer" class="drawer" aria-hidden="true" aria-label="종목 상세">
          <div class="drawer-backdrop" data-close-drawer></div>
          <div class="drawer-panel" role="dialog" aria-modal="true" aria-labelledby="drawer-title">
            <div class="drawer-head">
              <div>
                <h2 id="drawer-title">종목 상세</h2>
                <p id="drawer-sub" class="drawer-sub"></p>
              </div>
              <button class="icon-btn" type="button" data-close-drawer aria-label="닫기">✕</button>
            </div>
            <div class="drawer-body" id="drawer-body"></div>
          </div>
        </aside>

        {/* 즐겨찾기 편집 모달 */}
        <div id="edit-modal" class="modal" aria-hidden="true">
          <div class="modal-backdrop" data-close-modal></div>
          <div class="modal-panel" role="dialog" aria-modal="true" aria-labelledby="edit-title">
            <h2 id="edit-title">종목 메모 편집</h2>
            <p id="edit-sub" class="modal-sub"></p>
            <form id="edit-form" onsubmit="return false">
              <label class="field">
                <span>투자 메모</span>
                <textarea id="edit-memo" rows="4" placeholder="예) 반도체 사이클 회복, 3분기 실적 확인 후 분할 매수 검토"></textarea>
              </label>
              <label class="field">
                <span>태그 <em>(쉼표로 구분)</em></span>
                <input id="edit-tags" type="text" placeholder="예) 핵심, 장기보유, 배당" />
              </label>
              <label class="field">
                <span>목표가 <em>(원, 선택)</em></span>
                <input id="edit-target" type="number" inputmode="numeric" placeholder="예 250000" min="0" />
              </label>
              <div class="modal-actions">
                <button type="button" class="btn btn-ghost" data-close-modal>취소</button>
                <button type="submit" id="edit-save" class="btn btn-primary">저장</button>
              </div>
            </form>
          </div>
        </div>

        <div id="toast" class="toast" role="status" aria-live="polite"></div>

        {/* 차트 / 엑셀 라이브러리 (CDN, Worker 번들에 포함하지 않음) */}
        <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>
        <script src="https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js"></script>
        <script src="/static/app.js"></script>
        <script src="/static/analysis.js"></script>
      </body>
    </html>
  )
}
