/* ==================================================================
   코스피 종목 분석 — 클라이언트 로직
   - 서버 API 기반 조건검색
   - 즐겨찾기 / 메모 / 태그 / 목표가 : localStorage 저장
   ================================================================== */
(function () {
  'use strict';

  /* ---------------- 상태 ---------------- */
  var LS_FAV = 'kospi-screener:favorites:v1';
  var LS_MEMO = 'kospi-screener:memos:v1';
  var LS_UI = 'kospi-screener:ui:v1';

  var state = {
    page: 1,
    pageSize: 50,
    sort: 'marketCap',
    dir: 'desc',
    rows: [],
    total: 0,
    favOnly: false,
    favFilter: false,
  };

  var favorites = loadJSON(LS_FAV, {}); // { code: true }
  var memos = loadJSON(LS_MEMO, {}); // { code: {memo,tags,target,updatedAt} }

  var els = {};
  var searchTimer = null;
  var activeRequest = 0;

  /* ---------------- 유틸 ---------------- */
  function loadJSON(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      if (!raw) return fallback;
      var v = JSON.parse(raw);
      return v && typeof v === 'object' ? v : fallback;
    } catch (e) {
      return fallback;
    }
  }

  function saveJSON(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (e) {
      toast('저장 공간이 부족합니다.');
      return false;
    }
  }

  function $(id) {
    return document.getElementById(id);
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /** 숫자 포맷 (천단위) */
  function fmt(n, digits) {
    if (n == null || isNaN(n)) return '–';
    return Number(n).toLocaleString('ko-KR', {
      minimumFractionDigits: digits || 0,
      maximumFractionDigits: digits == null ? 0 : digits,
    });
  }

  /** 억원 → 사람이 읽기 쉬운 표기 */
  function fmtCap(eok) {
    if (eok == null || isNaN(eok)) return '–';
    if (eok >= 10000) {
      var jo = eok / 10000;
      return jo >= 100 ? fmt(jo, 0) + '조' : fmt(jo, 1) + '조';
    }
    return fmt(eok, 0) + '억';
  }

  function fmtSigned(n, digits) {
    if (n == null || isNaN(n)) return '–';
    var v = fmt(Math.abs(n), digits);
    if (n > 0) return '+' + v;
    if (n < 0) return '-' + v;
    return v;
  }

  var toastTimer = null;
  function toast(msg) {
    if (!els.toast) return;
    els.toast.textContent = msg;
    els.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      els.toast.classList.remove('show');
    }, 2300);
  }

  /* ---------------- 즐겨찾기 / 메모 ---------------- */
  function isFav(code) {
    return !!favorites[code];
  }

  function favCount() {
    return Object.keys(favorites).length;
  }

  function toggleFav(code) {
    if (favorites[code]) {
      delete favorites[code];
    } else {
      favorites[code] = true;
    }
    saveJSON(LS_FAV, favorites);
    updateFavBadge();
    return isFav(code);
  }

  function updateFavBadge() {
    if (els.favCount) els.favCount.textContent = String(favCount());
  }

  function getMemo(code) {
    var m = memos[code];
    if (!m) return null;
    if (!m.memo && !m.tags && !m.target) return null;
    return m;
  }

  /* ---------------- 필터 수집 ---------------- */
  function numVal(id) {
    var el = $(id);
    if (!el) return null;
    var v = el.value.trim();
    if (v === '') return null;
    var n = Number(v);
    return isFinite(n) ? n : null;
  }

  function buildQuery() {
    var p = new URLSearchParams();
    var q = els.q ? els.q.value.trim() : '';
    if (q) p.set('q', q);

    function put(key, id) {
      var v = numVal(id);
      if (v != null) p.set(key, String(v));
    }
    put('marketCapMin', 'f-marketcap-min');
    put('marketCapMax', 'f-marketcap-max');
    put('debtRatioMax', 'f-debt-max');
    put('opMarginMin', 'f-opmargin-min');
    put('perMin', 'f-per-min');
    put('perMax', 'f-per-max');
    put('revenueMin', 'f-revenue-min');
    put('roeMin', 'f-roe-min');
    put('pbrMax', 'f-pbr-max');
    put('divYieldMin', 'f-div-min');
    put('revenueGrowthMin', 'f-growth-min');

    // ── 분기 실적 조건 ──
    put('qYoYMin', 'f-qyoy-min');
    put('qOpYoYMin', 'f-qopyoy-min');
    put('qOpMarginMin', 'f-qopmargin-min');
    put('qQoQMin', 'f-qqoq-min');
    put('opStreakMin', 'f-opstreak-min');

    var ind = $('f-industry');
    if (ind && ind.value) p.set('industry', ind.value);

    var exPref = $('f-exclude-preferred');
    if (exPref && exPref.checked) p.set('excludePreferred', '1');

    // 즐겨찾기만 보기 → 서버측 화이트리스트 필터
    if (state.favFilter) {
      var favCodes = Object.keys(favorites);
      if (favCodes.length) {
        p.set('codes', favCodes.join(','));
      } else {
        // 즐겨찾기가 하나도 없으면 결과 0건을 명확히 표현
        p.set('codes', '__none__');
      }
    }

    p.set('sort', state.sort);
    p.set('dir', state.dir);
    p.set('page', String(state.page));
    p.set('pageSize', String(state.pageSize));
    return p;
  }

  /* ---------------- 데이터 로드 ---------------- */
  function load() {
    var p = buildQuery();
    var reqId = ++activeRequest;

    els.summary.textContent = '조회 중…';

    fetch('/api/stocks?' + p.toString())
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (data) {
        if (reqId !== activeRequest) return; // 최신 요청만 반영
        state.rows = data.rows || [];
        state.total = data.total || 0;
        renderStats(data.stats);
        renderSummary(data);
        renderTable();
        renderPagination(data);
      })
      .catch(function (err) {
        if (reqId !== activeRequest) return;
        els.summary.textContent = '조회 실패';
        els.body.innerHTML =
          '<tr><td colspan="16"><div class="empty-state">' +
          '<div class="empty-ico">⚠</div><h3>데이터를 불러오지 못했습니다</h3>' +
          '<p>' + esc(err.message) + '</p></div></td></tr>';
      });
  }

  /* ---------------- 요약/통계 ---------------- */
  function renderStats(s) {
    if (!s) return;
    setText('stat-count', fmt(s.count));
    setText('stat-per', s.medianPer == null ? '–' : fmt(s.medianPer, 1));
    setText('stat-pbr', s.medianPbr == null ? '–' : fmt(s.medianPbr, 2));
    setText('stat-debt', s.avgDebtRatio == null ? '–' : fmt(s.avgDebtRatio, 0));
    setText('stat-op', s.medianOpMargin == null ? '–' : fmt(s.medianOpMargin, 1));
    setText('stat-cap', s.totalMarketCap == null ? '–' : fmt(s.totalMarketCap, 0));
  }

  function setText(id, text) {
    var el = $(id);
    if (el) el.textContent = text;
  }

  function renderSummary(data) {
    var start = (data.page - 1) * data.pageSize + 1;
    var end = Math.min(data.page * data.pageSize, data.total);
    var txt = data.total
      ? '<strong>' + fmt(data.total) + '</strong>개 종목 · ' + fmt(start) + '–' + fmt(end) + ' 표시'
      : '조건에 맞는 종목이 없습니다';

    // 분기 요약 (데이터가 있을 때만)
    var s = data.stats;
    if (s && s.medianQYoY != null) {
      txt += '<span class="summary-q">분기 매출 YoY 중앙값 <strong>' +
        fmtSigned(s.medianQYoY, 1) + '%</strong></span>';
    }
    els.summary.innerHTML = txt;
  }

  /* ---------------- 테이블 ---------------- */
  function renderTable() {
    var rows = state.rows;

    // 즐겨찾기만 보기 (클라이언트 필터)
    if (state.favFilter) {
      rows = rows.filter(function (r) {
        return isFav(r.code);
      });
    }

    if (!rows.length) {
      els.body.innerHTML =
        '<tr><td colspan="16"><div class="empty-state">' +
        '<div class="empty-ico">' + (state.favFilter ? '★' : '🔍') + '</div>' +
        '<h3>' + (state.favFilter ? '이 페이지에 즐겨찾기 종목이 없습니다' : '조건에 맞는 종목이 없습니다') + '</h3>' +
        '<p>' + (state.favFilter ? '다른 페이지를 확인하거나 즐겨찾기를 추가해 보세요.' : '조건을 완화하거나 초기화 버튼을 눌러보세요.') + '</p>' +
        '</div></td></tr>';
      return;
    }

    var html = rows
      .map(function (r) {
        return rowHTML(r);
      })
      .join('');
    els.body.innerHTML = html;
  }

  function metricClass(key, v) {
    if (v == null) return '';
    if (key === 'opMargin') return v >= 15 ? 'metric-good' : v >= 5 ? '' : 'metric-bad';
    if (key === 'debtRatio') return v <= 100 ? 'metric-good' : v <= 200 ? '' : 'metric-warn';
    if (key === 'roe') return v >= 15 ? 'metric-good' : v >= 5 ? '' : 'metric-bad';
    if (key === 'divYield') return v >= 3 ? 'metric-good' : '';
    if (key === 'per') return v > 0 && v <= 10 ? 'metric-good' : v > 40 ? 'metric-bad' : '';
    return '';
  }

  function badge(key, v, suffix, digits) {
    if (v == null) return '<span class="muted">–</span>';
    var cls = metricClass(key, v);
    var txt = fmt(v, digits) + suffix;
    return cls
      ? '<span class="metric-badge ' + cls + '">' + txt + '</span>'
      : txt;
  }

  function rowHTML(r) {
    var fav = isFav(r.code);
    var memo = getMemo(r.code);
    var chgCls = r.changeRate > 0 ? 'up' : r.changeRate < 0 ? 'down' : 'flat';

    var nameExtra = '';
    if (r.isPreferred) nameExtra += ' <span class="tag-mini">우</span>';
    if (memo) nameExtra += ' <span class="memo-dot" title="메모 있음">●</span>';

    return (
      '<tr data-code="' + esc(r.code) + '"' + (fav ? ' class="is-fav"' : '') + '>' +
      '<td class="col-fav">' +
      '<button type="button" class="fav-btn' + (fav ? ' on' : '') + '" data-fav="' + esc(r.code) + '" ' +
      'aria-label="' + esc(r.name) + ' 즐겨찾기 ' + (fav ? '해제' : '추가') + '" ' +
      'aria-pressed="' + (fav ? 'true' : 'false') + '">' + (fav ? '★' : '☆') + '</button>' +
      '</td>' +
      '<td class="col-name">' +
      '<button type="button" class="stock-name-btn" data-detail="' + esc(r.code) + '">' +
      '<span class="stock-name">' + esc(r.name) + nameExtra + '</span>' +
      '<span class="stock-code">' + esc(r.code) + '</span>' +
      '</button>' +
      '</td>' +
      '<td class="num price">' + (r.price == null ? '–' : fmt(r.price)) + '</td>' +
      '<td class="num chg ' + chgCls + '">' +
      (r.changeRate == null ? '–' : fmtSigned(r.changeRate, 2) + '%') +
      '</td>' +
      '<td class="num">' + fmtCap(r.marketCap) + '</td>' +
      '<td class="num">' + badge('per', r.per, '배', 2) + '</td>' +
      '<td class="num">' + badge('pbr', r.pbr, '배', 2) + '</td>' +
      '<td class="num">' + badge('opMargin', r.opMargin, '%', 1) + '</td>' +
      '<td class="num">' + badge('debtRatio', r.debtRatio, '%', 0) + '</td>' +
      '<td class="num">' + badge('roe', r.roe, '%', 1) + '</td>' +
      '<td class="num">' + badge('divYield', r.divYield, '%', 2) + '</td>' +
      '<td class="num">' + badge('revenueCagr', r.revenueCagr, '%', 1) + '</td>' +
      '<td class="num col-q">' + qBadge(r.qYoY, '%') + '</td>' +
      '<td class="num col-q">' + badge('opMargin', r.qOpMargin, '%', 1) + '</td>' +
      '<td class="col-ind" title="' + esc(r.industry || '') + '">' + esc(r.industry || '–') + '</td>' +
      '<td class="col-edit">' +
      '<button type="button" class="edit-btn" data-edit="' + esc(r.code) + '" ' +
      'aria-label="' + esc(r.name) + ' 메모 편집" title="메모 편집">✎</button>' +
      '</td>' +
      '</tr>'
    );
  }

  /** YoY/QoQ 처럼 부호가 의미 있는 증감률 전용 배지 */
  function qBadge(v, suffix) {
    if (v == null) return '<span class="muted">–</span>';
    var cls = v > 0 ? 'metric-good' : v < 0 ? 'metric-bad' : '';
    var txt = fmtSigned(v, 1) + suffix;
    return cls ? '<span class="metric-badge ' + cls + '">' + txt + '</span>' : txt;
  }

  /* ---------------- 페이지네이션 ---------------- */
  function renderPagination(data) {
    var nav = els.pagination;
    var page = data.page;
    var totalPages = data.pageCount;
    if (totalPages <= 1) {
      nav.innerHTML = '';
      return;
    }

    var parts = [];
    parts.push(
      '<button type="button" class="page-btn" data-page="' + (page - 1) + '"' +
        (page <= 1 ? ' disabled' : '') + '>이전</button>'
    );

    var windowSize = 7;
    var from = Math.max(1, page - Math.floor(windowSize / 2));
    var to = Math.min(totalPages, from + windowSize - 1);
    from = Math.max(1, to - windowSize + 1);

    if (from > 1) {
      parts.push('<button type="button" class="page-btn" data-page="1">1</button>');
      if (from > 2) parts.push('<span class="page-ellipsis">…</span>');
    }

    for (var i = from; i <= to; i++) {
      parts.push(
        '<button type="button" class="page-btn' + (i === page ? ' active' : '') + '" ' +
          'data-page="' + i + '"' + (i === page ? ' aria-current="page"' : '') + '>' + i + '</button>'
      );
    }

    if (to < totalPages) {
      if (to < totalPages - 1) parts.push('<span class="page-ellipsis">…</span>');
      parts.push(
        '<button type="button" class="page-btn" data-page="' + totalPages + '">' + totalPages + '</button>'
      );
    }

    parts.push(
      '<button type="button" class="page-btn" data-page="' + (page + 1) + '"' +
        (page >= totalPages ? ' disabled' : '') + '>다음</button>'
    );

    nav.innerHTML = parts.join('');
  }

  /* ---------------- 정렬 표시 ---------------- */
  function updateSortIndicators() {
    var ths = document.querySelectorAll('#results-table thead th[data-sort]');
    for (var i = 0; i < ths.length; i++) {
      var th = ths[i];
      var ind = th.querySelector('.sort-ind');
      if (!ind) continue;
      if (th.getAttribute('data-sort') === state.sort) {
        ind.textContent = state.dir === 'asc' ? '▲' : '▼';
      } else {
        ind.textContent = '';
      }
    }
  }

  /* ---------------- 종목 상세 드로어 ---------------- */
  var currentDetailCode = null;

  function openDrawer(code) {
    currentDetailCode = code;
    els.drawer.classList.add('open');
    els.drawer.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';

    var base = state.rows.filter(function (r) {
      return r.code === code;
    })[0];

    els.drawerTitle.textContent = base ? base.name : code;
    els.drawerSub.textContent = code + (base && base.industry ? ' · ' + base.industry : '');
    els.drawerBody.innerHTML = '<div class="skeleton-loading">실시간 데이터를 불러오는 중…</div>';

    renderDetailStatic(base);
    fetchLive(code, base);
  }

  function closeDrawer() {
    els.drawer.classList.remove('open');
    els.drawer.setAttribute('aria-hidden', 'true');
    document.body.style.overflow = '';
    currentDetailCode = null;
  }

  function renderDetailStatic(base) {
    if (!base) return;
    var memo = getMemo(base.code);
    var memoTags = memo && memo.tags ? memo.tags : '';

    var html = '';
    html += '<div class="detail-price-row">';
    html += '<span class="detail-price" id="dt-price">' + (base.price == null ? '–' : fmt(base.price)) + '원</span>';
    var cls = base.changeRate > 0 ? 'up' : base.changeRate < 0 ? 'down' : 'flat';
    html += '<span class="detail-chg ' + cls + '" id="dt-chg">' +
      (base.changeRate == null ? '' : fmtSigned(base.changeRate, 2) + '%') + '</span>';
    html += '</div>';
    html += '<p class="detail-updated" id="dt-updated">스냅샷 기준 · 실시간 확인 중</p>';

    html += '<div class="detail-grid">';
    html += cell('시가총액', fmtCap(base.marketCap));
    html += cell('PER', base.per == null ? '–' : fmt(base.per, 2) + '배');
    html += cell('PBR', base.pbr == null ? '–' : fmt(base.pbr, 2) + '배');
    html += cell('영업이익률', base.opMargin == null ? '–' : fmt(base.opMargin, 2) + '%');
    html += cell('부채비율', base.debtRatio == null ? '–' : fmt(base.debtRatio, 2) + '%');
    html += cell('ROE', base.roe == null ? '–' : fmt(base.roe, 2) + '%');
    html += cell('배당수익률', base.divYield == null ? '–' : fmt(base.divYield, 2) + '%');
    html += cell('매출 3년 CAGR', base.revenueCagr == null ? '–' : fmtSigned(base.revenueCagr, 1) + '%');
    html += '</div>';

    html += '<div class="detail-section-title">연간 재무 <span class="hint">스냅샷 기준 (' +
      esc(base.finYear ? base.finYear.slice(0, 4) + '년' : '–') + ')</span></div>';
    html += '<table class="mini-fin"><tbody>';
    html += finRow('매출액', base.revenue, '억');
    html += finRow('영업이익', base.opIncome, '억');
    html += finRow('당기순이익', base.netIncome, '억');
    html += '</tbody></table>';

    html += quarterSection(base);

    html += '<div class="detail-section-title">실시간 지표 <span class="hint">네이버금융</span></div>';
    html += '<div id="dt-live"><div class="skeleton-loading" style="padding:20px 0">불러오는 중…</div></div>';

    html += '<div class="detail-section-title">내 메모</div>';
    html += '<div id="dt-memo">' + memoHTML(base.code) + '</div>';

    html += '<div class="drawer-actions">';
    html += '<button type="button" class="btn ' + (isFav(base.code) ? '' : 'btn-primary') + '" data-drawer-fav>' +
      (isFav(base.code) ? '★ 즐겨찾기 해제' : '☆ 즐겨찾기 추가') + '</button>';
    html += '<button type="button" class="btn" data-drawer-edit>✎ 메모 편집</button>';
    html += '</div>';

    els.drawerBody.innerHTML = html;
    wireDrawerActions(base.code);
  }

  function cell(k, v) {
    return '<div class="detail-cell"><span class="k">' + esc(k) + '</span><span class="v">' + esc(v) + '</span></div>';
  }

  function finRow(label, v, unit) {
    var val = v == null ? '–' : fmt(v) + unit;
    return '<tr><td>' + esc(label) + '</td><td>' + val + '</td></tr>';
  }

  /**
   * 분기 실적 섹션.
   * 스냅샷의 분기 값은 단일분기(비누적) 확정 실적이다.
   */
  function quarterSection(base) {
    var qs = base.quarters;
    if (!qs || !qs.length) {
      return '<div class="detail-section-title">분기 실적</div>' +
        '<p class="muted" style="font-size:12px">분기 데이터가 없습니다.</p>';
    }

    var html = '';
    html += '<div class="detail-section-title">분기 실적 <span class="hint">단일분기 · ' +
      esc(qs[qs.length - 1] || '') + ' 기준</span></div>';

    // 요약 배지들
    html += '<div class="q-summary">';
    html += qPill('매출 YoY', base.qYoY, '%');
    html += qPill('영업이익 YoY', base.qOpYoY, '%');
    html += qPill('매출 QoQ', base.qQoQ, '%');
    html += qPill('영업이익 QoQ', base.qOpQoQ, '%');
    html += '<div class="q-pill"><span class="k">흑자 연속</span><span class="v">' +
      (base.opPositiveStreak == null ? '–' : base.opPositiveStreak + '분기') + '</span></div>';
    html += '</div>';

    html += '<div style="overflow-x:auto"><table class="mini-fin q-table"><thead><tr><th>항목</th>';
    qs.forEach(function (q) {
      html += '<th>' + esc(String(q)) + '</th>';
    });
    html += '</tr></thead><tbody>';
    html += qSeriesRow('매출액(억)', base.qRevenueSeries);
    html += qSeriesRow('영업이익(억)', base.qOpIncomeSeries);
    html += qSeriesRow('당기순이익(억)', base.qNetIncomeSeries);
    html += qSeriesRow('영업이익률(%)', base.qOpMarginSeries);
    html += '</tbody></table></div>';
    return html;
  }

  function qPill(label, v, suffix) {
    var cls = v == null ? '' : v > 0 ? ' up' : v < 0 ? ' down' : '';
    var txt = v == null ? '–' : fmtSigned(v, 1) + suffix;
    return '<div class="q-pill"><span class="k">' + esc(label) + '</span>' +
      '<span class="v' + cls + '">' + txt + '</span></div>';
  }

  function qSeriesRow(label, arr) {
    var out = '<tr><td>' + esc(label) + '</td>';
    if (!arr || !arr.length) {
      out += '<td>–</td>';
      return out + '</tr>';
    }
    arr.forEach(function (v) {
      out += '<td>' + (v == null ? '–' : fmt(v, 1)) + '</td>';
    });
    return out + '</tr>';
  }

  function memoHTML(code) {
    var m = getMemo(code);
    if (!m) {
      return '<p class="muted" style="font-size:12px;padding:4px 0">메모가 없습니다. ✎ 버튼으로 추가해 보세요.</p>';
    }
    var html = '<div class="memo-card">';
    if (m.memo) html += '<div>' + esc(m.memo) + '</div>';
    if (m.target) {
      html += '<div style="margin-top:6px;font-size:11.5px;color:#8a6a10"><strong>목표가</strong> ' + fmt(m.target) + '원</div>';
    }
    if (m.tags) {
      var tags = String(m.tags)
        .split(',')
        .map(function (t) {
          return t.trim();
        })
        .filter(Boolean);
      if (tags.length) {
        html += '<div class="memo-tags">';
        tags.forEach(function (t) {
          html += '<span class="memo-tag">' + esc(t) + '</span>';
        });
        html += '</div>';
      }
    }
    html += '</div>';
    return html;
  }

  function wireDrawerActions(code) {
    var favBtn = els.drawerBody.querySelector('[data-drawer-fav]');
    if (favBtn) {
      favBtn.addEventListener('click', function () {
        var on = toggleFav(code);
        favBtn.className = 'btn' + (on ? '' : ' btn-primary');
        favBtn.textContent = on ? '★ 즐겨찾기 해제' : '☆ 즐겨찾기 추가';
        toast(on ? '즐겨찾기에 추가했습니다.' : '즐겨찾기에서 제거했습니다.');
        load();
        updateRowFav(code, on);
      });
    }
    var editBtn = els.drawerBody.querySelector('[data-drawer-edit]');
    if (editBtn) {
      editBtn.addEventListener('click', function () {
        var base = state.rows.filter(function (r) {
          return r.code === code;
        })[0];
        openEditModal(code, base ? base.name : '');
      });
    }
  }

  function updateRowFav(code, on) {
    var tr = els.body.querySelector('tr[data-code="' + code + '"]');
    if (!tr) return;
    var btn = tr.querySelector('[data-fav]');
    if (btn) {
      btn.classList.toggle('on', on);
      btn.textContent = on ? '★' : '☆';
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
    tr.classList.toggle('is-fav', on);
  }

  /** 실시간 지표 조회 */
  function fetchLive(code, base) {
    fetch('/api/stock/' + encodeURIComponent(code) + '/live')
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (d) {
        if (currentDetailCode !== code) return;
        var priceEl = $('dt-price');
        var chgEl = $('dt-chg');
        var upEl = $('dt-updated');
        if (priceEl && d.price != null) priceEl.textContent = fmt(d.price) + '원';
        if (upEl) {
          var t = d.fetchedAt ? new Date(d.fetchedAt) : new Date();
          upEl.textContent =
            '실시간 ' +
            t.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' }) +
            ' 기준' +
            (d.cached ? ' (캐시)' : '');
        }

        // 실시간 PER 등으로 갱신
        var live = $('dt-live');
        if (!live) return;
        var items = [
          ['PER', d.per != null ? fmt(d.per, 2) + '배' : '–'],
          ['PBR', d.pbr != null ? fmt(d.pbr, 2) + '배' : '–'],
          ['EPS', d.eps != null ? fmt(d.eps) + '원' : '–'],
          ['BPS', d.bps != null ? fmt(d.bps) + '원' : '–'],
          ['배당수익률', d.divYield != null ? fmt(d.divYield, 2) + '%' : '–'],
          ['주당배당금', d.dps != null ? fmt(d.dps) + '원' : '–'],
          ['외국인소진율', d.foreignRate != null ? fmt(d.foreignRate, 2) + '%' : '–'],
          ['52주 최고', d.high52w != null ? fmt(d.high52w) + '원' : '–'],
          ['52주 최저', d.low52w != null ? fmt(d.low52w) + '원' : '–'],
          ['시가총액', d.marketCapText || '–'],
        ];
        var g = '<div class="detail-grid">';
        items.forEach(function (it) {
          g += cell(it[0], it[1]);
        });
        g += '</div>';

        // 재무 시계열
        if (d.finance && d.finance.years && d.finance.years.length) {
          var f = d.finance;
          g += '<div class="detail-section-title" style="margin-top:14px">연간 실적 추이</div>';
          g += '<div style="overflow-x:auto"><table class="mini-fin"><thead><tr><th>항목</th>';
          f.years.forEach(function (y) {
            g += '<th>' + esc(String(y).replace(/\.$/, '')) + '</th>';
          });
          g += '</tr></thead><tbody>';
          g += seriesRow('매출액(억)', f.revenue);
          g += seriesRow('영업이익(억)', f.opIncome);
          g += seriesRow('영업이익률(%)', f.opMargin);
          g += seriesRow('부채비율(%)', f.debtRatio);
          g += seriesRow('ROE(%)', f.roe);
          g += '</tbody></table></div>';
        }

        live.innerHTML = g;
      })
      .catch(function () {
        if (currentDetailCode !== code) return;
        var live = $('dt-live');
        if (live) {
          live.innerHTML =
            '<p class="muted" style="font-size:12px">실시간 조회에 실패했습니다. 스냅샷 값으로 표시합니다.</p>';
        }
      });
  }

  function seriesRow(label, arr) {
    if (!arr || !arr.length) return '';
    var s = '<tr><td>' + esc(label) + '</td>';
    arr.forEach(function (v) {
      s += '<td>' + (v == null ? '–' : fmt(v)) + '</td>';
    });
    s += '</tr>';
    return s;
  }

  /* ---------------- 편집 모달 ---------------- */
  var editingCode = null;

  function openEditModal(code, name) {
    editingCode = code;
    var m = memos[code] || {};
    els.editSub.textContent = code + (name ? ' · ' + name : '');
    els.editMemo.value = m.memo || '';
    els.editTags.value = m.tags || '';
    els.editTarget.value = m.target || '';
    els.editModal.classList.add('open');
    els.editModal.setAttribute('aria-hidden', 'false');
    setTimeout(function () {
      els.editMemo.focus();
    }, 60);
  }

  function closeEditModal() {
    els.editModal.classList.remove('open');
    els.editModal.setAttribute('aria-hidden', 'true');
    editingCode = null;
  }

  function saveMemo() {
    if (!editingCode) return;
    var code = editingCode;
    var memo = els.editMemo.value.trim();
    var tags = els.editTags.value.trim();
    var target = els.editTarget.value.trim();

    if (!memo && !tags && !target) {
      delete memos[code];
    } else {
      memos[code] = {
        memo: memo,
        tags: tags,
        target: target ? Number(target) : null,
        updatedAt: new Date().toISOString(),
      };
      if (!favorites[code]) {
        favorites[code] = true;
        saveJSON(LS_FAV, favorites);
        updateFavBadge();
      }
    }
    saveJSON(LS_MEMO, memos);
    closeEditModal();
    toast('메모를 저장했습니다.');
    load();

    // 드로어 열려 있으면 갱신
    if (currentDetailCode === code) {
      var memoBox = $('dt-memo');
      if (memoBox) memoBox.innerHTML = memoHTML(code);
    }
    updateFavBadge();
  }

  /* ---------------- 프리셋 ---------------- */
  var PRESETS = {    value: {
      'f-marketcap-min': '1000',
      'f-per-min': '0',
      'f-per-max': '10',
      'f-pbr-max': '1.2',
      'f-debt-max': '200',
      'f-opmargin-min': '',
      'f-roe-min': '',
      'f-div-min': '',
      'f-revenue-min': '',
      'f-growth-min': '',
      'f-marketcap-max': '',
    },
    growth: {
      'f-marketcap-min': '1000',
      'f-growth-min': '15',
      'f-opmargin-min': '5',
      'f-roe-min': '8',
      'f-per-min': '',
      'f-per-max': '',
      'f-pbr-max': '',
      'f-debt-max': '300',
      'f-div-min': '',
      'f-revenue-min': '',
      'f-marketcap-max': '',
    },
    dividend: {
      'f-div-min': '3',
      'f-marketcap-min': '1000',
      'f-debt-max': '200',
      'f-opmargin-min': '0',
      'f-per-min': '',
      'f-per-max': '',
      'f-pbr-max': '',
      'f-roe-min': '',
      'f-revenue-min': '',
      'f-growth-min': '',
      'f-marketcap-max': '',
    },
    lowdebt: {
      'f-debt-max': '50',
      'f-marketcap-min': '1000',
      'f-opmargin-min': '5',
      'f-per-min': '',
      'f-per-max': '',
      'f-pbr-max': '',
      'f-roe-min': '',
      'f-div-min': '',
      'f-revenue-min': '',
      'f-growth-min': '',
      'f-marketcap-max': '',
    },
    largecap: {
      'f-marketcap-min': '50000',
      'f-debt-max': '',
      'f-opmargin-min': '',
      'f-per-min': '',
      'f-per-max': '',
      'f-pbr-max': '',
      'f-roe-min': '',
      'f-div-min': '',
      'f-revenue-min': '',
      'f-growth-min': '',
      'f-marketcap-max': '',
    },
  };

  /** 칩 값을 입력칸에 토글 적용 (같은 값을 다시 누르면 해제) */
  function toggleChipValue(id, value) {
    var el = $(id);
    if (el) el.value = el.value === value ? '' : value;
    state.page = 1;
    load();
  }

  function applyPreset(name) {
    var p = PRESETS[name];
    if (!p) return;
    clearFilters(false);
    Object.keys(p).forEach(function (id) {
      var el = $(id);
      if (el) el.value = p[id];
    });
    state.page = 1;
    // 활성 칩 표시
    var chips = document.querySelectorAll('#preset-chips .chip');
    for (var i = 0; i < chips.length; i++) {
      chips[i].classList.toggle('active', chips[i].getAttribute('data-preset') === name);
    }
    load();
  }

  function clearFilters(doLoad) {
    var form = $('filter-form');
    if (form) {
      var inputs = form.querySelectorAll('input[type="number"], input[type="text"]');
      for (var i = 0; i < inputs.length; i++) inputs[i].value = '';
      var sel = $('f-industry');
      if (sel) sel.value = '';
      var ex = $('f-exclude-preferred');
      if (ex) ex.checked = true;
      var fo = $('f-favonly');
      if (fo) fo.checked = false;
    }
    state.favFilter = false;
    state.page = 1;
    var chips = document.querySelectorAll('.chip');
    for (var j = 0; j < chips.length; j++) chips[j].classList.remove('active');
    if (doLoad !== false) load();
  }

  /* ---------------- CSV 내보내기 ---------------- */
  function exportCSV() {
    // 현재 조건 전체(최대 5000)를 가져와 CSV 생성
    var p = buildQuery();
    p.set('page', '1');
    p.set('pageSize', '200');

    var all = [];
    function next(page) {
      p.set('page', String(page));
      return fetch('/api/stocks?' + p.toString())
        .then(function (r) {
          return r.json();
        })
        .then(function (d) {
          all = all.concat(d.rows || []);
          if (page < d.pageCount && all.length < 5000) return next(page + 1);
        });
    }

    next(1)
      .then(function () {
        var header = [
          '종목코드',
          '종목명',
          '업종',
          '현재가',
          '등락률(%)',
          '시가총액(억원)',
          'PER',
          'PBR',
          '영업이익률(%)',
          '부채비율(%)',
          'ROE(%)',
          '배당수익률(%)',
          '매출3년CAGR(%)',
          '매출액(억원)',
          '분기기준',
          '분기매출(억원)',
          '분기영업이익(억원)',
          '분기순이익(억원)',
          '분기영업이익률(%)',
          '분기매출YoY(%)',
          '분기영업이익YoY(%)',
          '분기매출QoQ(%)',
          '분기영업이익QoQ(%)',
          '영업이익흑자연속(분기)',
          '즐겨찾기',
          '메모',
          '태그',
        ];
        var lines = [header.join(',')];
        all.forEach(function (r) {
          var m = memos[r.code] || {};
          var row = [
            r.code,
            r.name,
            r.industry || '',
            r.price,
            r.changeRate,
            r.marketCap,
            r.per,
            r.pbr,
            r.opMargin,
            r.debtRatio,
            r.roe,
            r.divYield,
            r.revenueCagr,
            r.revenue,
            r.quarterLabel,
            r.qRevenue,
            r.qOpIncome,
            r.qNetIncome,
            r.qOpMargin,
            r.qYoY,
            r.qOpYoY,
            r.qQoQ,
            r.qOpQoQ,
            r.opPositiveStreak,
            isFav(r.code) ? 'Y' : '',
            m.memo || '',
            m.tags || '',
          ].map(function (v) {
            if (v == null) return '';
            var s = String(v);
            return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
          });
          lines.push(row.join(','));
        });

        var blob = new Blob(['\uFEFF' + lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        var d = new Date();
        var stamp =
          d.getFullYear() +
          String(d.getMonth() + 1).padStart(2, '0') +
          String(d.getDate()).padStart(2, '0');
        a.download = 'kospi-screener-' + stamp + '.csv';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(function () {
          URL.revokeObjectURL(url);
        }, 1000);
        toast(all.length + '개 종목을 CSV로 내려받았습니다.');
      })
      .catch(function () {
        toast('CSV 생성에 실패했습니다.');
      });
  }

  /* ---------------- 이벤트 바인딩 ---------------- */
  function bind() {
    els = {
      q: $('f-q'),
      body: $('results-body'),
      summary: $('result-summary'),
      pagination: $('pagination'),
      favCount: $('fav-count-badge'),
      favToggle: $('btn-fav-toggle'),
      exportBtn: $('btn-export'),
      resetBtn: $('btn-reset'),
      drawer: $('detail-drawer'),
      drawerTitle: $('drawer-title'),
      drawerSub: $('drawer-sub'),
      drawerBody: $('drawer-body'),
      editModal: $('edit-modal'),
      editSub: $('edit-sub'),
      editMemo: $('edit-memo'),
      editTags: $('edit-tags'),
      editTarget: $('edit-target'),
      editForm: $('edit-form'),
      toast: $('toast'),
    };

    updateFavBadge();

    // 검색 (디바운스)
    if (els.q) {
      els.q.addEventListener('input', function () {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(function () {
          state.page = 1;
          load();
        }, 280);
      });
    }

    // 필터 입력 변경 → 즉시 조회
    var form = $('filter-form');
    if (form) {
      form.addEventListener('change', function (e) {
        var t = e.target;
        if (!t) return;
        if (t.id === 'f-favonly') {
          state.favFilter = t.checked;
          els.favToggle.setAttribute('aria-pressed', t.checked ? 'true' : 'false');
          renderTable();
          return;
        }
        state.page = 1;
        load();
      });
      // 숫자 입력은 타이핑 멈추면 조회
      var numInputs = form.querySelectorAll('input[type="number"]');
      for (var i = 0; i < numInputs.length; i++) {
        numInputs[i].addEventListener('input', function () {
          clearTimeout(searchTimer);
          searchTimer = setTimeout(function () {
            state.page = 1;
            load();
          }, 420);
        });
      }
    }

    // 칩 클릭
    document.addEventListener('click', function (e) {
      var t = e.target;
      if (!t || !t.closest) return;

      // 프리셋
      var pchip = t.closest('[data-preset]');
      if (pchip) {
        applyPreset(pchip.getAttribute('data-preset'));
        return;
      }

      // 시총 칩
      var capChip = t.closest('[data-cap]');
      if (capChip) {
        var cv = capChip.getAttribute('data-cap');
        var capEl = $('f-marketcap-min');
        if (capEl) {
          capEl.value = capEl.value === cv ? '' : cv;
        }
        state.page = 1;
        load();
        return;
      }

      // 부채비율 칩
      var debtChip = t.closest('[data-debt]');
      if (debtChip) {
        var dv = debtChip.getAttribute('data-debt');
        var dEl = $('f-debt-max');
        if (dEl) dEl.value = dEl.value === dv ? '' : dv;
        state.page = 1;
        load();
        return;
      }

      // 영업이익률 칩
      var opChip = t.closest('[data-op]');
      if (opChip) {
        var ov = opChip.getAttribute('data-op');
        var oEl = $('f-opmargin-min');
        if (oEl) oEl.value = oEl.value === ov ? '' : ov;
        state.page = 1;
        load();
        return;
      }

      // PER 칩
      var perChip = t.closest('[data-per]');
      if (perChip) {
        var pv = perChip.getAttribute('data-per');
        var pEl = $('f-per-max');
        if (pEl) pEl.value = pEl.value === pv ? '' : pv;
        var pMin = $('f-per-min');
        if (pMin && !pMin.value && pEl && pEl.value) pMin.value = '0';
        state.page = 1;
        load();
        return;
      }

      // 분기 매출 YoY 칩
      var qyoyChip = t.closest('[data-qyoy]');
      if (qyoyChip) {
        toggleChipValue('f-qyoy-min', qyoyChip.getAttribute('data-qyoy'));
        return;
      }

      // 분기 영업이익 YoY 칩
      var qopChip = t.closest('[data-qopyoy]');
      if (qopChip) {
        toggleChipValue('f-qopyoy-min', qopChip.getAttribute('data-qopyoy'));
        return;
      }

      // 영업이익 흑자 연속 분기 칩
      var streakChip = t.closest('[data-streak]');
      if (streakChip) {
        toggleChipValue('f-opstreak-min', streakChip.getAttribute('data-streak'));
        return;
      }
    });

    // 즐겨찾기 토글 버튼
    if (els.favToggle) {
      els.favToggle.addEventListener('click', function () {
        state.favFilter = !state.favFilter;
        els.favToggle.setAttribute('aria-pressed', state.favFilter ? 'true' : 'false');
        var cb = $('f-favonly');
        if (cb) cb.checked = state.favFilter;
        renderTable();
        if (state.favFilter) toast('즐겨찾기 종목만 표시합니다.');
      });
    }

    // 초기화
    if (els.resetBtn) {
      els.resetBtn.addEventListener('click', function () {
        if (els.q) els.q.value = '';
        clearFilters(true);
        toast('조회 조건을 초기화했습니다.');
      });
    }

    // CSV
    if (els.exportBtn) {
      els.exportBtn.addEventListener('click', exportCSV);
    }

    // 페이지 사이즈
    var ps = $('f-pagesize');
    if (ps) {
      ps.addEventListener('change', function () {
        state.pageSize = Number(ps.value) || 50;
        state.page = 1;
        load();
      });
    }

    // 정렬
    var ths = document.querySelectorAll('#results-table thead th[data-sort]');
    for (var k = 0; k < ths.length; k++) {
      (function (th) {
        function doSort() {
          var key = th.getAttribute('data-sort');
          if (state.sort === key) {
            state.dir = state.dir === 'desc' ? 'asc' : 'desc';
          } else {
            state.sort = key;
            state.dir = key === 'name' ? 'asc' : 'desc';
          }
          state.page = 1;
          updateSortIndicators();
          load();
        }
        th.addEventListener('click', doSort);
        th.addEventListener('keydown', function (e) {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            doSort();
          }
        });
      })(ths[k]);
    }

    // 테이블 내 이벤트 위임
    if (els.body) {
      els.body.addEventListener('click', function (e) {
        var t = e.target;
        if (!t || !t.closest) return;

        var favBtn = t.closest('[data-fav]');
        if (favBtn) {
          var code = favBtn.getAttribute('data-fav');
          var on = toggleFav(code);
          updateRowFav(code, on);
          toast(on ? '즐겨찾기에 추가했습니다.' : '즐겨찾기에서 제거했습니다.');
          if (state.favFilter) renderTable();
          return;
        }

        var editBtn = t.closest('[data-edit]');
        if (editBtn) {
          var ecode = editBtn.getAttribute('data-edit');
          var row = state.rows.filter(function (r) {
            return r.code === ecode;
          })[0];
          openEditModal(ecode, row ? row.name : '');
          return;
        }

        var detailBtn = t.closest('[data-detail]');
        if (detailBtn) {
          openDrawer(detailBtn.getAttribute('data-detail'));
        }
      });
    }

    // 페이지네이션
    if (els.pagination) {
      els.pagination.addEventListener('click', function (e) {
        var btn = e.target.closest('[data-page]');
        if (!btn || btn.disabled) return;
        var p = Number(btn.getAttribute('data-page'));
        if (!p || p === state.page) return;
        state.page = p;
        load();
        var top = $('results-panel').getBoundingClientRect().top + window.scrollY - 130;
        window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
      });
    }

    // 드로어 닫기
    document.addEventListener('click', function (e) {
      var t = e.target;
      if (!t || !t.closest) return;
      if (t.closest('[data-close-drawer]')) {
        closeDrawer();
      }
      if (t.closest('[data-close-modal]')) {
        closeEditModal();
      }
    });

    // 모달 저장
    if (els.editForm) {
      els.editForm.addEventListener('submit', function (e) {
        e.preventDefault();
        saveMemo();
      });
    }

    // ESC
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        if (els.editModal.classList.contains('open')) closeEditModal();
        else if (els.drawer.classList.contains('open')) closeDrawer();
      }
      // '/' 검색 포커스
      if (e.key === '/' && document.activeElement !== els.q && !isFormField(document.activeElement)) {
        e.preventDefault();
        if (els.q) els.q.focus();
      }
    });

    // UI 상태 복원
    var ui = loadJSON(LS_UI, {});
    if (ui.pageSize) {
      state.pageSize = ui.pageSize;
      if (ps) ps.value = String(ui.pageSize);
    }
    if (ps) {
      ps.addEventListener('change', function () {
        saveJSON(LS_UI, { pageSize: state.pageSize });
      });
    }

    updateSortIndicators();
  }

  function isFormField(el) {
    if (!el) return false;
    var tag = el.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
  }

  /* ---------------- 시작 ---------------- */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () {
      bind();
      load();
    });
  } else {
    bind();
    load();
  }
})();
