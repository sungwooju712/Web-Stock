/**
 * 코스피 종목 분석 — 분석 뷰 클라이언트
 *
 * - 데이터: /api/prices (요약·월별·연간), /api/prices/daily (일별)
 *           /api/prices/stock/:code (추가한 종목의 종가 시계열)
 *           /api/stocks/names (자동완성용 코스피 종목 인덱스)
 * - 차트: Chart.js (CDN, UMD)
 * - 엑셀: SheetJS (CDN, UMD) — 원본 5시트 구조 재현
 * - 보고서: 자기완결형 HTML 파일 다운로드 (브라우저에서 PDF 인쇄 가능)
 *
 * 설계 원칙
 *  - 모든 지표는 "선택된 종목 배열(state.stocks)"만 보고 계산한다.
 *    종목을 추가/삭제하면 표·차트·보고서·엑셀이 전부 같은 경로로 다시 그려진다.
 *  - 기본 4종목은 빌드 스냅샷(prices.json)에서 즉시 채우고,
 *    추가한 종목만 /api/prices/stock/:code 로 런타임 수집한다.
 *  - 서버는 거래일 축을 기존 스냅샷(928일)에 맞춰 내려주므로,
 *    클라이언트는 인덱스만 맞추면 된다(병합 로직 단순화).
 */
