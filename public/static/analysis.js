/**
 * 주요 종목 분석 뷰 클라이언트
 *
 * - 데이터: /api/prices (요약·월별·연간), /api/prices/daily (일별)
 * - 차트: Chart.js (CDN, UMD)
 * - 엑셀: SheetJS (CDN, UMD) — 원본 5시트 구조 재현
 * - 보고서: 자기완결형 HTML 파일 다운로드 (브라우저에서 PDF 인쇄 가능)
 */
(function () {
  'use strict';

  var COLORS = ['#1a56db', '#e0322c', '#0f9d58', '#f5a623'];
  var LS_TAB = 'kospi-screener:view:v1';

  var DATA = null; // /api/prices 응답
  var DAILY = null; // /api/prices/daily 응답
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
    if (n == null) return '';
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
    }, 2600);
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

  /* ---------------- 데이터 로드 ---------------- */
  function loadAnalysis() {
    if (loaded) {
      // 탭을 다시 열 때 차트 크기 재계산
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
        DATA = res[0];
        DAILY = res[1];
        renderSummaryCards();
        renderSummaryTable();
        renderMonthlyTable();
        renderAnnualTable();
        renderCharts();
        bindActions();
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

  /* ---------------- 한눈에 보기: 카드 ---------------- */
  function renderSummaryCards() {
    var box = $('summary-cards');
    if (!box || !DATA) return;
    var html = '';
    DATA.summary.forEach(function (s, i) {
      var color = COLORS[i % COLORS.length];
      html +=
        '<article class="summary-card" style="--card-accent:' + color + '">' +
        '<header class="summary-card-head">' +
        '<span class="summary-name">' + esc(s.name) + '</span>' +
        '<span class="summary-code">' + esc(s.code) + '</span>' +
        '</header>' +
        '<p class="summary-price">' + fmt(s.last) + '<span class="unit">원</span></p>' +
        '<p class="summary-date">' + esc(s.lastDate || '') + ' 종가</p>' +
        '<dl class="summary-grid">' +
        '<div><dt>2023년말 대비</dt><dd class="' + pctCls(s.vs2023Pct) + '">' + pct(s.vs2023Pct, 2) + '</dd></div>' +
        '<div><dt>2025년말 대비</dt><dd class="' + pctCls(s.vs2025Pct) + '">' + pct(s.vs2025Pct, 2) + '</dd></div>' +
        '<div><dt>2026 YTD</dt><dd class="' + pctCls(s.y2026Pct) + '">' + pct(s.y2026Pct, 2) + '</dd></div>' +
        '<div><dt>기간 최고가</dt><dd>' + fmt(s.closeHigh) + '</dd></div>' +
        '</dl>' +
        '</article>';
    });
    box.innerHTML = html;
  }

  /* ---------------- 한눈에 보기: 지표 표 ---------------- */
  function renderSummaryTable() {
    var body = $('summary-table-body');
    if (!body || !DATA) return;

    /**
     * 표 한 줄 생성.
     * @param label  행 제목
     * @param render 값 → 표시 문자열
     * @param raw    (선택) 값 → 색상 판정에 쓸 원본 숫자. 생략 시 색상 없음.
     *
     * ⚠ 주의: 예전 구현은 포맷된 문자열("+171.97%")을 pctCls 에 넘겨서
     *   문자열 비교('+171.97%' > 0 === false)로 색상이 절대 붙지 않았다.
     *   원본 숫자를 따로 받도록 분리해 고쳤다.
     */
    function row(label, render, raw) {
      var tds = DATA.summary
        .map(function (s) {
          var shown = render(s);
          var cls = raw ? pctCls(raw(s)) : '';
          return '<td class="num ' + cls + '">' + shown + '</td>';
        })
        .join('');
      return '<tr><th scope="row">' + esc(label) + '</th>' + tds + '</tr>';
    }

    var html = '';
    html += row('최신 종가 (원)', function (s) {
      return fmt(s.last);
    });
    html += row(
      '2023년말 대비',
      function (s) {
        return pct(s.vs2023Pct, 2);
      },
      function (s) {
        return s.vs2023Pct;
      }
    );
    html += row(
      '2025년말 대비',
      function (s) {
        return pct(s.vs2025Pct, 2);
      },
      function (s) {
        return s.vs2025Pct;
      }
    );
    html += row(
      '2026 YTD',
      function (s) {
        return pct(s.y2026Pct, 2);
      },
      function (s) {
        return s.y2026Pct;
      }
    );
    html += row('기간 최고가 (종가)', function (s) {
      return fmt(s.closeHigh);
    });
    html += row('기간 최고가 일자', function (s) {
      return esc(s.closeHighDate || '–');
    });
    html += row('기간 최저가 (종가)', function (s) {
      return fmt(s.closeLow);
    });
    html += row('장중 최고가', function (s) {
      return fmt(s.highIntraday);
    });
    body.innerHTML = html;
  }

  /* ---------------- 월별 종가 표 ---------------- */
  function renderMonthlyTable() {
    var body = $('monthly-table-body');
    if (!body || !DATA) return;
    var codes = DATA.stocks.map(function (s) {
      return s.code;
    });
    var rows = DATA.monthly
      .slice()
      .reverse()
      .map(function (m) {
        var tds = codes
          .map(function (c) {
            var v = m.c[c];
            var r = m.r ? m.r[c] : null;
            return (
              '<td class="num">' +
              fmt(v) +
              (r == null ? '' : ' <span class="mini-chg ' + pctCls(r) + '">' + pct(r, 1) + '</span>') +
              '</td>'
            );
          })
          .join('');
        return '<tr><th scope="row">' + esc(m.ym) + '</th>' + tds + '</tr>';
      })
      .join('');
    body.innerHTML = rows;
  }

  /* ---------------- 연간 표 ---------------- */
  function renderAnnualTable() {
    var body = $('annual-table-body');
    if (!body || !DATA) return;
    var codes = DATA.stocks.map(function (s) {
      return s.code;
    });
    var html = DATA.annual
      .map(function (a) {
        var tds = codes
          .map(function (c) {
            var v = a.c[c];
            var r = a.r ? a.r[c] : null;
            var rp = r == null ? null : r * 100; // 소수 비율 → %
            return (
              '<td class="num">' +
              fmt(v) +
              (rp == null ? '' : ' <span class="mini-chg ' + pctCls(rp) + '">' + pct(rp, 1) + '</span>') +
              '</td>'
            );
          })
          .join('');
        var label = a.year + (a.year === '2026' ? ' <span class="hint">YTD</span>' : '');
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
            if (v >= 1000000) return Math.round(v / 10000) + '만';
            if (v >= 10000) return Math.round(v / 10000) + '만';
            return v;
          },
        },
      },
    };
  }

  function renderCharts() {
    if (!DATA || !DAILY) return;

    // Chart.js CDN 이 데이터보다 늦게 도착할 수 있다.
    // 예전 구현은 여기서 그냥 return 해버려서 차트가 영영 안 그려졌다.
    if (!chartReady()) {
      clearTimeout(renderCharts._rt);
      renderCharts._tries = (renderCharts._tries || 0) + 1;
      if (renderCharts._tries <= 40) {
        renderCharts._rt = setTimeout(renderCharts, 250);
      } else {
        var box = $('analysis-chart-daily');
        if (box) {
          box.insertAdjacentHTML(
            'beforeend',
            '<p class="muted" style="font-size:12px">차트 라이브러리를 불러오지 못했습니다. 새로고침해 주세요.</p>'
          );
        }
      }
      return;
    }
    renderCharts._tries = 0;

    var stocks = DATA.stocks;
    var codes = stocks.map(function (s) {
      return s.code;
    });

    // ── 그래프 1: 일별 ──
    var rangeSel = $('sel-range');
    var range = rangeSel ? rangeSel.value : 'ALL';
    var dailyRows = DAILY.rows;
    if (range !== 'ALL') {
      var months = range === '3M' ? 3 : range === '6M' ? 6 : 12;
      var lastDate = new Date(dailyRows[dailyRows.length - 1].date);
      var cut = new Date(lastDate);
      cut.setMonth(cut.getMonth() - months);
      var iso = cut.toISOString().slice(0, 10);
      dailyRows = dailyRows.filter(function (r) {
        return r.date >= iso;
      });
    }

    var logOn = $('chk-log') && $('chk-log').checked;

    var dailySets = codes.map(function (c, i) {
      return {
        label: stocks[i].name,
        data: dailyRows.map(function (r) {
          return r.c[c];
        }),
        borderColor: COLORS[i % COLORS.length],
        backgroundColor: 'transparent',
        borderWidth: 1.8,
        pointRadius: 0,
        pointHoverRadius: 4,
        tension: 0.1,
        spanGaps: true,
      };
    });

    var ctx1 = $('chart-daily');
    if (ctx1) {
      if (charts.daily) charts.daily.destroy();
      charts.daily = new Chart(ctx1, {
        type: 'line',
        data: {
          labels: dailyRows.map(function (r) {
            return r.date;
          }),
          datasets: dailySets,
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          interaction: { mode: 'index', intersect: false },
          plugins: {
            legend: { position: 'top', labels: { boxWidth: 12, font: { size: 11 } } },
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

    // ── 그래프 2: 월별 ──
    var ctx2 = $('chart-monthly');
    if (ctx2) {
      if (charts.monthly) charts.monthly.destroy();
      charts.monthly = new Chart(ctx2, {
        type: 'line',
        data: {
          labels: DATA.monthly.map(function (m) {
            return m.ym;
          }),
          datasets: codes.map(function (c, i) {
            return {
              label: stocks[i].name,
              data: DATA.monthly.map(function (m) {
                return m.c[c];
              }),
              borderColor: COLORS[i % COLORS.length],
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
            legend: { position: 'top', labels: { boxWidth: 12, font: { size: 11 } } },
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

    // ── 그래프 3: 연간 수익률 (막대) ──
    var ctx3 = $('chart-annual');
    if (ctx3) {
      if (charts.annual) charts.annual.destroy();
      // 2023 은 기준연도라 수익률 없음 → 제외
      var annualRows = DATA.annual.filter(function (a) {
        return a.year !== '2023';
      });
      charts.annual = new Chart(ctx3, {
        type: 'bar',
        data: {
          labels: annualRows.map(function (a) {
            return a.year + (a.year === '2026' ? ' (YTD)' : '');
          }),
          datasets: codes.map(function (c, i) {
            return {
              label: stocks[i].name,
              data: annualRows.map(function (a) {
                var r = a.r ? a.r[c] : null;
                return r == null ? null : Number((r * 100).toFixed(2));
              }),
              backgroundColor: COLORS[i % COLORS.length],
              borderRadius: 3,
              barPercentage: 0.8,
            };
          }),
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { position: 'top', labels: { boxWidth: 12, font: { size: 11 } } },
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
    if (pr) pr.addEventListener('click', function () {
      window.print();
    });

    var xl = $('btn-xlsx');
    if (xl) xl.addEventListener('click', downloadXlsx);

    window.addEventListener('resize', function () {
      clearTimeout(bindActions._rt);
      bindActions._rt = setTimeout(resizeCharts, 200);
    });
  }

  /* ---------------- 보고서 다운로드 (자기완결 HTML) ---------------- */
  function downloadReport() {
    if (!DATA) {
      toast('분석 데이터를 아직 불러오지 못했습니다.');
      return;
    }

    var stocks = DATA.stocks;
    var codes = stocks.map(function (s) {
      return s.code;
    });
    var meta = DATA.meta;

    var css =
      'body{font-family:-apple-system,BlinkMacSystemFont,"Malgun Gothic","Apple SD Gothic Neo",sans-serif;' +
      'margin:0;padding:32px 28px;color:#1a2233;background:#fff;line-height:1.55;max-width:1100px;margin:0 auto}' +
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
    html += '<title>KOSPI 주요 4종목 종가 분석 보고서</title>';
    html += '<style>' + css + '</style></head><body>';

    html += '<h1>KOSPI 주요 4종목 종가 분석 보고서</h1>';
    html +=
      '<p class="sub">기준일: ' +
      esc(meta.end || '') +
      ' (종가) · 기간: ' +
      esc(meta.start || '') +
      ' ~ ' +
      esc(meta.end || '') +
      ' · ' +
      stocks
        .map(function (s) {
          return esc(s.name);
        })
        .join(' · ') +
      '</p>';
    html += '<p class="sub">출처: ' + esc(meta.source) + ' · 집계 ' + esc(meta.collectedAt) + '</p>';
    html += '<p class="note">※ 참고용 자료이며 투자 권유가 아닙니다.</p>';

    // 카드
    html += '<h2>1. 한눈에 보기</h2>';
    html += '<div class="cards">';
    DATA.summary.forEach(function (s, i) {
      html +=
        '<div class="card" style="border-left-color:' +
        COLORS[i % COLORS.length] +
        '">' +
        '<div class="nm">' +
        esc(s.name) +
        ' <span class="cd">' +
        esc(s.code) +
        '</span></div>' +
        '<div class="pr">' +
        fmt(s.last) +
        '<span class="u">원</span></div>' +
        '<div class="kv">2023년말 대비 <b class="' +
        cls(s.vs2023Pct) +
        '">' +
        pc(s.vs2023Pct) +
        '</b></div>' +
        '<div class="kv">2025년말 대비 <b class="' +
        cls(s.vs2025Pct) +
        '">' +
        pc(s.vs2025Pct) +
        '</b></div>' +
        '<div class="kv">2026 YTD <b class="' +
        cls(s.y2026Pct) +
        '">' +
        pc(s.y2026Pct) +
        '</b></div>' +
        '<div class="kv">기간 최고가 ' +
        fmt(s.closeHigh) +
        '</div>' +
        '</div>';
    });
    html += '</div>';

    // 지표 표
    html += '<h3>주요 지표</h3>';
    html += '<table><thead><tr><th>지표</th>';
    stocks.forEach(function (s) {
      html += '<th>' + esc(s.name) + '</th>';
    });
    html += '</tr></thead><tbody>';
    function trow(label, getter, klass) {
      html += '<tr><th>' + esc(label) + '</th>';
      DATA.summary.forEach(function (s) {
        var raw = getter(s);
        html += '<td class="' + (klass ? klass(s) : '') + '">' + raw + '</td>';
      });
      html += '</tr>';
    }
    trow('최신 종가 (원)', function (s) {
      return fmt(s.last);
    });
    trow(
      '2023년말 대비',
      function (s) {
        return pc(s.vs2023Pct);
      },
      function (s) {
        return cls(s.vs2023Pct);
      }
    );
    trow(
      '2025년말 대비',
      function (s) {
        return pc(s.vs2025Pct);
      },
      function (s) {
        return cls(s.vs2025Pct);
      }
    );
    trow(
      '2026 YTD',
      function (s) {
        return pc(s.y2026Pct);
      },
      function (s) {
        return cls(s.y2026Pct);
      }
    );
    trow('기간 최고가 (종가)', function (s) {
      return fmt(s.closeHigh);
    });
    trow('기간 최저가 (종가)', function (s) {
      return fmt(s.closeLow);
    });
    html += '</tbody></table>';

    // 연간
    html += '<h2>2. 연간 종가 및 수익률</h2>';
    html += '<p class="note">연말 종가 기준. 2026년은 연초 대비(YTD).</p>';
    html += '<table><thead><tr><th>연도</th>';
    stocks.forEach(function (s) {
      html += '<th>' + esc(s.name) + ' 종가</th><th>' + esc(s.name) + ' 수익률</th>';
    });
    html += '</tr></thead><tbody>';
    DATA.annual.forEach(function (a) {
      html += '<tr><th>' + esc(a.year) + (a.year === '2026' ? ' (YTD)' : '') + '</th>';
      codes.forEach(function (c) {
        var r = a.r ? a.r[c] : null;
        var rp = r == null ? null : r * 100;
        html += '<td>' + fmt(a.c[c]) + '</td>';
        html += '<td class="' + cls(rp) + '">' + pc(rp) + '</td>';
      });
      html += '</tr>';
    });
    html += '</tbody></table>';

    // 월별
    html += '<h2>3. 월별 종가</h2>';
    html += '<p class="note">각 월 마지막 거래일 종가 · 단위 원.</p>';
    html += '<table><thead><tr><th>연-월</th>';
    stocks.forEach(function (s) {
      html += '<th>' + esc(s.name) + '</th>';
    });
    html += '</tr></thead><tbody>';
    DATA.monthly.forEach(function (m) {
      html += '<tr><th>' + esc(m.ym) + '</th>';
      codes.forEach(function (c) {
        html += '<td>' + fmt(m.c[c]) + '</td>';
      });
      html += '</tr>';
    });
    html += '</tbody></table>';

    html += '<div class="foot">© KOSPI 스크리너 · 주요 종목 분석 · ' + esc(meta.source) + '</div>';
    html += '</body></html>';

    var blob = new Blob([html], { type: 'text/html;charset=utf-8;' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'KOSPI_주요종목_보고서_' + (meta.end || '').replace(/-/g, '') + '.html';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () {
      URL.revokeObjectURL(url);
    }, 1500);
    toast('보고서(HTML)를 내려받았습니다. 브라우저에서 PDF로 인쇄할 수 있습니다.');
  }

  /* ---------------- 엑셀 다운로드 (5시트) ---------------- */
  function downloadXlsx() {
    if (typeof window.XLSX === 'undefined') {
      toast('엑셀 라이브러리를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.');
      return;
    }
    if (!DATA || !DAILY) {
      toast('분석 데이터를 아직 불러오지 못했습니다.');
      return;
    }

    var XLSX = window.XLSX;
    var wb = XLSX.utils.book_new();
    var meta = DATA.meta;
    var stocks = DATA.stocks;
    var codes = stocks.map(function (s) {
      return s.code;
    });
    var headers = stocks.map(function (s) {
      return s.name + ' (' + s.code + ')';
    });

    function aoaToSheet(aoa, widths) {
      var ws = XLSX.utils.aoa_to_sheet(aoa);
      if (widths) ws['!cols'] = widths.map(function (w) {
        return { wch: w };
      });
      return ws;
    }

    // ── 시트 1: 한장보고 ──
    var s1 = [];
    s1.push(['KOSPI 주요 4종목 종가 분석 (한눈에 보기)']);
    s1.push(['기준일: ' + (meta.end || '') + ' (종가)  |  기간: ' + (meta.start || '') + ' ~ ' + (meta.end || '') + '  |  ' + stocks.map(function (s) { return s.name; }).join(' · ')]);
    s1.push(['출처: ' + meta.source + '  |  참고용 (투자 권유 아님)']);
    s1.push([]);
    s1.push(['주요 지표']);
    s1.push(['지표'].concat(stocks.map(function (s) { return s.name; })));
    s1.push(['최신 종가 (원)'].concat(DATA.summary.map(function (s) { return s.last; })));
    s1.push(['2023년말 대비'].concat(DATA.summary.map(function (s) { return s.vs2023Pct == null ? null : s.vs2023Pct / 100; })));
    s1.push(['2025년말 대비'].concat(DATA.summary.map(function (s) { return s.vs2025Pct == null ? null : s.vs2025Pct / 100; })));
    s1.push(['2026 YTD'].concat(DATA.summary.map(function (s) { return s.y2026Pct == null ? null : s.y2026Pct / 100; })));
    s1.push(['기간 최고가'].concat(DATA.summary.map(function (s) { return s.closeHigh; })));
    s1.push(['기간 최저가'].concat(DATA.summary.map(function (s) { return s.closeLow; })));
    s1.push([]);
    s1.push(['※ 수익률은 소수 비율 (0.79 = +79%). 엑셀 셀 서식에서 백분율로 표시하세요.']);
    XLSX.utils.book_append_sheet(wb, aoaToSheet(s1, [22, 16, 16, 16, 16]), '한장보고');

    // ── 시트 2: 전체보고 ──
    var s2 = [];
    s2.push(['KOSPI 주요 4종목 종가 분석 전체 보고서']);
    s2.push(['상세 데이터 버전  |  기준일: ' + (meta.end || '')]);
    s2.push(['출처: ' + meta.source]);
    s2.push([]);
    s2.push(['그래프 1: 일별 종가 추이 (전체 기간)']);
    s2.push(['날짜'].concat(headers));
    DAILY.rows.forEach(function (r) {
      s2.push([r.date].concat(codes.map(function (c) { return r.c[c]; })));
    });
    s2.push([]);
    s2.push(['그래프 2: 월별 종가 추이']);
    s2.push(['연-월'].concat(headers));
    DATA.monthly.forEach(function (m) {
      s2.push([m.ym].concat(codes.map(function (c) { return m.c[c]; })));
    });
    s2.push([]);
    s2.push(['그래프 3: 연간 수익률']);
    s2.push(['연도'].concat(headers));
    DATA.annual.forEach(function (a) {
      s2.push([a.year].concat(codes.map(function (c) { return a.c[c]; })));
    });
    XLSX.utils.book_append_sheet(wb, aoaToSheet(s2), '전체보고');

    // ── 시트 3: 일일종가 ──
    var s3 = [];
    s3.push(['KOSPI 주요 종목 일일 종가 (' + (meta.start || '') + ' ~ ' + (meta.end || '') + ')']);
    s3.push(['출처: ' + meta.source + ' | 단위: 원(KRW) | 데이터 기준일: ' + (meta.end || '')]);
    s3.push(['날짜'].concat(headers));
    DAILY.rows.forEach(function (r) {
      s3.push([r.date].concat(codes.map(function (c) { return r.c[c]; })));
    });
    XLSX.utils.book_append_sheet(wb, aoaToSheet(s3, [12, 14, 14, 14, 14]), '일일종가');

    // ── 시트 4: 월별종가 ──
    var s4 = [];
    s4.push(['월별 종가 (각 월 마지막 거래일 종가)']);
    s4.push(['출처: 일일종가 시트 기준 월말 종가 집계 | 단위: 원(KRW)']);
    s4.push(['연-월'].concat(headers));
    DATA.monthly.forEach(function (m) {
      s4.push([m.ym].concat(codes.map(function (c) { return m.c[c]; })));
    });
    XLSX.utils.book_append_sheet(wb, aoaToSheet(s4, [12, 14, 14, 14, 14]), '월별종가');

    // ── 시트 5: 연간데이터 ──
    var s5 = [];
    s5.push(['연간 종가 및 수익률']);
    s5.push(['연말 종가 기준 수익률 계산 (공식 사용) | 2026년은 YTD (' + (meta.end || '') + ' 기준)']);
    var h5 = ['연도'];
    stocks.forEach(function (s) { h5.push(s.name + ' 종가'); });
    stocks.forEach(function (s) { h5.push(s.name + ' 수익률'); });
    s5.push(h5);
    DATA.annual.forEach(function (a) {
      var row = [Number(a.year)];
      codes.forEach(function (c) { row.push(a.c[c]); });
      codes.forEach(function (c) { row.push(a.r[c]); });
      s5.push(row);
    });
    XLSX.utils.book_append_sheet(wb, aoaToSheet(s5, [10, 14, 14, 14, 14, 14, 14, 14, 14]), '연간데이터');

    var fname = 'KOSPI_주요종목_종가분석_' + (meta.end || '').replace(/-/g, '') + '.xlsx';
    XLSX.writeFile(wb, fname);
    toast('엑셀 파일을 내려받았습니다. (5개 시트)');
  }

  /* ---------------- 시작 ---------------- */
  function init() {
    bindTabs();
    var saved = null;
    try {
      saved = localStorage.getItem(LS_TAB);
    } catch (e) {}
    // 기본 진입 화면은 "주요 종목 분석".
    // 사용자가 마지막으로 스크리너를 봤다면 그 선택을 존중한다.
    switchView(saved === 'screener' ? 'screener' : 'analysis', false);
    // 차트 라이브러리 로딩 대기는 renderCharts() 가 자체적으로 재시도한다.
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