(function () {
  'use strict';

  var LS_STOCKS = 'madmoney:analysis:stocks:v1';
  var LS_TAB = 'kospi-screener:view:v1'; // 탭 기억 키는 기존 값 유지
  var MAX_STOCKS = 8;

  /* 8색 팔레트 — 선 8개까지 서로 구분되도록 채도/명도를 벌렸다 */
  var COLORS = [
    '#1a56db',
    '#e0322c',
    '#0f9d58',
    '#f5a623',
    '#8b5cf6',
    '#0891b2',
    '#db2777',
    '#65a30d',
  ];

  var BASE = null; // /api/prices 응답
  var DAILY = null; // /api/prices/daily 응답
  var DATES = []; // 거래일 축 (YYYY-MM-DD)
  var NAMES = null; // [code, name][] 자동완성 인덱스
  var namesLoading = false;
  // 앱 버전 — /api/prices 응답에서 받는다 (정적 파일이라 src/version.ts 를 직접 못 읽음)
  // 보고서 HTML·엑셀 파일명에 각인해 "어느 버전에서 만든 자료인지" 추적 가능하게 한다.
  var APP_VER = '';

  /**
   * 화면 상태.
   * 모든 렌더 함수는 이 객체만 읽는다.
   */
  var state = {
    stocks: [], // [{code, name}]  — 표시 순서
    closes: {}, // code -> (number|null)[]  (DATES 와 같은 길이/순서)
    monthly: {}, // code -> { '2023-01': 55500, ... }
    annual: {}, // code -> { '2023': 72800, ... }
    period: {}, // code -> { closeHigh, closeHighDate, closeLow, closeLowDate, highIntraday, highIntradayDate }
  };

  /** 기본 4종목 (스냅샷에 포함된 종목) */
  var DEFAULT_STOCKS = [
    { code: '005930', name: '삼성전자' },
    { code: '000660', name: 'SK하이닉스' },
    { code: '105560', name: 'KB금융' },
    { code: '055550', name: '신한지주' },
  ];

  var charts = { daily: null, monthly: null, annual: null };
  var loaded = false;

  /* ---------------- 유틸 ---------------- */
  function $(id) {
    return document.getElementById(id);
  }

  function esc(s) {
    if (s == null) return '';
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function fmt(n, digits) {
    if (n == null || !isFinite(n)) return '–';
    var d = digits == null ? 0 : digits;
    return Number(n).toLocaleString('ko-KR', {
      minimumFractionDigits: d,
      maximumFractionDigits: d,
    });
  }

  function pct(n, digits) {
    if (n == null || !isFinite(n)) return '–';
    var d = digits == null ? 2 : digits;
    return (n > 0 ? '+' : '') + Number(n).toFixed(d) + '%';
  }

  function pctCls(n) {
    if (n == null || !isFinite(n)) return '';
    return n > 0 ? 'up' : n < 0 ? 'down' : '';
  }

  function toast(msg) {
    var el = $('toast');
    if (!el) return;
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(function () {
      el.classList.remove('show');
    }, 2800);
  }

  function setMsg(msg, isError) {
    var el = $('picker-msg');
    if (!el) return;
    el.textContent = msg || '';
    el.classList.toggle('is-error', !!isError);
  }

  function colorOf(i) {
    return COLORS[i % COLORS.length];
  }

  /* ---------------- 탭 전환 ---------------- */
  function switchView(name, remember) {
    var tabs = document.querySelectorAll('.view-tab');
    for (var i = 0; i < tabs.length; i++) {
      var on = tabs[i].getAttribute('data-view') === name;
      tabs[i].classList.toggle('active', on);
      tabs[i].setAttribute('aria-selected', on ? 'true' : 'false');
    }
    var s = $('view-screener');
    var a = $('view-analysis');
    if (s) {
      s.classList.toggle('active', name === 'screener');
      s.hidden = name !== 'screener';
    }
    if (a) {
      a.classList.toggle('active', name === 'analysis');
      a.hidden = name !== 'analysis';
    }
    if (remember !== false) {
      try {
        localStorage.setItem(LS_TAB, name);
      } catch (e) {}
    }
    if (name === 'analysis') loadAnalysis();
  }

  function bindTabs() {
    document.addEventListener('click', function (e) {
      var t = e.target;
      if (!t || !t.closest) return;
      var tab = t.closest('.view-tab');
      if (tab) switchView(tab.getAttribute('data-view'));
    });
  }

  /* ---------------- 종목 선택 저장/복원 ---------------- */
  function saveSelection() {
    try {
      localStorage.setItem(
        LS_STOCKS,
        JSON.stringify(
          state.stocks.map(function (s) {
            return { code: s.code, name: s.name };
          })
        )
      );
    } catch (e) {}
  }

  function readSelection() {
    try {
      var raw = localStorage.getItem(LS_STOCKS);
      if (!raw) return null;
      var arr = JSON.parse(raw);
      if (!Array.isArray(arr)) return null;
      var out = [];
      for (var i = 0; i < arr.length && out.length < MAX_STOCKS; i++) {
        var c = arr[i] && arr[i].code;
        var n = arr[i] && arr[i].name;
        if (!/^\d{6}$/.test(String(c))) continue;
        if (
          out.some(function (x) {
            return x.code === c;
          })
        )
          continue;
        out.push({ code: String(c), name: String(n || c) });
      }
      return out.length ? out : null;
    } catch (e) {
      return null;
    }
  }

  /* ---------------- 기본 4종목: 스냅샷에서 즉시 구성 ---------------- */
  function buildFromBase(code) {
    var byDate = {};
    if (DAILY && DAILY.rows) {
      for (var j = 0; j < DAILY.rows.length; j++) {
        var r = DAILY.rows[j];
        byDate[r.date] = r.c && r.c[code] != null ? r.c[code] : null;
      }
    }
    state.closes[code] = DATES.map(function (d) {
      return byDate[d] == null ? null : byDate[d];
    });

    var mm = {};
    (BASE.monthly || []).forEach(function (m) {
      mm[m.ym] = m.c && m.c[code] != null ? m.c[code] : null;
    });
    state.monthly[code] = mm;

    var aa = {};
    (BASE.annual || []).forEach(function (a) {
      aa[a.year] = a.c && a.c[code] != null ? a.c[code] : null;
    });
    state.annual[code] = aa;

    var p = BASE.period ? BASE.period[code] : null;
    state.period[code] = p || computePeriod(state.closes[code]);
  }

  /** 기간 최고/최저(종가 기준)을 배열에서 직접 계산 (추가 종목 대비 안전망) */
  function computePeriod(closes) {
    var hi = null,
      hiD = null,
      lo = null,
      loD = null;
    for (var i = 0; i < closes.length; i++) {
      var v = closes[i];
      if (v == null) continue;
      if (hi == null || v > hi) {
        hi = v;
        hiD = DATES[i];
      }
      if (lo == null || v < lo) {
        lo = v;
        loD = DATES[i];
      }
    }
    return {
      closeHigh: hi,
      closeHighDate: hiD,
      closeLow: lo,
      closeLowDate: loD,
      highIntraday: null,
      highIntradayDate: null,
    };
  }

  function isDefault(code) {
    return DEFAULT_STOCKS.some(function (s) {
      return s.code === code;
    });
  }

  /* ---------------- 추가 종목: 런타임 수집 ---------------- */
  function fetchStockSeries(code) {
    if (state.closes[code]) return Promise.resolve();
    return fetch('/api/prices/stock/' + encodeURIComponent(code))
      .then(function (r) {
        return r.json().then(function (body) {
          if (!r.ok) throw new Error(body && body.message ? body.message : 'HTTP ' + r.status);
          return body;
        });
      })
      .then(function (d) {
        var closes = Array.isArray(d.closes) ? d.closes.slice(0, DATES.length) : [];
        while (closes.length < DATES.length) closes.push(null);
        state.closes[code] = closes;
        state.monthly[code] = d.monthly || {};
        state.annual[code] = d.annual || {};
        state.period[code] = d.period || computePeriod(closes);
      });
  }

  /* ---------------- 메인 로드 ---------------- */
  function loadAnalysis() {
    if (loaded) {
      setTimeout(resizeCharts, 30);
      return;
    }
    loaded = true;

    Promise.all([
      fetch('/api/prices').then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      }),
      fetch('/api/prices/daily').then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      }),
    ])
      .then(function (res) {
        BASE = res[0];
        DAILY = res[1];
        APP_VER = (BASE && BASE.version) || '';
        DATES = (DAILY.rows || []).map(function (r) {
          return r.date;
        });

        // 기본 종목 시리즈 구성
        DEFAULT_STOCKS.forEach(function (s) {
          buildFromBase(s.code);
        });

        // 저장된 선택 복원 (없으면 기본 4종목)
        var saved = readSelection();
        state.stocks = saved ? saved : DEFAULT_STOCKS.slice();

        // 스냅샷에 없는(추가했던) 종목은 런타임 수집
        var need = state.stocks.filter(function (s) {
          return !isDefault(s.code) && !state.closes[s.code];
        });
        return Promise.all(
          need.map(function (s) {
            return fetchStockSeries(s.code)
              .then(function () {
                var nm = NAMES && findName(s.code);
                if (nm) s.name = nm;
              })
              .catch(function () {
                /* 실패한 종목은 아래에서 제거 */
              });
          })
        ).then(function () {
          // 로드 실패한 종목 정리
          state.stocks = state.stocks.filter(function (s) {
            return !!state.closes[s.code];
          });
          if (!state.stocks.length) state.stocks = DEFAULT_STOCKS.slice();
          renderAll();
        });
      })
      .catch(function (err) {
        loaded = false;
        var box = $('summary-cards');
        if (box) {
          box.innerHTML =
            '<p class="muted">분석 데이터를 불러오지 못했습니다: ' + esc(err.message) + '</p>';
        }
      });
  }

  function findName(code) {
    if (!NAMES) return null;
    for (var i = 0; i < NAMES.length; i++) {
      if (NAMES[i][0] === code) return NAMES[i][1];
    }
    return null;
  }

  /* ---------------- 전체 렌더 ---------------- */
  function renderAll() {
    renderPicker();
    renderSummaryCards();
    renderSummaryTable();
    renderMonthlyTable();
    renderAnnualTable();
    renderCharts();
    if (charts.daily) setTimeout(resizeCharts, 30);
  }

  /* ---------------- 종목 칩 ---------------- */
  function renderPicker() {
    var box = $('picked-stocks');
    if (!box) return;

    if (!state.stocks.length) {
      box.innerHTML = '<span class="picked-empty">분석할 종목이 없습니다.</span>';
      return;
    }

    var html = state.stocks
      .map(function (s, i) {
        return (
          '<span class="picked-chip" data-code="' +
          esc(s.code) +
          '" style="--chip-accent:' +
          colorOf(i) +
          '">' +
          '<span class="dot" aria-hidden="true"></span>' +
          '<span class="nm">' +
          esc(s.name) +
          '</span>' +
          '<span class="cd">' +
          esc(s.code) +
          '</span>' +
          '<button type="button" class="chip-x" data-remove="' +
          esc(s.code) +
          '" aria-label="' +
          esc(s.name) +
          ' 삭제">✕</button>' +
          '</span>'
        );
      })
      .join('');

    if (state.stocks.length >= MAX_STOCKS) {
      html += '<span class="picked-limit">최대 ' + MAX_STOCKS + '종목</span>';
    }

    box.innerHTML = html;
  }

  /* ---------------- 한눈에 보기: 카드 ---------------- */
  function renderSummaryCards() {
    var box = $('summary-cards');
    if (!box || !state.stocks.length) return;

    var html = state.stocks
      .map(function (s, i) {
        var m = metrics(s.code);
        return (
          '<article class="summary-card" style="--card-accent:' +
          colorOf(i) +
          '">' +
          '<header class="summary-card-head">' +
          '<span class="summary-name">' +
          esc(s.name) +
          '</span>' +
          '<span class="summary-code">' +
          esc(s.code) +
          '</span>' +
          '<button type="button" class="card-x" data-remove="' +
          esc(s.code) +
          '" aria-label="' +
          esc(s.name) +
          ' 삭제" title="삭제">✕</button>' +
          '</header>' +
          '<p class="summary-price">' +
          fmt(m.last) +
          '<span class="unit">원</span></p>' +
          '<p class="summary-date">' +
          esc(m.lastDate || '') +
          ' 종가</p>' +
          '<dl class="summary-grid">' +
          '<div><dt>2023년말 대비</dt><dd class="' +
          pctCls(m.vs2023Pct) +
          '">' +
          pct(m.vs2023Pct, 2) +
          '</dd></div>' +
          '<div><dt>2025년말 대비</dt><dd class="' +
          pctCls(m.vs2025Pct) +
          '">' +
          pct(m.vs2025Pct, 2) +
          '</dd></div>' +
          '<div><dt>2026 YTD</dt><dd class="' +
          pctCls(m.y2026Pct) +
          '">' +
          pct(m.y2026Pct, 2) +
          '</dd></div>' +
          '<div><dt>기간 최고가</dt><dd>' +
          fmt(m.closeHigh) +
          '</dd></div>' +
          '</dl>' +
          '</article>'
        );
      })
      .join('');

    box.innerHTML = html;
  }

  /* ---------------- 종목별 지표 계산 ---------------- */
  function metrics(code) {
    var closes = state.closes[code] || [];
    var annual = state.annual[code] || {};
    var period = state.period[code] || {};

    // 최신 종가 = 마지막 비결측 값
    var last = null;
    var lastDate = null;
    for (var i = closes.length - 1; i >= 0; i--) {
      if (closes[i] != null) {
        last = closes[i];
        lastDate = DATES[i];
        break;
      }
    }

    function ratio(cur, base) {
      if (cur == null || base == null || base === 0) return null;
      return Number((((cur - base) / base) * 100).toFixed(2));
    }

    var a2023 = annual['2023'];
    var a2025 = annual['2025'];
    var a2026 = annual['2026'];

    return {
      last: last,
      lastDate: lastDate,
      vs2023Pct: ratio(last, a2023),
      vs2025Pct: ratio(last, a2025),
      // 2026 은 연초 대비(YTD) — 연간 시리즈의 전년도(2025) 종가 대비로 계산
      y2026Pct: ratio(a2026, a2025),
      closeHigh: period.closeHigh,
      closeHighDate: period.closeHighDate,
      closeLow: period.closeLow,
      closeLowDate: period.closeLowDate,
      highIntraday: period.highIntraday,
      highIntradayDate: period.highIntradayDate,
    };
  }

  /* ---------------- 동적 표 헤더 ---------------- */
  function buildHead(rowLabel, opts) {
    var o = opts || {};
    var cls = o.num === false ? '' : ' class="num"';
    return (
      '<tr><th scope="col">' +
      esc(rowLabel) +
      '</th>' +
      state.stocks
        .map(function (s, i) {
          return (
            '<th scope="col"' +
            cls +
            (o.color === false
              ? ''
              : ' style="border-top:3px solid ' + colorOf(i) + '"') +
            '>' +
            esc(s.name) +
            (o.showCode === false
              ? ''
              : ' <span class="th-code">' + esc(s.code) + '</span>') +
            '</th>'
          );
        })
        .join('') +
      '</tr>'
    );
  }

  /* ---------------- 한눈에 보기: 지표 표 ---------------- */
  function renderSummaryTable() {
    var head = $('summary-table-head');
    var body = $('summary-table-body');
    if (!body || !state.stocks.length) return;

    if (head) head.innerHTML = buildHead('지표');

    /**
     * 표 한 줄 생성.
     * @param label  행 제목
     * @param render 값 → 표시 문자열
     * @param raw    (선택) 값 → 색상 판정에 쓸 원본 숫자
     */
    function row(label, render, raw) {
      var tds = state.stocks
        .map(function (s) {
          var m = metrics(s.code);
          var shown = render(m);
          var cls = raw ? pctCls(raw(m)) : '';
          return '<td class="num ' + cls + '">' + shown + '</td>';
        })
        .join('');
      return '<tr><th scope="row">' + esc(label) + '</th>' + tds + '</tr>';
    }

    var html = '';
    html += row('최신 종가 (원)', function (m) {
      return fmt(m.last);
    });
    html += row(
      '2023년말 대비',
      function (m) {
        return pct(m.vs2023Pct, 2);
      },
      function (m) {
        return m.vs2023Pct;
      }
    );
    html += row(
      '2025년말 대비',
      function (m) {
        return pct(m.vs2025Pct, 2);
      },
      function (m) {
        return m.vs2025Pct;
      }
    );
    html += row(
      '2026 YTD',
      function (m) {
        return pct(m.y2026Pct, 2);
      },
      function (m) {
        return m.y2026Pct;
      }
    );
    html += row('기간 최고가 (종가)', function (m) {
      return fmt(m.closeHigh);
    });
    html += row('기간 최고가 일자', function (m) {
      return esc(m.closeHighDate || '–');
    });
    html += row('기간 최저가 (종가)', function (m) {
      return fmt(m.closeLow);
    });
    html += row('장중 최고가', function (m) {
      return fmt(m.highIntraday);
    });
    body.innerHTML = html;
  }

  /* ---------------- 월별 종가 표 ---------------- */
  function renderMonthlyTable() {
    var head = $('monthly-table-head');
    var body = $('monthly-table-body');
    if (!body || !state.stocks.length) return;

    if (head) head.innerHTML = buildHead('연-월', { showCode: false });

    var yms = (BASE.monthly || []).map(function (m) {
      return m.ym;
    });

    var rows = [];
    for (var i = yms.length - 1; i >= 0; i--) {
      var ym = yms[i];
      var prevYm = i > 0 ? yms[i - 1] : null;
      var tds = state.stocks
        .map(function (s) {
          var series = state.monthly[s.code] || {};
          var v = series[ym];
          var p = prevYm ? series[prevYm] : null;
          var r = v != null && p != null && p !== 0 ? ((v - p) / p) * 100 : null;
          return (
            '<td class="num">' +
            fmt(v) +
            (r == null
              ? ''
              : ' <span class="mini-chg ' + pctCls(r) + '">' + pct(r, 1) + '</span>') +
            '</td>'
          );
        })
        .join('');
      rows.push('<tr><th scope="row">' + esc(ym) + '</th>' + tds + '</tr>');
    }
    body.innerHTML = rows.join('');
  }

  /* ---------------- 연간 표 ---------------- */
  function renderAnnualTable() {
    var head = $('annual-table-head');
    var body = $('annual-table-body');
    if (!body || !state.stocks.length) return;

    if (head) head.innerHTML = buildHead('연도', { showCode: false });

    var years = (BASE.annual || []).map(function (a) {
      return a.year;
    });

    var html = years
      .map(function (year, i) {
        var prevYear = i > 0 ? years[i - 1] : null;
        var tds = state.stocks
          .map(function (s) {
            var series = state.annual[s.code] || {};
            var v = series[year];
            var p = prevYear ? series[prevYear] : null;
            // 연간 수익률은 소수 비율 (0.7911 = +79.11%) — 엑셀 원본 규격과 동일
            var r = v != null && p != null && p !== 0 ? (v - p) / p : null;
            var rp = r == null ? null : r * 100;
            return (
              '<td class="num">' +
              fmt(v) +
              (rp == null
                ? ''
                : ' <span class="mini-chg ' + pctCls(rp) + '">' + pct(rp, 1) + '</span>') +
              '</td>'
            );
          })
          .join('');
        var label = year + (year === '2026' ? ' <span class="hint">YTD</span>' : '');
        return '<tr><th scope="row">' + label + '</th>' + tds + '</tr>';
      })
      .join('');
    body.innerHTML = html;
  }

  /* ---------------- 차트 ---------------- */
  function chartReady() {
    return typeof window.Chart !== 'undefined';
  }

  function axisOpts(logScale) {
    return {
      x: {
        grid: { display: false },
        ticks: { maxTicksLimit: 8, font: { size: 10 }, autoSkip: true },
      },
      y: {
        type: logScale ? 'logarithmic' : 'linear',
        grid: { color: '#eef1f5' },
        ticks: {
          font: { size: 10 },
          callback: function (v) {
            if (v >= 10000) return Math.round(v / 10000) + '만';
            return v;
          },
        },
      },
    };
  }

  function legendOpts() {
    return { position: 'top', labels: { boxWidth: 12, font: { size: 11 }, usePointStyle: true, pointStyle: 'line' } };
  }

  function renderCharts() {
    if (!BASE || !DAILY || !state.stocks.length) return;

    if (!chartReady()) {
      clearTimeout(renderCharts._rt);
      renderCharts._tries = (renderCharts._tries || 0) + 1;
      if (renderCharts._tries <= 40) {
        renderCharts._rt = setTimeout(renderCharts, 250);
      } else {
        var box = $('analysis-chart-daily');
        if (box && !box.querySelector('.chart-fallback')) {
          box.insertAdjacentHTML(
            'beforeend',
            '<p class="muted chart-fallback" style="font-size:12px">차트 라이브러리를 불러오지 못했습니다. 새로고침해 주세요.</p>'
          );
        }
      }
      return;
    }
    renderCharts._tries = 0;

    var stocks = state.stocks;
    var logOn = $('chk-log') && $('chk-log').checked;

    /* ── 그래프 1: 일별 (기간 필터 + 로그 스케일) ── */
    var rangeSel = $('sel-range');
    var range = rangeSel ? rangeSel.value : 'ALL';
    var idxs = DATES.map(function (_, i) {
      return i;
    });
    if (range !== 'ALL') {
      var months = range === '3M' ? 3 : range === '6M' ? 6 : 12;
      var last = DATES[DATES.length - 1];
      var cut = new Date(last + 'T00:00:00Z');
      cut.setUTCMonth(cut.getUTCMonth() - months);
      var iso = cut.toISOString().slice(0, 10);
      idxs = idxs.filter(function (i) {
        return DATES[i] >= iso;
      });
    }

    var labels = idxs.map(function (i) {
      return DATES[i];
    });

    var ctx1 = $('chart-daily');
    if (ctx1) {
      if (charts.daily) charts.daily.destroy();
      charts.daily = new Chart(ctx1, {
        type: 'line',
        data: {
          labels: labels,
          datasets: stocks.map(function (s, i) {
            var series = state.closes[s.code] || [];
            return {
              label: s.name,
              data: idxs.map(function (k) {
                return series[k];
              }),
              borderColor: colorOf(i),
              backgroundColor: 'transparent',
              borderWidth: 1.8,
              pointRadius: 0,
              pointHoverRadius: 4,
              tension: 0.1,
              spanGaps: true,
            };
          }),
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          interaction: { mode: 'index', intersect: false },
          plugins: {
            legend: legendOpts(),
            tooltip: {
              callbacks: {
                label: function (c) {
                  return c.dataset.label + ': ' + fmt(c.parsed.y) + '원';
                },
              },
            },
          },
          scales: axisOpts(logOn),
        },
      });
    }

    /* ── 그래프 2: 월별 ── */
    var ctx2 = $('chart-monthly');
    if (ctx2) {
      if (charts.monthly) charts.monthly.destroy();
      var yms = (BASE.monthly || []).map(function (m) {
        return m.ym;
      });
      charts.monthly = new Chart(ctx2, {
        type: 'line',
        data: {
          labels: yms,
          datasets: stocks.map(function (s, i) {
            var series = state.monthly[s.code] || {};
            return {
              label: s.name,
              data: yms.map(function (ym) {
                return series[ym] == null ? null : series[ym];
              }),
              borderColor: colorOf(i),
              backgroundColor: 'transparent',
              borderWidth: 2,
              pointRadius: 2,
              pointHoverRadius: 5,
              tension: 0.2,
              spanGaps: true,
            };
          }),
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          interaction: { mode: 'index', intersect: false },
          plugins: {
            legend: legendOpts(),
            tooltip: {
              callbacks: {
                label: function (c) {
                  return c.dataset.label + ': ' + fmt(c.parsed.y) + '원';
                },
              },
            },
          },
          scales: axisOpts(logOn),
        },
      });
    }

    /* ── 그래프 3: 연간 수익률 (막대) ── */
    var ctx3 = $('chart-annual');
    if (ctx3) {
      if (charts.annual) charts.annual.destroy();
      var years = (BASE.annual || []).map(function (a) {
        return a.year;
      });
      // 첫 해는 기준연도라 수익률이 없다 → 제외
      var shown = years.slice(1);

      charts.annual = new Chart(ctx3, {
        type: 'bar',
        data: {
          labels: shown.map(function (y) {
            return y + (y === '2026' ? ' (YTD)' : '');
          }),
          datasets: stocks.map(function (s, i) {
            var series = state.annual[s.code] || {};
            return {
              label: s.name,
              data: shown.map(function (y) {
                var idx = years.indexOf(y);
                var prevY = idx > 0 ? years[idx - 1] : null;
                var v = series[y];
                var p = prevY ? series[prevY] : null;
                if (v == null || p == null || p === 0) return null;
                return Number((((v - p) / p) * 100).toFixed(2));
              }),
              backgroundColor: colorOf(i),
              borderRadius: 3,
              barPercentage: 0.82,
            };
          }),
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: legendOpts(),
            tooltip: {
              callbacks: {
                label: function (c) {
                  return c.dataset.label + ': ' + pct(c.parsed.y, 2);
                },
              },
            },
          },
          scales: {
            x: { grid: { display: false }, ticks: { font: { size: 11 } } },
            y: {
              grid: { color: '#eef1f5' },
              ticks: {
                font: { size: 10 },
                callback: function (v) {
                  return v + '%';
                },
              },
            },
          },
        },
      });
    }
  }

  function resizeCharts() {
    Object.keys(charts).forEach(function (k) {
      if (charts[k]) charts[k].resize();
    });
  }

  /* ---------------- 종목 추가 / 삭제 ---------------- */
  function ensureNames() {
    if (NAMES || namesLoading) return;
    namesLoading = true;
    fetch('/api/stocks/names')
      .then(function (r) {
        return r.ok ? r.json() : { rows: [] };
      })
      .then(function (d) {
        NAMES = Array.isArray(d.rows) ? d.rows : [];
        // 인덱스가 늦게 도착한 경우: 이미 입력된 검색어가 있으면 목록을 다시 그린다.
        // (이 재렌더가 없으면 "타이핑 → 로드 완료" 순서에서 자동완성이 영영 비어 있었다)
        var input = $('add-stock-input');
        if (input && input.value && document.activeElement === input) {
          renderSuggest(searchNames(input.value));
        }
      })
      .catch(function () {
        NAMES = [];
      });
  }

  function searchNames(q) {
    if (!NAMES) return [];
    var key = String(q || '').trim().toLowerCase();
    if (!key) return [];
    var out = [];
    for (var i = 0; i < NAMES.length && out.length < 8; i++) {
      var code = NAMES[i][0];
      var name = NAMES[i][1] || '';
      if (name.toLowerCase().indexOf(key) >= 0 || code.indexOf(key) === 0) {
        out.push([code, name]);
      }
    }
    return out;
  }

  function renderSuggest(list) {
    var box = $('add-stock-suggest');
    if (!box) return;
    if (!list.length) {
      box.hidden = true;
      box.innerHTML = '';
      return;
    }
    box.innerHTML = list
      .map(function (r) {
        var added = state.stocks.some(function (s) {
          return s.code === r[0];
        });
        return (
          '<button type="button" class="suggest-item' +
          (added ? ' is-added' : '') +
          '" role="option" data-pick="' +
          esc(r[0]) +
          '" aria-selected="false">' +
          '<span class="nm">' +
          esc(r[1]) +
          '</span>' +
          '<span class="cd">' +
          esc(r[0]) +
          (added ? ' · 추가됨' : '') +
          '</span>' +
          '</button>'
        );
      })
      .join('');
    box.hidden = false;
  }

  function addStock(code, name) {
    if (
      state.stocks.some(function (s) {
        return s.code === code;
      })
    ) {
      setMsg('이미 분석 중인 종목입니다.', true);
      return;
    }
    if (state.stocks.length >= MAX_STOCKS) {
      setMsg('최대 ' + MAX_STOCKS + '종목까지 추가할 수 있습니다.', true);
      return;
    }

    var label = name || code;
    setMsg(label + ' 종가를 불러오는 중…');
    fetchStockSeries(code)
      .then(function () {
        var resolved = name || findName(code) || code;
        state.stocks.push({ code: code, name: resolved });
        saveSelection();
        renderAll();
        setMsg(resolved + ' 추가했습니다. (' + state.stocks.length + '/' + MAX_STOCKS + ')');
        var input = $('add-stock-input');
        if (input) {
          input.value = '';
          input.focus();
        }
        renderSuggest([]);
      })
      .catch(function (e) {
        setMsg(e && e.message ? e.message : '종가를 불러오지 못했습니다.', true);
      });
  }

  function removeStock(code) {
    if (state.stocks.length <= 1) {
      setMsg('최소 1종목은 남겨야 합니다.', true);
      return;
    }
    var target = state.stocks.filter(function (s) {
      return s.code === code;
    })[0];
    state.stocks = state.stocks.filter(function (s) {
      return s.code !== code;
    });
    saveSelection();
    renderAll();
    setMsg((target ? target.name : code) + ' 삭제했습니다.');
  }

  function restoreDefault() {
    state.stocks = DEFAULT_STOCKS.slice();
    saveSelection();
    renderAll();
    setMsg('기본 4종목으로 되돌렸습니다.');
  }

  /* ---------------- 이벤트 ---------------- */
  var actionsBound = false;

  function bindActions() {
    if (actionsBound) return;
    actionsBound = true;

    var sel = $('sel-range');
    if (sel) sel.addEventListener('change', renderCharts);

    var log = $('chk-log');
    if (log) log.addEventListener('change', renderCharts);

    var rep = $('btn-report');
    if (rep) rep.addEventListener('click', downloadReport);

    var pr = $('btn-print');
    if (pr)
      pr.addEventListener('click', function () {
        window.print();
      });

    var xl = $('btn-xlsx');
    if (xl) xl.addEventListener('click', downloadXlsx);

    var rst = $('btn-restore-default');
    if (rst) rst.addEventListener('click', restoreDefault);

    /* 종목 검색 */
    var input = $('add-stock-input');
    if (input) {
      input.addEventListener('focus', function () {
        ensureNames();
      });
      input.addEventListener('input', function () {
        ensureNames();
        renderSuggest(searchNames(input.value));
      });
      input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {
          e.preventDefault();
          var list = searchNames(input.value);
          if (list.length) addStock(list[0][0], list[0][1]);
        } else if (e.key === 'Escape') {
          renderSuggest([]);
        }
      });
      input.addEventListener('blur', function () {
        setTimeout(function () {
          renderSuggest([]);
        }, 160);
      });
    }

    /* 자동완성 클릭 */
    var sug = $('add-stock-suggest');
    if (sug) {
      sug.addEventListener('mousedown', function (e) {
        var b = e.target.closest ? e.target.closest('[data-pick]') : null;
        if (!b) return;
        e.preventDefault();
        var code = b.getAttribute('data-pick');
        var nm = b.querySelector('.nm');
        addStock(code, nm ? nm.textContent : null);
      });
    }

    /* 삭제 (칩 + 카드 공통 위임) — 동적 렌더라 문서 레벨 위임 사용 */
    document.addEventListener('click', function (e) {
      var t = e.target;
      if (!t || !t.closest) return;
      var btn = t.closest('[data-remove]');
      if (btn) {
        e.preventDefault();
        removeStock(btn.getAttribute('data-remove'));
      }
    });

    window.addEventListener('resize', function () {
      clearTimeout(bindActions._rt);
      bindActions._rt = setTimeout(resizeCharts, 200);
    });
  }

  /* ---------------- 보고서 다운로드 (자기완결 HTML) ---------------- */
  function downloadReport() {
    if (!BASE || !state.stocks.length) {
      toast('분석 데이터를 아직 불러오지 못했습니다.');
      return;
    }

    var meta = BASE.meta;
    var stocks = state.stocks;
    var names = stocks.map(function (s) {
      return s.name;
    });

    var css =
      'body{font-family:-apple-system,BlinkMacSystemFont,"Malgun Gothic","Apple SD Gothic Neo",sans-serif;' +
      'margin:0 auto;padding:32px 28px;color:#1a2233;background:#fff;line-height:1.55;max-width:1100px}' +
      'h1{font-size:22px;margin:0 0 6px;letter-spacing:-0.5px}' +
      'h2{font-size:15px;margin:28px 0 10px;padding-bottom:6px;border-bottom:2px solid #1a56db;color:#1a56db}' +
      'h3{font-size:13px;margin:18px 0 8px;color:#334155}' +
      '.sub{font-size:12px;color:#64748b;margin:0 0 4px}' +
      '.note{font-size:11px;color:#94a3b8;margin:6px 0 0}' +
      'table{width:100%;border-collapse:collapse;font-size:11.5px;margin:8px 0 0}' +
      'th,td{border:1px solid #e2e8f0;padding:6px 8px;text-align:right;font-variant-numeric:tabular-nums}' +
      'th:first-child,td:first-child{text-align:left;background:#f8fafc;font-weight:600}' +
      'thead th{background:#f1f5f9;font-weight:700;color:#334155}' +
      '.up{color:#d92b2b;font-weight:700}.down{color:#1668c9;font-weight:700}' +
      '.cards{display:flex;gap:12px;flex-wrap:wrap;margin:12px 0}' +
      '.card{flex:1 1 200px;border:1px solid #e2e8f0;border-left:4px solid #1a56db;border-radius:6px;padding:12px 14px}' +
      '.card .nm{font-size:13px;font-weight:800}.card .cd{font-size:10.5px;color:#94a3b8}' +
      '.card .pr{font-size:19px;font-weight:800;margin:6px 0 2px;font-variant-numeric:tabular-nums}' +
      '.card .u{font-size:11px;font-weight:600;color:#64748b;margin-left:2px}' +
      '.kv{font-size:11px;color:#475569;margin-top:4px}' +
      '.foot{margin-top:30px;padding-top:10px;border-top:1px solid #e2e8f0;font-size:10.5px;color:#94a3b8}' +
      '@media print{body{padding:0}.card{break-inside:avoid}table{break-inside:auto}tr{break-inside:avoid}}';

    function cls(v) {
      return v == null ? '' : v > 0 ? 'up' : v < 0 ? 'down' : '';
    }
    function pc(v, d) {
      if (v == null) return '–';
      return (v > 0 ? '+' : '') + Number(v).toFixed(d == null ? 2 : d) + '%';
    }

    var html = '';
    html += '<!doctype html><html lang="ko"><head><meta charset="utf-8">';
    html += '<title>코스피 종목 분석 보고서</title>';
    html += '<style>' + css + '</style></head><body>';

    html += '<h1>코스피 종목 분석 보고서</h1>';
    html +=
      '<p class="sub">기준일: ' +
      esc(meta.end || '') +
      ' (종가) · 기간: ' +
      esc(meta.start || '') +
      ' ~ ' +
      esc(meta.end || '') +
      ' · ' +
      names.map(esc).join(' · ') +
      '</p>';
    html += '<p class="sub">출처: ' + esc(meta.source) + ' · 집계 ' + esc(meta.collectedAt) + '</p>';
    if (APP_VER) {
      html += '<p class="sub">코스피 종목 분석 v' + esc(APP_VER) + '</p>';
    }
    html += '<p class="note">※ 참고용 자료이며 투자 권유가 아닙니다.</p>';

    /* 1. 카드 */
    html += '<h2>1. 한눈에 보기</h2>';
    html += '<div class="cards">';
    stocks.forEach(function (s, i) {
      var m = metrics(s.code);
      html +=
        '<div class="card" style="border-left-color:' +
        colorOf(i) +
        '">' +
        '<div class="nm">' +
        esc(s.name) +
        ' <span class="cd">' +
        esc(s.code) +
        '</span></div>' +
        '<div class="pr">' +
        fmt(m.last) +
        '<span class="u">원</span></div>' +
        '<div class="kv">2023년말 대비 <b class="' +
        cls(m.vs2023Pct) +
        '">' +
        pc(m.vs2023Pct) +
        '</b></div>' +
        '<div class="kv">2025년말 대비 <b class="' +
        cls(m.vs2025Pct) +
        '">' +
        pc(m.vs2025Pct) +
        '</b></div>' +
        '<div class="kv">2026 YTD <b class="' +
        cls(m.y2026Pct) +
        '">' +
        pc(m.y2026Pct) +
        '</b></div>' +
        '<div class="kv">기간 최고가 ' +
        fmt(m.closeHigh) +
        '</div>' +
        '</div>';
    });
    html += '</div>';

    /* 2. 지표 표 */
    html += '<h3>주요 지표</h3>';
    html += '<table><thead><tr><th>지표</th>';
    stocks.forEach(function (s) {
      html += '<th>' + esc(s.name) + '</th>';
    });
    html += '</tr></thead><tbody>';

    function trow(label, getter, klass) {
      html += '<tr><th>' + esc(label) + '</th>';
      stocks.forEach(function (s) {
        var m = metrics(s.code);
        html += '<td class="' + (klass ? klass(m) : '') + '">' + getter(m) + '</td>';
      });
      html += '</tr>';
    }
    trow('최신 종가 (원)', function (m) {
      return fmt(m.last);
    });
    trow(
      '2023년말 대비',
      function (m) {
        return pc(m.vs2023Pct);
      },
      function (m) {
        return cls(m.vs2023Pct);
      }
    );
    trow(
      '2025년말 대비',
      function (m) {
        return pc(m.vs2025Pct);
      },
      function (m) {
        return cls(m.vs2025Pct);
      }
    );
    trow(
      '2026 YTD',
      function (m) {
        return pc(m.y2026Pct);
      },
      function (m) {
        return cls(m.y2026Pct);
      }
    );
    trow('기간 최고가 (종가)', function (m) {
      return fmt(m.closeHigh);
    });
    trow('기간 최저가 (종가)', function (m) {
      return fmt(m.closeLow);
    });
    html += '</tbody></table>';

    /* 3. 연간 */
    var years = (BASE.annual || []).map(function (a) {
      return a.year;
    });
    html += '<h2>2. 연간 종가 및 수익률</h2>';
    html += '<p class="note">연말 종가 기준. 2026년은 연초 대비(YTD).</p>';
    html += '<table><thead><tr><th>연도</th>';
    stocks.forEach(function (s) {
      html += '<th>' + esc(s.name) + ' 종가</th><th>' + esc(s.name) + ' 수익률</th>';
    });
    html += '</tr></thead><tbody>';
    years.forEach(function (y, yi) {
      var prevY = yi > 0 ? years[yi - 1] : null;
      html += '<tr><th>' + esc(y) + (y === '2026' ? ' (YTD)' : '') + '</th>';
      stocks.forEach(function (s) {
        var series = state.annual[s.code] || {};
        var v = series[y];
        var p = prevY ? series[prevY] : null;
        var r = v != null && p != null && p !== 0 ? (v - p) / p : null;
        var rp = r == null ? null : r * 100;
        html += '<td>' + fmt(v) + '</td>';
        html += '<td class="' + cls(rp) + '">' + pc(rp) + '</td>';
      });
      html += '</tr>';
    });
    html += '</tbody></table>';

    /* 4. 월별 */
    html += '<h2>3. 월별 종가</h2>';
    html += '<p class="note">각 월 마지막 거래일 종가 · 단위 원.</p>';
    html += '<table><thead><tr><th>연-월</th>';
    stocks.forEach(function (s) {
      html += '<th>' + esc(s.name) + '</th>';
    });
    html += '</tr></thead><tbody>';
    (BASE.monthly || []).forEach(function (m) {
      html += '<tr><th>' + esc(m.ym) + '</th>';
      stocks.forEach(function (s) {
        var series = state.monthly[s.code] || {};
        html += '<td>' + fmt(series[m.ym]) + '</td>';
      });
      html += '</tr>';
    });
    html += '</tbody></table>';

    html +=
      '<div class="foot">코스피 종목 분석 · made by 최미경 · ' +
      esc(meta.source) +
      (APP_VER ? ' · v' + esc(APP_VER) : '') +
      '</div>';
    html += '</body></html>';

    saveBlob(
      html,
      'text/html;charset=utf-8;',
      '코스피_종목분석_보고서_' + (meta.end || '').replace(/-/g, '') + '.html'
    );
    toast('보고서(HTML)를 내려받았습니다. 브라우저에서 PDF로 인쇄할 수 있습니다.');
  }

  function saveBlob(content, mime, filename) {
    var blob = new Blob([content], { type: mime });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () {
      URL.revokeObjectURL(url);
    }, 1500);
  }

  /* ---------------- 엑셀 다운로드 (5시트) ---------------- */
  function downloadXlsx() {
    if (typeof window.XLSX === 'undefined') {
      toast('엑셀 라이브러리를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.');
      return;
    }
    if (!BASE || !DAILY || !state.stocks.length) {
      toast('분석 데이터를 아직 불러오지 못했습니다.');
      return;
    }

    var XLSX = window.XLSX;
    var wb = XLSX.utils.book_new();
    var meta = BASE.meta;
    var stocks = state.stocks;
    var codes = stocks.map(function (s) {
      return s.code;
    });
    var headers = stocks.map(function (s) {
      return s.name + ' (' + s.code + ')';
    });
    var years = (BASE.annual || []).map(function (a) {
      return a.year;
    });
    var yms = (BASE.monthly || []).map(function (m) {
      return m.ym;
    });

    function aoaToSheet(aoa, widths) {
      var ws = XLSX.utils.aoa_to_sheet(aoa);
      if (widths)
        ws['!cols'] = widths.map(function (w) {
          return { wch: w };
        });
      return ws;
    }

    function monthRow(ym) {
      return [ym].concat(
        codes.map(function (c) {
          var series = state.monthly[c] || {};
          var v = series[ym];
          return v == null ? null : v;
        })
      );
    }

    function yearRow(y) {
      return [Number(y)].concat(
        codes.map(function (c) {
          var series = state.annual[c] || {};
          var v = series[y];
          return v == null ? null : v;
        })
      );
    }

    function yearRetRow(y) {
      var yi = years.indexOf(y);
      var prevY = yi > 0 ? years[yi - 1] : null;
      return codes.map(function (c) {
        var series = state.annual[c] || {};
        var v = series[y];
        var p = prevY ? series[prevY] : null;
        if (v == null || p == null || p === 0) return null;
        return Number(((v - p) / p).toFixed(6));
      });
    }

    var mAll = stocks.map(function (s) {
      return metrics(s.code);
    });

    /* ── 시트 1: 한장보고 ── */
    var s1 = [];
    s1.push(['코스피 종목 분석 (한눈에 보기)']);
    s1.push([
      '기준일: ' +
        (meta.end || '') +
        ' (종가)  |  기간: ' +
        (meta.start || '') +
        ' ~ ' +
        (meta.end || '') +
        '  |  ' +
        stocks
          .map(function (s) {
            return s.name;
          })
          .join(' · '),
    ]);
    s1.push(['출처: ' + meta.source + '  |  참고용 (투자 권유 아님)  |  made by 최미경' + (APP_VER ? '  |  v' + APP_VER : '')]);
    s1.push([]);
    s1.push(['주요 지표']);
    s1.push(
      ['지표'].concat(
        stocks.map(function (s) {
          return s.name;
        })
      )
    );
    s1.push(
      ['최신 종가 (원)'].concat(
        mAll.map(function (m) {
          return m.last;
        })
      )
    );
    s1.push(
      ['2023년말 대비'].concat(
        mAll.map(function (m) {
          return m.vs2023Pct == null ? null : m.vs2023Pct / 100;
        })
      )
    );
    s1.push(
      ['2025년말 대비'].concat(
        mAll.map(function (m) {
          return m.vs2025Pct == null ? null : m.vs2025Pct / 100;
        })
      )
    );
    s1.push(
      ['2026 YTD'].concat(
        mAll.map(function (m) {
          return m.y2026Pct == null ? null : m.y2026Pct / 100;
        })
      )
    );
    s1.push(
      ['기간 최고가'].concat(
        mAll.map(function (m) {
          return m.closeHigh;
        })
      )
    );
    s1.push(
      ['기간 최저가'].concat(
        mAll.map(function (m) {
          return m.closeLow;
        })
      )
    );
    s1.push([]);
    s1.push(['※ 수익률은 소수 비율 (0.79 = +79%). 엑셀 셀 서식에서 백분율로 표시하세요.']);
    XLSX.utils.book_append_sheet(wb, aoaToSheet(s1, [22, 16, 16, 16, 16, 16, 16, 16, 16]), '한장보고');

    /* ── 시트 2: 전체보고 ── */
    var s2 = [];
    s2.push(['코스피 종목 분석 전체 보고서']);
    s2.push(['상세 데이터 버전  |  기준일: ' + (meta.end || '')]);
    s2.push(['출처: ' + meta.source + (APP_VER ? ' | v' + APP_VER : '')]);
    s2.push([]);
    s2.push(['그래프 1: 일별 종가 추이 (전체 기간)']);
    s2.push(['날짜'].concat(headers));
    DATES.forEach(function (d, i) {
      s2.push(
        [d].concat(
          codes.map(function (c) {
            var series = state.closes[c] || [];
            var v = series[i];
            return v == null ? null : v;
          })
        )
      );
    });
    s2.push([]);
    s2.push(['그래프 2: 월별 종가 추이']);
    s2.push(['연-월'].concat(headers));
    yms.forEach(function (ym) {
      s2.push(monthRow(ym));
    });
    s2.push([]);
    s2.push(['그래프 3: 연간 수익률']);
    s2.push(['연도'].concat(headers));
    years.forEach(function (y) {
      s2.push(yearRow(y));
    });
    XLSX.utils.book_append_sheet(wb, aoaToSheet(s2), '전체보고');

    /* ── 시트 3: 일일종가 ── */
    var s3 = [];
    s3.push(['코스피 종목 분석 일일 종가 (' + (meta.start || '') + ' ~ ' + (meta.end || '') + ')']);
    s3.push(['출처: ' + meta.source + ' | 단위: 원(KRW) | 데이터 기준일: ' + (meta.end || '') + (APP_VER ? ' | v' + APP_VER : '')]);
    s3.push(['날짜'].concat(headers));
    DATES.forEach(function (d, i) {
      s3.push(
        [d].concat(
          codes.map(function (c) {
            var series = state.closes[c] || [];
            var v = series[i];
            return v == null ? null : v;
          })
        )
      );
    });
    XLSX.utils.book_append_sheet(wb, aoaToSheet(s3, [12, 14, 14, 14, 14, 14, 14, 14, 14]), '일일종가');

    /* ── 시트 4: 월별종가 ── */
    var s4 = [];
    s4.push(['월별 종가 (각 월 마지막 거래일 종가)']);
    s4.push(['출처: 일일종가 시트 기준 월말 종가 집계 | 단위: 원(KRW)']);
    s4.push(['연-월'].concat(headers));
    yms.forEach(function (ym) {
      s4.push(monthRow(ym));
    });
    XLSX.utils.book_append_sheet(wb, aoaToSheet(s4, [12, 14, 14, 14, 14, 14, 14, 14, 14]), '월별종가');

    /* ── 시트 5: 연간데이터 ── */
    var s5 = [];
    s5.push(['연간 종가 및 수익률']);
    s5.push([
      '연말 종가 기준 수익률 계산 (소수 비율) | 2026년은 YTD (' + (meta.end || '') + ' 기준)',
    ]);
    var h5 = ['연도'];
    stocks.forEach(function (s) {
      h5.push(s.name + ' 종가');
    });
    stocks.forEach(function (s) {
      h5.push(s.name + ' 수익률');
    });
    s5.push(h5);
    years.forEach(function (y) {
      s5.push(yearRow(y).concat(yearRetRow(y)));
    });
    XLSX.utils.book_append_sheet(
      wb,
      aoaToSheet(s5, [10, 14, 14, 14, 14, 14, 14, 14, 14, 14, 14, 14, 14, 14, 14, 14, 14]),
      '연간데이터'
    );

    var fname =
      '코스피_종목분석_' +
      (meta.end || '').replace(/-/g, '') +
      (APP_VER ? '_v' + APP_VER : '') +
      '.xlsx';
    XLSX.writeFile(wb, fname);
    toast('엑셀 파일을 내려받았습니다. (5개 시트 · ' + stocks.length + '종목)');
  }

  /* ---------------- 시작 ---------------- */
  function init() {
    bindTabs();
    bindActions();
    var saved = null;
    try {
      saved = localStorage.getItem(LS_TAB);
    } catch (e) {}
    switchView(saved === 'screener' ? 'screener' : 'analysis', false);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
