/* 时光账本 · 应用逻辑（无构建、无依赖）
 *
 * 设计要点：
 * 1) 计时只依赖时间戳，不累计 setInterval 次数 —— 后台冻结、锁屏、切走都不影响时长；
 * 2) 只有一条「未闭合事件」（state = 'open'），开始新的一段会先把上一条收尾为「切走了」；
 * 3) 每日汇总实时聚合，不存快照，改一条记录立刻重算；
 * 4) 跨零点的事件按重叠时长拆到两天。
 */
(function () {
  'use strict';

  /* ================= 常量 ================= */

  var TYPES = {
    focus: { key: 'focus', label: '自己的时间', color: '#f5b642', hint: '不看别人，只做自己的事' },
    game: { key: 'game', label: '游戏', color: '#b18bff', hint: '有时间盒，到点会提醒' },
    sleep: { key: 'sleep', label: '睡眠', color: '#5eb0ff', hint: '睡前开始，起床结束' }
  };

  var REASONS = {
    natural: '自然结束',
    interrupted: '被打断',
    switched: '切走了',
    manual: '手动收尾'
  };

  var ICONS = {
    focus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3.2"/><path d="M12 3.4v2.2M12 18.4v2.2M3.4 12h2.2M18.4 12h2.2M6 6l1.6 1.6M16.4 16.4 18 18M18 6l-1.6 1.6M7.6 16.4 6 18"/></svg>',
    game: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M7.6 7.5h8.8a4.6 4.6 0 0 1 4.5 5.6l-.7 3.2a2.6 2.6 0 0 1-4.5 1.1l-1.5-1.8H9.8l-1.5 1.8a2.6 2.6 0 0 1-4.5-1.1l-.7-3.2a4.6 4.6 0 0 1 4.5-5.6Z"/><path d="M8.4 11v3M6.9 12.5h3M15.6 11.6h.01M17.4 13.4h.01"/></svg>',
    sleep: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M20.5 14.4A8.6 8.6 0 0 1 9.6 3.5 8.6 8.6 0 1 0 20.5 14.4Z"/></svg>'
  };

  var LS_SETTINGS = 'timelog.settings.v1';
  var LS_TAB = 'timelog.tab';

  var DEFAULT_SETTINGS = {
    gameTimebox: 60,     // 游戏时间盒（分钟）
    warnBefore: 10,      // 提前多少分钟预警
    sleepTarget: 480,    // 睡眠目标（分钟）
    focusTarget: 120,    // 自己的时间软目标（分钟）
    rules: [
      { id: 'r-game', type: 'game', cmp: 'lte', minutes: 60, label: '游戏 ≤ 1 小时', enabled: true },
      { id: 'r-sleep', type: 'sleep', cmp: 'gte', minutes: 420, label: '睡眠 ≥ 7 小时', enabled: true },
      { id: 'r-focus', type: 'focus', cmp: 'gte', minutes: 30, label: '自己的时间 ≥ 30 分', enabled: true }
    ]
  };

  /* ================= 工具 ================= */

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  function dayStart(ts) {
    var d = new Date(ts);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }
  function addDays(ts, n) {
    var d = new Date(ts);
    d.setDate(d.getDate() + n);
    return d.getTime();
  }
  function todayKey() {
    var d = new Date();
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }
  function keyToTs(key) {
    var p = key.split('-');
    return new Date(+p[0], +p[1] - 1, +p[2], 0, 0, 0, 0).getTime();
  }

  var WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

  function fmtClock(ms) {
    ms = Math.max(0, ms);
    var s = Math.floor(ms / 1000);
    return pad2(Math.floor(s / 3600)) + ':' + pad2(Math.floor((s % 3600) / 60)) + ':' + pad2(s % 60);
  }

  function fmtMin(ms) {
    if (!ms || ms < 0) ms = 0;
    var min = Math.round(ms / 60000);
    if (ms > 0 && min < 1) min = 1;   // 有几秒也算 1 分，别显示成 0
    if (min <= 0) return '0 分';
    var h = Math.floor(min / 60), m = min % 60;
    if (!h) return m + ' 分';
    return h + ' 小时' + (m ? ' ' + m + ' 分' : '');
  }

  function fmtMinUp(ms) {
    if (ms <= 0) return '0 分';
    var min = Math.ceil(ms / 60000);
    var h = Math.floor(min / 60), m = min % 60;
    if (!h) return m + ' 分';
    return h + ' 小时' + (m ? ' ' + m + ' 分' : '');
  }

  // 剩余时间：不到 1 分钟按秒显示，别把 3 秒说成「1 分」
  function fmtLeft(ms) {
    if (ms < 60000) return Math.max(1, Math.round(ms / 1000)) + ' 秒';
    return fmtMinUp(ms);
  }

  function fmtTime(ts) {
    var d = new Date(ts);
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  function fmtDay(ts) {
    var d = new Date(ts);
    return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + WEEK[d.getDay()];
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function uid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }

  function vibrate(pattern) {
    try { if (navigator.vibrate) navigator.vibrate(pattern); } catch (e) { /* ignore */ }
  }

  function overlapMs(ev, from, to) {
    var s = ev.startAt;
    var e = ev.endAt == null ? Date.now() : ev.endAt;
    return Math.max(0, Math.min(e, to) - Math.max(s, from));
  }

  function pausesOf(ev) {
    return Array.isArray(ev.pauses) ? ev.pauses : [];
  }

  /* 暂停的区间长度（还没结束的那段按「到现在」算） */
  function pauseSpan(p, end) {
    var pe = p.to == null ? end : p.to;
    return Math.max(0, pe - p.from);
  }

  /* 有效时长 = 墙钟时长 - 暂停。暂停不算「自己的时间」 */
  function activeMs(ev, upto) {
    var end = ev.endAt == null ? (upto || Date.now()) : ev.endAt;
    var total = Math.max(0, end - ev.startAt);
    var list = pausesOf(ev);
    for (var i = 0; i < list.length; i++) {
      total -= Math.min(pauseSpan(list[i], end), Math.max(0, end - Math.max(list[i].from, ev.startAt)));
    }
    if (ev.endAt == null && ev.pausedAt) {
      total -= Math.max(0, end - Math.max(ev.pausedAt, ev.startAt));
    }
    return Math.max(0, total);
  }

  function durationOf(ev) {
    return activeMs(ev);
  }

  /* 落在某一天里的有效时长（跨天 + 暂停都算清楚） */
  function overlapActiveMs(ev, from, to) {
    var ov = overlapMs(ev, from, to);
    if (!ov) return 0;
    var end = ev.endAt == null ? Date.now() : ev.endAt;
    var list = pausesOf(ev);
    for (var i = 0; i < list.length; i++) {
      var ps = list[i].from;
      var pe = list[i].to == null ? end : list[i].to;
      ov -= Math.max(0, Math.min(pe, to) - Math.max(ps, from));
    }
    if (ev.endAt == null && ev.pausedAt) {
      ov -= Math.max(0, Math.min(end, to) - Math.max(ev.pausedAt, from));
    }
    return Math.max(0, ov);
  }

  /* ================= 设置 ================= */

  var settings = null;
  var saveTimer = null;

  function loadSettings() {
    var raw = null;
    try { raw = JSON.parse(localStorage.getItem(LS_SETTINGS) || 'null'); } catch (e) { raw = null; }
    var s = Object.assign({}, DEFAULT_SETTINGS, raw || {});
    if (!Array.isArray(s.rules)) s.rules = DEFAULT_SETTINGS.rules.slice();
    // 老版本缺字段时补齐
    ['gameTimebox', 'warnBefore', 'sleepTarget', 'focusTarget'].forEach(function (k) {
      if (typeof s[k] !== 'number' || !isFinite(s[k]) || s[k] <= 0) s[k] = DEFAULT_SETTINGS[k];
    });
    return s;
  }

  function loadSettingsDeferred() {
    settings = loadSettings();
  }

  function saveSettings() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      try { localStorage.setItem(LS_SETTINGS, JSON.stringify(settings)); } catch (e) { /* 配额满，忽略 */ }
    }, 60);
  }

  /* ================= 状态 ================= */

  var openEvent = null;      // 当前未闭合事件
  var allEvents = [];        // 缓存（只用于渲染）
  var busy = false;
  var editing = null;        // 正在编辑的事件
  var stopReason = 'natural';
  var currentTab = 'record';
  var lastWarnAt = 0;

  /* ================= 启动 ================= */

  function init() {
    loadSettingsDeferred();
    renderTopDate();
    bindEvents();
    restoreTab();
    if (!TimeDB) { toast('浏览器不支持本地数据库'); return; }
    refresh().then(function () {
      tick();
      if (openEvent) {
        var t = TYPES[openEvent.type];
        var back = openEvent.leftCount > 0;
        toast(back
          ? '有一段进行中的记录：' + t.label + '，已进行 ' + fmtMin(durationOf(openEvent)) + '，离开过 ' + openEvent.leftCount + ' 次'
          : '有一段进行中的记录：' + t.label + '，已进行 ' + fmtMin(durationOf(openEvent)));
      }
      startClock();
      loadReview(todayKey());
      updateStorageEstimate();
    }).catch(function (err) {
      console.error(err);
      toast('打开本地数据库失败：' + (err && err.message ? err.message : err));
    });

    registerSW();
    bindInstall();
  }

  function startClock() {
    setInterval(tick, 1000);
  }

  /* ================= 事件绑定 ================= */

  function bindEvents() {
    // 底部导航
    $$('.tab').forEach(function (btn) {
      btn.addEventListener('click', function () { switchTab(btn.dataset.tab); });
    });

    // 主区委托：开始 / 结束 / 切换 / 编辑
    $('#hero').addEventListener('click', function (e) {
      var startBtn = e.target.closest('[data-start]');
      if (startBtn) { startType(startBtn.dataset.start); return; }
      if (e.target.closest('#pauseBtn')) { isPaused() ? resumeFocus() : pauseFocus(); return; }
      if (e.target.closest('#stopBtn')) { openStopSheet(); return; }
      var sw = e.target.closest('[data-switch]');
      if (sw) { switchTo(sw.dataset.switch); }
    });

    $('#timeline').addEventListener('click', function (e) {
      var entry = e.target.closest('.entry');
      if (!entry) return;
      var id = entry.dataset.id;
      if (id) openEditSheet(id);
    });

    // 结束面板
    $('#reasonChips').addEventListener('click', function (e) {
      var chip = e.target.closest('.chip');
      if (!chip) return;
      stopReason = chip.dataset.reason;
      $$('#reasonChips .chip').forEach(function (c) { c.classList.toggle('is-on', c === chip); });
    });
    $('#stopCancel').addEventListener('click', function () { closeSheet($('#stopSheet')); });
    $('#stopConfirm').addEventListener('click', confirmStop);

    // 编辑面板
    $('#editChips').addEventListener('click', function (e) {
      var chip = e.target.closest('.chip');
      if (!chip) return;
      $$('#editChips .chip').forEach(function (c) { c.classList.toggle('is-on', c === chip); });
    });
    $('#editTypes').addEventListener('click', function (e) {
      var chip = e.target.closest('[data-type]');
      if (!chip) return;
      $$('#editTypes .chip').forEach(function (c) { c.classList.toggle('is-on', c === chip); });
      $('#editTitle').textContent = TYPES[chip.dataset.type].label + ' · ' + $('#editStart').value;
    });
    $('#editStart').addEventListener('input', syncEditMeta);
    $('#editEnd').addEventListener('input', syncEditMeta);
    $('#editSave').addEventListener('click', saveEdit);
    $('#editDelete').addEventListener('click', deleteEdit);

    // 点击遮罩关闭
    [$('#stopSheet'), $('#editSheet'), $('#ruleSheet')].forEach(function (mask) {
      mask.addEventListener('click', function (e) {
        if (e.target === mask) closeSheet(mask);
      });
    });

    // 底线
    $('#addRuleBtn').addEventListener('click', openRuleSheet);
    $('#ruleCancel').addEventListener('click', function () { closeSheet($('#ruleSheet')); });
    $('#ruleSave').addEventListener('click', saveRule);
    $('#ruleTypeChips').addEventListener('click', function (e) {
      var chip = e.target.closest('[data-rule-type]');
      if (!chip) return;
      $$('#ruleTypeChips .chip').forEach(function (c) { c.classList.toggle('is-on', c === chip); });
      updateRulePreview();
    });
    $('#ruleCmpChips').addEventListener('click', function (e) {
      var chip = e.target.closest('[data-cmp]');
      if (!chip) return;
      $$('#ruleCmpChips .chip').forEach(function (c) { c.classList.toggle('is-on', c === chip); });
      updateRulePreview();
    });
    $('#ruleQuick').addEventListener('click', function (e) {
      var b = e.target.closest('[data-min]');
      if (!b) return;
      $('#ruleMinutes').value = b.dataset.min;
      updateRulePreview();
    });
    $('#ruleMinutes').addEventListener('input', updateRulePreview);
    $('#rules').addEventListener('click', function (e) {
      var del = e.target.closest('[data-del]');
      if (del) { removeRule(del.dataset.del); return; }
      var sw = e.target.closest('[data-toggle]');
      if (sw) { toggleRule(sw.dataset.toggle); }
    });

    // 复盘
    $('#reviewDate').addEventListener('change', function () {
      loadReview($('#reviewDate').value || todayKey());
    });
    $('#reviewForm').addEventListener('submit', saveReview);
    $('#reviewList').addEventListener('click', function (e) {
      var item = e.target.closest('[data-date]');
      if (!item) return;
      $('#reviewDate').value = item.dataset.date;
      loadReview(item.dataset.date);
    });

    // 数据
    $('#exportBtn').addEventListener('click', exportData);
    $('#importBtn').addEventListener('click', function () { $('#importFile').click(); });
    $('#importFile').addEventListener('change', importData);
    $('#clearBtn').addEventListener('click', clearAll);
    $('#installBtn').addEventListener('click', doInstall);

    // 回到前台
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pageshow', function (e) { if (e.persisted) onVisible(); });
  }

  /* ================= 标签页 ================= */

  function switchTab(name) {
    if (!name) return;
    currentTab = name;
    try { localStorage.setItem(LS_TAB, name); } catch (e) { /* ignore */ }
    $$('.view').forEach(function (v) { v.classList.toggle('is-active', v.dataset.view === name); });
    $$('.tab').forEach(function (t) { t.classList.toggle('is-active', t.dataset.tab === name); });
    window.scrollTo({ top: 0, behavior: 'instant' in window ? 'instant' : 'auto' });

    if (name === 'rules') renderRules(currentTotals);
    if (name === 'review') loadReview($('#reviewDate').value || todayKey());
    if (name === 'data') { updateStorageEstimate(); renderInstallCard(); }
  }

  function restoreTab() {
    var t = null;
    try { t = localStorage.getItem(LS_TAB); } catch (e) { /* ignore */ }
    switchTab(t && $('#view-' + t) ? t : 'record');
  }

  /* ================= 计时核心 ================= */

  function loadOpen() {
    return TimeDB.openEvents().then(function (list) {
      list.sort(function (a, b) { return a.startAt - b.startAt; });
      var extras = list.slice(0, Math.max(0, list.length - 1));
      var ops = extras.map(function (ev) {
        return TimeDB.putEvent(Object.assign({}, ev, {
          endAt: Date.now(), endReason: 'manual', state: 'closed'
        }));
      });
      openEvent = list.length ? list[list.length - 1] : null;
      // 兜底：同一时刻只允许一条未闭合事件，多余的收尾
      return Promise.all(ops).then(function () { return openEvent; });
    });
  }

  function startType(type) {
    if (busy || !TYPES[type]) return;
    busy = true;
    var now = Date.now();
    var chain = Promise.resolve();

    if (openEvent) {
      var prev = TYPES[openEvent.type];
      chain = closeOpen(now, 'switched').then(function () {
        toast('「' + prev.label + '」已收尾为「切走了」');
      });
    }

    chain.then(function () {
      var ev = {
        id: uid(),
        type: type,
        startAt: Date.now(),
        endAt: null,
        endReason: null,
        note: '',
        state: 'open',
        leftCount: 0,
        leftAt: null,
        warnedAt: null,
        pauses: [],
        pausedAt: null
      };
      return TimeDB.putEvent(ev).then(function () { openEvent = ev; });
    }).then(function () {
      return refresh();
    }).then(function () {
      toast('开始：' + TYPES[type].label);
      vibrate(12);
    }).catch(function (err) {
      console.error(err);
      toast('开始失败：' + err.message);
    }).then(function () {
      busy = false;
    });
  }

  function isPaused() {
    return !!(openEvent && openEvent.pausedAt);
  }

  function syncOpenIntoLists(ev) {
    for (var i = 0; i < allEvents.length; i++) {
      if (allEvents[i].id === ev.id) { allEvents[i] = ev; return; }
    }
    allEvents.push(ev);
  }

  function pauseFocus() {
    if (!openEvent || openEvent.type !== 'focus' || openEvent.pausedAt) return;
    var ev = Object.assign({}, openEvent, { pausedAt: Date.now() });
    openEvent = ev;
    syncOpenIntoLists(ev);
    TimeDB.putEvent(ev).catch(function () {});
    renderHero();
    renderToday();
    tick();
    toast('已暂停，这段空档不算你的时间');
    vibrate(8);
  }

  function resumeFocus() {
    if (!openEvent || !openEvent.pausedAt) return;
    var now = Date.now();
    var pauses = pausesOf(openEvent).concat([{ from: openEvent.pausedAt, to: now }]);
    var ev = Object.assign({}, openEvent, { pauses: pauses, pausedAt: null });
    openEvent = ev;
    syncOpenIntoLists(ev);
    TimeDB.putEvent(ev).catch(function () {});
    renderHero();
    renderToday();
    tick();
    toast('继续 · 刚才那段不算');
    vibrate(8);
  }

  function switchTo(type) {
    if (!openEvent || openEvent.type === type) return;
    startType(type);
  }

  function closeOpen(now, reason, note) {
    if (!openEvent) return Promise.resolve(null);
    var pauses = pausesOf(openEvent).slice();
    if (openEvent.pausedAt) pauses.push({ from: openEvent.pausedAt, to: now });
    var ev = Object.assign({}, openEvent, {
      endAt: now,
      endReason: reason,
      state: 'closed',
      pauses: pauses,
      pausedAt: null,
      note: typeof note === 'string' ? note : (openEvent.note || '')
    });
    openEvent = null;
    return TimeDB.putEvent(ev);
  }

  function openStopSheet() {
    if (!openEvent) return;
    var dur = durationOf(openEvent);
    stopReason = 'natural';
    $$('#reasonChips .chip').forEach(function (c) {
      c.classList.toggle('is-on', c.dataset.reason === 'natural');
    });
    var noteEl = $('#stopNote');
    noteEl.value = openEvent.note || '';
    $('#stopDur').textContent = fmtMin(dur);
    openSheet($('#stopSheet'));
    setTimeout(function () { noteEl.focus(); }, 260);
  }

  function confirmStop() {
    if (!openEvent) { closeSheet($('#stopSheet')); return; }
    var btn = $('#stopConfirm');
    btn.disabled = true;
    var note = $('#stopNote').value.trim();
    var now = Date.now();
    var dur = now - openEvent.startAt;
    var reason = stopReason;
    var label = TYPES[openEvent.type].label;

    closeOpen(now, reason, note).then(function () {
      closeSheet($('#stopSheet'));
      return refresh();
    }).then(function () {
      toast('记下了：' + label + ' ' + fmtMin(dur) + ' · ' + REASONS[reason]);
      vibrate(10);
    }).catch(function (err) {
      console.error(err);
      toast('保存失败：' + err.message);
    }).then(function () {
      btn.disabled = false;
    });
  }

  /* ================= 刷新渲染 ================= */

  var currentTotals = { focus: 0, game: 0, sleep: 0 };

  function refresh() {
    return loadOpen().then(function () {
      return TimeDB.allEvents();
    }).then(function (list) {
      allEvents = list || [];
      renderHero();
      renderToday();
      tick();
    });
  }

  function renderHero() {
    var hero = $('#hero');
    if (!openEvent) {
      hero.className = 'hero card';
      hero.innerHTML = idleHTML();
      return;
    }
    var t = TYPES[openEvent.type];
    hero.className = 'hero card is-running type-' + t.key + (isPaused() ? ' is-paused' : '');
    hero.innerHTML = runningHTML(t);
  }

  function idleHTML() {
    var order = ['focus', 'game', 'sleep'];
    var tiles = order.map(function (k) {
      var t = TYPES[k];
      return '' +
        '<button class="start-tile" type="button" data-start="' + k + '" style="--c:' + t.color + '">' +
          '<span class="tile-icon">' + ICONS[k] + '</span>' +
          '<span class="tile-body"><span class="tile-name">' + t.label + '</span><span class="tile-hint">' + t.hint + '</span></span>' +
          '<span class="tile-go">开始</span>' +
        '</button>';
    }).join('');

    return '' +
      '<div class="hero-top"><span class="hero-now">现在</span><span class="hero-clock" id="heroClock">' + fmtTime(Date.now()) + '</span></div>' +
      '<h2 class="hero-title">要开始一段什么？</h2>' +
      '<p class="hero-sub">点一下就开始，结束时再补原因。</p>' +
      '<div class="start-grid">' + tiles + '</div>';
  }

  function runningHTML(t) {
    var extra = '';
    if (t.key === 'game') {
      extra = '' +
        '<div class="box-progress">' +
          '<div class="box-row"><span>时间盒 ' + settings.gameTimebox + ' 分钟</span><b id="boxLeft">—</b></div>' +
          '<div class="bar" id="boxBar" style="--c:' + t.color + '">' +
            '<i style="width:0%"></i>' +
            '<span class="bar-mark" style="left:' + Math.round((1 - settings.warnBefore / settings.gameTimebox) * 100) + '%"></span>' +
          '</div>' +
        '</div>';
    } else if (t.key === 'sleep') {
      extra = '' +
        '<div class="box-progress">' +
          '<div class="box-row"><span>目标 ' + fmtMin(settings.sleepTarget * 60000) + '</span><b id="boxLeft">—</b></div>' +
          '<div class="bar" id="boxBar" style="--c:' + t.color + '"><i style="width:0%"></i></div>' +
        '</div>';
    }

    var others = ['focus', 'game', 'sleep'].filter(function (k) { return k !== t.key; }).map(function (k) {
      return '<button class="switch-btn" type="button" data-switch="' + k + '">切到' + TYPES[k].label + '</button>';
    }).join('');

    return '' +
      '<div class="hero-top">' +
        '<span class="type-pill" style="--c:' + t.color + '"><i></i>' + t.label + '</span>' +
        '<span class="hero-clock" id="heroClock">' + fmtTime(Date.now()) + '</span>' +
      '</div>' +
      '<div class="ring" id="ring" style="--c:' + t.color + ';--p:0">' +
        '<div class="ring-inner"><div class="timer" id="timerText">00:00:00</div><div class="timer-cap" id="timerCap">已进行</div></div>' +
      '</div>' +
      '<div class="hero-meta" id="heroMeta"></div>' +
      '<div id="heroExtra">' + extra + '</div>' +
      (t.key === 'focus'
        ? '<button class="btn-stop" id="pauseBtn" type="button">' + (isPaused() ? '继续' : '暂停') + '</button>' +
          '<button class="btn-text" id="stopBtn" type="button">结束这一段</button>'
        : '<button class="btn-stop" id="stopBtn" type="button">结束这一段</button>') +
      '<div class="switch-row"><span>切换</span>' + others + '</div>';
  }

  /* 每秒：只更新文本与进度，不重建 DOM */
  function tick() {
    var clock = $('#heroClock');
    if (clock) clock.textContent = fmtTime(Date.now());

    if (!openEvent) return;

    var dur = activeMs(openEvent);
    var t = TYPES[openEvent.type];
    var timerText = $('#timerText');
    if (timerText) timerText.textContent = fmtClock(dur);
    var cap = $('#timerCap');
    if (cap) cap.textContent = isPaused() ? '已暂停' : '已进行';

    var ring = $('#ring');
    var p = 0;
    if (t.key === 'game') p = clamp(dur / (settings.gameTimebox * 60000), 0, 1);
    else if (t.key === 'sleep') p = clamp(dur / (settings.sleepTarget * 60000), 0, 1);
    else p = (dur % 3600000) / 3600000;
    if (ring) ring.style.setProperty('--p', p.toFixed(4));

    var meta = $('#heroMeta');
    if (meta) {
      var leftCount = openEvent.leftCount || 0;
      var pausedTotal = 0;
      pausesOf(openEvent).forEach(function (x) { pausedTotal += pauseSpan(x, Date.now()); });
      if (openEvent.pausedAt) pausedTotal += Date.now() - openEvent.pausedAt;
      var bits = ['从 ' + fmtTime(openEvent.startAt) + ' 开始'];
      if (openEvent.pausedAt) bits.push('暂停于 ' + fmtTime(openEvent.pausedAt));
      if (pausedTotal > 30000) bits.push('累计暂停 ' + fmtMin(pausedTotal));
      if (leftCount > 0) bits.push('离开过 ' + leftCount + ' 次');
      meta.textContent = bits.join(' · ');
    }

    if (t.key === 'game') updateGameBox(dur);
    else if (t.key === 'sleep') updateSleepTarget(dur);

    var sd = $('#stopDur');
    if (!$('#stopSheet').hidden && sd) sd.textContent = fmtMin(dur);
  }

  function updateGameBox(dur) {
    var box = settings.gameTimebox * 60000;
    var left = box - dur;
    var bar = $('#boxBar');
    var label = $('#boxLeft');
    if (!bar || !label) return;

    bar.querySelector('i').style.width = clamp(dur / box, 0, 1) * 100 + '%';
    bar.classList.toggle('is-over', left < 0);

    if (left > 0) {
      label.textContent = '还剩 ' + fmtLeft(left);
      label.className = left <= settings.warnBefore * 60000 ? 'is-near' : '';
    } else {
      label.textContent = '已超出 ' + fmtLeft(-left);
      label.className = 'is-over';
    }

    var warn = $('#warnBox');
    var needWarn = left <= settings.warnBefore * 60000;
    if (needWarn) {
      if (!warn) {
        warn = document.createElement('div');
        warn.className = 'warn-box';
        warn.id = 'warnBox';
        bar.parentNode.parentNode.insertBefore(warn, bar.parentNode.nextSibling);
      }
      warn.classList.toggle('is-over', left <= 0);
      warn.innerHTML = left > 0
        ? '<b>时间盒还剩 ' + fmtLeft(left) + '。</b>到点就收，别让游戏替你决定什么时候停。'
        : '<b>已超出时间盒 ' + fmtLeft(-left) + '。</b>现在收尾，明天还有得玩。';

      // 跨过预警线时提醒一次（刷新页面后不会重复提醒）
      if (!openEvent.warnedAt && left > 0 && left <= settings.warnBefore * 60000) {
        openEvent.warnedAt = Date.now();
        TimeDB.putEvent(Object.assign({}, openEvent)).catch(function () {});
        toast('游戏时间盒还剩 ' + fmtLeft(left));
        vibrate([40, 70, 40]);
      }
      if (!openEvent.warnedAt && left <= 0) {
        openEvent.warnedAt = Date.now();
        TimeDB.putEvent(Object.assign({}, openEvent)).catch(function () {});
        toast('游戏时间盒已用完：' + fmtLeft(-left));
        vibrate([80, 60, 80]);
      }
    } else if (warn) {
      warn.remove();
    }
  }

  function updateSleepTarget(dur) {
    var target = settings.sleepTarget * 60000;
    var left = target - dur;
    var bar = $('#boxBar');
    var label = $('#boxLeft');
    if (!bar || !label) return;

    bar.querySelector('i').style.width = clamp(dur / target, 0, 1) * 100 + '%';
    if (left > 0) {
      label.textContent = '还差 ' + fmtLeft(left);
      label.className = '';
    } else {
      label.textContent = '已睡够，多睡 ' + fmtMinUp(-left);
      label.className = '';
    }
  }

  /* ================= 今日视图 ================= */

  function renderTopDate() {
    var el = $('#topDate');
    if (el) el.textContent = fmtDay(Date.now());
  }

  function renderToday() {
    var now = Date.now();
    var from = dayStart(now);
    var to = addDays(from, 1);

    var totals = { focus: 0, game: 0, sleep: 0 };
    var counts = { focus: 0, game: 0, sleep: 0 };
    var dayEvents = [];

    allEvents.forEach(function (ev) {
      if (!TYPES[ev.type]) return;
      var ov = overlapActiveMs(ev, from, to);
      if (ov > 0) {
        totals[ev.type] += ov;
        counts[ev.type] += 1;
        dayEvents.push(ev);
      }
    });
    currentTotals = totals;

    var totalMs = totals.focus + totals.game + totals.sleep;
    var segs = dayEvents.length;
    var span = $('#todaySpan');
    if (span) span.textContent = segs ? segs + ' 段 · ' + fmtMin(totalMs) : '还没开始';
    var tlMeta = $('#timelineMeta');
    if (tlMeta) tlMeta.textContent = segs ? '共 ' + segs + ' 段' : '';

    renderStats(totals, counts);
    renderTodayLine(totals, from, now);
    renderChart();
    renderTimeline(dayEvents);
    renderRules(totals);
  }

  /* 醒着的时间里，有多少是你自己掌握的 —— 这才是「在场」要看的数 */
  function renderTodayLine(totals, dayFrom, now) {
    var el = $('#todayLine');
    if (!el) return;
    var awake = Math.max(0, (now - dayFrom) - totals.sleep);
    if (awake < 30 * 60000) { el.hidden = true; return; }
    var pct = Math.round((totals.focus / awake) * 100);
    el.innerHTML = '醒着 <b>' + fmtMin(awake) + '</b>，其中 <b>' + fmtMin(totals.focus) +
      '</b>由你自己掌握（<b>' + pct + '%</b>）';
    el.hidden = false;
  }

  function ruleFor(type) {
    if (!settings) return null;
    return (settings.rules || []).filter(function (r) {
      return r.enabled && r.type === type;
    })[0] || null;
  }

  function renderStats(totals, counts) {
    var html = ['focus', 'game', 'sleep'].map(function (k) {
      var t = TYPES[k];
      var rule = ruleFor(k);
      var pct = 0;
      if (rule && rule.minutes > 0) pct = clamp(totals[k] / (rule.minutes * 60000), 0, 1) * 100;
      var live = openEvent && openEvent.type === k;
      return '' +
        '<div class="stat' + (live ? ' is-live' : '') + '" style="--c:' + t.color + '">' +
          '<div class="stat-top"><span class="dot"></span><span>' + t.label + '</span></div>' +
          '<div class="stat-val">' + fmtMin(totals[k]) + '</div>' +
          '<div class="stat-sub">' + (counts[k] ? counts[k] + ' 段' : '—') + (live ? (isPaused() ? ' · 暂停中' : ' · 进行中') : '') + '</div>' +
          (rule ? '<div class="stat-bar"><i style="width:' + pct.toFixed(1) + '%"></i></div>' : '') +
        '</div>';
    }).join('');
    $('#stats').innerHTML = html;
  }

  function renderChart() {
    var now = Date.now();
    var todayFrom = dayStart(now);
    var days = [];
    var maxMs = 60 * 60000;

    for (var i = 6; i >= 0; i--) {
      var from = addDays(todayFrom, -i);
      var to = addDays(from, 1);
      var d = { from: from, totals: { focus: 0, game: 0, sleep: 0 }, total: 0 };
      allEvents.forEach(function (ev) {
        if (!TYPES[ev.type]) return;
        var ov = overlapActiveMs(ev, from, to);
        if (ov > 0) { d.totals[ev.type] += ov; d.total += ov; }
      });
      if (d.total > maxMs) maxMs = d.total;
      days.push(d);
    }

    var html = days.map(function (d) {
      var date = new Date(d.from);
      var isToday = d.from === todayFrom;
      var label = isToday ? '今天' : WEEK[date.getDay()];
      var h = d.total > 0 ? Math.max(2, (d.total / maxMs) * 100) : 2;
      var segs = ['sleep', 'focus', 'game'].map(function (k) {
        if (!d.totals[k]) return '';
        return '<i class="seg seg-' + k + '" style="flex:' + d.totals[k] + '"></i>';
      }).join('');
      var title = (date.getMonth() + 1) + '月' + date.getDate() + '日 · ' +
        '自己的时间 ' + fmtMin(d.totals.focus) + ' / 游戏 ' + fmtMin(d.totals.game) + ' / 睡眠 ' + fmtMin(d.totals.sleep);
      return '' +
        '<div class="col' + (isToday ? ' is-today' : '') + '" title="' + esc(title) + '">' +
          '<div class="col-stack" style="height:' + h.toFixed(1) + '%">' + (segs || '') + '</div>' +
          '<span class="col-label">' + label + '</span>' +
        '</div>';
    }).join('');

    $('#chart').innerHTML = html;

    var legend = [
      '<span><i class="seg-focus" style="background:' + TYPES.focus.color + '"></i>自己的时间</span>',
      '<span><i class="seg-game" style="background:' + TYPES.game.color + '"></i>游戏</span>',
      '<span><i class="seg-sleep" style="background:' + TYPES.sleep.color + '"></i>睡眠</span>'
    ].join('');
    $('#legend').innerHTML = legend;

    var foot = $('#chartFoot');
    if (foot) {
      foot.textContent = '最高的一天 ' + fmtMin(maxMs) + '。柱子含跨零点拆分，点按看当天明细。';
    }
  }

  function renderTimeline(dayEvents) {
    var list = dayEvents.slice().sort(function (a, b) {
      if (a.state === 'open' && b.state !== 'open') return -1;
      if (b.state === 'open' && a.state !== 'open') return 1;
      return b.startAt - a.startAt;
    });

    var ul = $('#timeline');
    var empty = $('#timelineEmpty');

    if (!list.length) {
      ul.innerHTML = '';
      empty.hidden = false;
      return;
    }
    empty.hidden = true;

    ul.innerHTML = list.map(function (ev) {
      var t = TYPES[ev.type];
      var isOpen = ev.state === 'open';
      var dur = durationOf(ev);
      var pz = pausesOf(ev).length + (ev.pausedAt ? 1 : 0);
      var sub = isOpen
        ? '从 ' + fmtTime(ev.startAt) + ' 开始 · ' + (ev.pausedAt ? '已暂停' : '进行中')
        : fmtTime(ev.startAt) + ' – ' + fmtTime(ev.endAt) +
          (ev.startAt < dayStart(ev.endAt) ? ' · 跨天' : '') +
          (pz ? ' · 暂停 ' + pz + ' 次' : '');

      var badge = '';
      if (isOpen) {
        badge = '<span class="badge is-live">进行中</span>';
      } else if (ev.endReason) {
        var bad = ev.endReason === 'interrupted' || ev.endReason === 'switched';
        badge = '<span class="badge' + (bad ? ' is-bad' : '') + '">' + REASONS[ev.endReason] + '</span>';
      }

      var note = ev.note ? '<p class="entry-note">' + esc(ev.note) + '</p>' : '';

      return '' +
        '<li class="entry' + (isOpen ? ' is-open' : '') + '" data-id="' + esc(ev.id) + '" style="--c:' + t.color + '">' +
          '<span class="entry-dot"></span>' +
          '<div class="entry-main">' +
            '<div class="entry-top"><span class="entry-name">' + t.label + badge + '</span>' +
            '<span class="entry-dur">' + fmtMin(dur) + '</span></div>' +
            '<div class="entry-sub">' + sub + '</div>' +
            note +
          '</div>' +
          '<button class="icon-btn" type="button" aria-label="编辑这条记录">⋯</button>' +
        '</li>';
    }).join('');
  }

  /* ================= 底线 ================= */

  function ruleText(r) {
    if (r.label) return r.label;
    return TYPES[r.type].label + ' ' + (r.cmp === 'lte' ? '≤' : '≥') + ' ' + fmtMin(r.minutes * 60000);
  }

  function renderRules(totals) {
    var ul = $('#rules');
    if (!ul) return;
    var rules = settings.rules || [];

    if (!rules.length) {
      ul.innerHTML = '<li class="empty">还没有条款。点右上角「＋ 添加」，比如「游戏 ≤ 1 小时」。</li>';
      return;
    }

    ul.innerHTML = rules.map(function (r) {
      var total = totals ? (totals[r.type] || 0) : 0;
      var limit = r.minutes * 60000;
      var ok = r.cmp === 'lte' ? total <= limit : total >= limit;
      var pct = clamp(total / limit, 0, 1) * 100;
      var state = !r.enabled
        ? '<span class="rule-state off">已停用</span>'
        : (ok ? '<span class="rule-state ok">达标</span>'
              : '<span class="rule-state bad">' + (r.cmp === 'lte' ? '越线' : '没做到') + '</span>');

      return '' +
        '<li class="rule' + (r.enabled ? '' : ' is-off') + (r.enabled && !ok ? ' is-bad' : '') + '">' +
          '<div class="rule-main">' +
            '<div class="rule-top"><span class="rule-title">' + esc(ruleText(r)) + '</span>' + state + '</div>' +
            '<div class="bar" style="--c:' + TYPES[r.type].color + '"><i style="width:' + pct.toFixed(1) + '%"></i></div>' +
            '<div class="rule-sub">今天 ' + fmtMin(total) + ' / ' + (r.cmp === 'lte' ? '上限 ' : '目标 ') + fmtMin(limit) + '</div>' +
          '</div>' +
          '<button class="switch' + (r.enabled ? ' is-on' : '') + '" type="button" data-toggle="' + esc(r.id) + '" role="switch" aria-checked="' + (r.enabled ? 'true' : 'false') + '" aria-label="启用这条底线"></button>' +
          '<button class="icon-btn rule-del" type="button" data-del="' + esc(r.id) + '" aria-label="删除这条底线">✕</button>' +
        '</li>';
    }).join('');
  }

  function updateRulePreview() {
    var type = ($('#ruleTypeChips .chip.is-on') || {}).dataset;
    var cmp = ($('#ruleCmpChips .chip.is-on') || {}).dataset;
    var min = parseInt($('#ruleMinutes').value, 10);
    var el = $('#rulePreview');
    if (!el) return;
    if (!type || !min || min < 1) { el.textContent = '—'; return; }
    el.textContent = TYPES[type.ruleType].label + ' ' +
      (cmp && cmp.cmp === 'lte' ? '≤' : '≥') + ' ' + fmtMin(min * 60000);
  }

  function openRuleSheet() {
    $$('#ruleTypeChips .chip').forEach(function (c, i) { c.classList.toggle('is-on', i === 0); });
    $$('#ruleCmpChips .chip').forEach(function (c, i) { c.classList.toggle('is-on', i === 0); });
    $('#ruleMinutes').value = 60;
    $('#ruleLabel').value = '';
    updateRulePreview();
    openSheet($('#ruleSheet'));
  }

  function saveRule() {
    var typeChip = $('#ruleTypeChips .chip.is-on');
    var cmpChip = $('#ruleCmpChips .chip.is-on');
    var minutes = parseInt($('#ruleMinutes').value, 10);
    var label = $('#ruleLabel').value.trim();

    if (!typeChip || !cmpChip) { toast('先选一类和算法'); return; }
    if (!minutes || minutes < 1 || minutes > 1440) { toast('时长填 1–1440 分钟'); return; }

    settings.rules.push({
      id: 'r-' + Date.now().toString(36),
      type: typeChip.dataset.ruleType,
      cmp: cmpChip.dataset.cmp,
      minutes: minutes,
      label: label,
      enabled: true
    });
    saveSettings();
    closeSheet($('#ruleSheet'));
    renderRules(currentTotals);
    renderStats(currentTotals, countByType());
    toast('已加入底线清单');
  }

  function countByType() {
    var now = Date.now();
    var from = dayStart(now), to = addDays(from, 1);
    var c = { focus: 0, game: 0, sleep: 0 };
    allEvents.forEach(function (ev) {
      if (!TYPES[ev.type]) return;
      if (overlapActiveMs(ev, from, to) > 0) c[ev.type] += 1;
    });
    return c;
  }

  function removeRule(id) {
    settings.rules = settings.rules.filter(function (r) { return r.id !== id; });
    saveSettings();
    renderRules(currentTotals);
    renderStats(currentTotals, countByType());
    toast('已删除');
  }

  function toggleRule(id) {
    settings.rules.forEach(function (r) { if (r.id === id) r.enabled = !r.enabled; });
    saveSettings();
    renderRules(currentTotals);
    renderStats(currentTotals, countByType());
  }

  /* ================= 复盘 ================= */

  function dayStats(ts) {
    var from = dayStart(ts), to = addDays(from, 1);
    var st = { focus: 0, game: 0, sleep: 0, count: 0, interrupted: 0 };
    allEvents.forEach(function (ev) {
      if (!TYPES[ev.type]) return;
      var ov = overlapActiveMs(ev, from, to);
      if (ov > 0) {
        st[ev.type] += ov;
        st.count += 1;
        if (ev.endReason === 'interrupted' || ev.endReason === 'switched') st.interrupted += 1;
      }
    });
    return st;
  }

  function loadReview(dateKey) {
    var dk = dateKey || todayKey();
    var ts = keyToTs(dk);
    var st = dayStats(ts);

    var d = new Date(ts);
    $('#reviewSummary').innerHTML = '' +
      '<div class="summary-grid">' +
        '<div class="summary-cell"><b>' + (st.count || 0) + '</b><span>段数</span></div>' +
        '<div class="summary-cell"><b>' + shortHours(st.focus) + '</b><span>自己的时间</span></div>' +
        '<div class="summary-cell"><b>' + shortHours(st.game) + '</b><span>游戏</span></div>' +
        '<div class="summary-cell"><b>' + shortHours(st.sleep) + '</b><span>睡眠</span></div>' +
      '</div>' +
      '<p class="summary-foot">' + (new Date(ts).getMonth() + 1) + ' 月 ' + d.getDate() + ' 日' +
        (st.interrupted ? ' · 被打断 ' + st.interrupted + ' 次' : '') + '</p>';

    TimeDB.getReview(dk).then(function (r) {
      $('#reviewA').value = r ? (r.a || '') : '';
      $('#reviewB').value = r ? (r.b || '') : '';
      $('#reviewC').value = r ? (r.c || '') : '';
    }).catch(function (err) { console.error(err); });

    renderReviewList();
  }

  function shortHours(ms) {
    var h = ms / 3600000;
    if (h < 1) return Math.max(ms > 0 ? 1 : 0, Math.round(ms / 60000)) + 'm';
    return (Math.round(h * 10) / 10) + 'h';
  }

  function renderReviewList() {
    TimeDB.allReviews().then(function (list) {
      list = (list || []).sort(function (a, b) { return a.date < b.date ? 1 : -1; }).slice(0, 8);
      var ul = $('#reviewList');
      var empty = $('#reviewEmpty');
      if (!list.length) { ul.innerHTML = ''; empty.hidden = false; return; }
      empty.hidden = true;
      ul.innerHTML = list.map(function (r) {
        var lines = [
          ['①', r.a], ['②', r.b], ['③', r.c]
        ].filter(function (p) { return p[1]; }).map(function (p) {
          return '<div class="review-line"><span>' + p[0] + '</span>' + esc(p[1]) + '</div>';
        }).join('');
        return '' +
          '<li class="review-item" data-date="' + esc(r.date) + '">' +
            '<div class="review-date">' + esc(r.date) + '</div>' + lines +
          '</li>';
      }).join('');
    });
  }

  function saveReview(e) {
    e.preventDefault();
    var dk = $('#reviewDate').value || todayKey();
    var rec = {
      date: dk,
      a: $('#reviewA').value.trim(),
      b: $('#reviewB').value.trim(),
      c: $('#reviewC').value.trim(),
      updatedAt: Date.now()
    };
    TimeDB.putReview(rec).then(function () {
      toast('复盘已存：' + dk);
      renderReviewList();
    }).catch(function (err) {
      console.error(err);
      toast('保存失败：' + err.message);
    });
  }

  /* ================= 编辑记录 ================= */

  function timeToMinutes(v) {
    var p = String(v || '00:00').split(':');
    return (parseInt(p[0], 10) || 0) * 60 + (parseInt(p[1], 10) || 0);
  }
  function minutesToTime(ts) {
    var d = new Date(ts);
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  function openEditSheet(id) {
    var ev = null;
    for (var i = 0; i < allEvents.length; i++) {
      if (allEvents[i].id === id) { ev = allEvents[i]; break; }
    }
    if (!ev) return;
    editing = ev;

    $('#editTitle').textContent = TYPES[ev.type].label + ' · ' + fmtTime(ev.startAt);
    $('#editDur').textContent = fmtMin(durationOf(ev));
    $('#editNote').value = ev.note || '';

    $$('#editTypes .chip').forEach(function (c) {
      c.classList.toggle('is-on', c.dataset.type === ev.type);
    });
    $$('#editChips .chip').forEach(function (c) {
      c.classList.toggle('is-on', c.dataset.reason === (ev.endReason || 'natural'));
    });

    $('#editStart').value = minutesToTime(ev.startAt);
    var endEl = $('#editEnd');
    var hint = $('#editTimeHint');
    if (ev.endAt == null) {
      endEl.value = '';
      endEl.disabled = true;
      hint.textContent = '这段还在进行中，结束时间会在你点「结束」时写入。';
    } else {
      endEl.value = minutesToTime(ev.endAt);
      endEl.disabled = false;
      hint.textContent = '结束时间早于开始，会自动算到第二天。';
    }

    openSheet($('#editSheet'));
  }

  /* 改时间时标题和时长跟着动，免得保存前看不到结果 */
  function syncEditMeta() {
    if (!editing) return;
    var typeChip = $('#editTypes .chip.is-on');
    var label = typeChip ? TYPES[typeChip.dataset.type].label : TYPES[editing.type].label;
    $('#editTitle').textContent = label + ' · ' + $('#editStart').value;

    var base = dayStart(editing.startAt);
    var startAt = base + timeToMinutes($('#editStart').value) * 60000;
    var dur = 0;
    if (editing.endAt == null) {
      dur = Math.max(0, Date.now() - startAt);
    } else {
      var e = base + timeToMinutes($('#editEnd').value) * 60000;
      while (e <= startAt) e += 86400000;
      dur = e - startAt;
    }
    $('#editDur').textContent = fmtMin(dur);
  }

  /* 改类型、改起止时间、改原因，都在这里落库 */
  function saveEdit() {
    if (!editing) return;

    var typeChip = $('#editTypes .chip.is-on');
    var reasonChip = $('#editChips .chip.is-on');
    if (!typeChip) { toast('先选一个类型'); return; }

    var base = dayStart(editing.startAt);
    var startAt = base + timeToMinutes($('#editStart').value) * 60000;
    var isOpen = editing.endAt == null;
    var endAt = editing.endAt;

    if (!isOpen) {
      var e = base + timeToMinutes($('#editEnd').value) * 60000;
      while (e <= startAt) e += 86400000;
      endAt = e;
    }

    var ev = Object.assign({}, editing, {
      type: typeChip.dataset.type,
      startAt: startAt,
      endAt: endAt,
      endReason: isOpen ? null : (reasonChip ? reasonChip.dataset.reason : (editing.endReason || 'natural')),
      note: $('#editNote').value.trim()
    });

    TimeDB.putEvent(ev).then(function () {
      closeSheet($('#editSheet'));
      editing = null;
      return refresh();
    }).then(function () {
      toast('已更新');
    }).catch(function (err) {
      console.error(err);
      toast('更新失败：' + err.message);
    });
  }

  function deleteEdit() {
    if (!editing) return;
    var ev = editing;
    if (!window.confirm('删掉这条「' + TYPES[ev.type].label + ' ' + fmtMin(durationOf(ev)) + '」？')) return;
    TimeDB.deleteEvent(ev.id).then(function () {
      closeSheet($('#editSheet'));
      editing = null;
      return refresh();
    }).then(function () {
      toast('已删除');
    }).catch(function (err) {
      console.error(err);
      toast('删除失败：' + err.message);
    });
  }

  /* ================= 数据 ================= */

  function exportData() {
    Promise.all([TimeDB.allEvents(), TimeDB.allReviews()]).then(function (res) {
      var payload = {
        app: 'timelog',
        version: 1,
        exportedAt: new Date().toISOString(),
        settings: settings,
        events: res[0] || [],
        reviews: res[1] || []
      };
      var blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = 'timelog-' + todayKey() + '.json';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 3000);
      toast('已导出 ' + (payload.events.length) + ' 条记录');
    }).catch(function (err) {
      console.error(err);
      toast('导出失败：' + err.message);
    });
  }

  function importData(e) {
    var file = e.target.files && e.target.files[0];
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      var data;
      try { data = JSON.parse(reader.result); } catch (err) { toast('文件不是合法 JSON'); return; }
      if (!data || !Array.isArray(data.events)) { toast('文件里没有 events 字段'); return; }
      var n = data.events.length;
      if (!window.confirm('导入 ' + n + ' 条记录？同 id 的记录会被覆盖。')) return;

      var clean = data.events.filter(function (ev) { return ev && ev.id && ev.type && ev.startAt; });
      TimeDB.putEvents(clean).then(function () {
        var reviews = Array.isArray(data.reviews) ? data.reviews : [];
        return Promise.all(reviews.filter(function (r) { return r && r.date; }).map(function (r) {
          return TimeDB.putReview(r);
        }));
      }).then(function () {
        return refresh();
      }).then(function () {
        renderReviewList();
        toast('已导入 ' + clean.length + ' 条记录');
      }).catch(function (err) {
        console.error(err);
        toast('导入失败：' + err.message);
      });
    };
    reader.readAsText(file);
    e.target.value = '';
  }

  function clearAll() {
    if (!window.confirm('删掉全部记录和复盘？此操作不可撤销。')) return;
    if (!window.confirm('再确认一次：真的要清空吗？')) return;
    TimeDB.clearAll().then(function () {
      openEvent = null;
      return refresh();
    }).then(function () {
      renderReviewList();
      toast('已清空');
    }).catch(function (err) {
      console.error(err);
      toast('清空失败：' + err.message);
    });
  }

  function updateStorageEstimate() {
    var el = $('#storageEstimate');
    if (!el) return;
    if (!navigator.storage || !navigator.storage.estimate) { el.textContent = '—'; return; }
    navigator.storage.estimate().then(function (est) {
      if (!est || !est.usage) { el.textContent = '—'; return; }
      var mb = est.usage / 1048576;
      var used = mb < 1 ? Math.round(est.usage / 1024) + ' KB' : mb.toFixed(1) + ' MB';
      var qmb = (est.quota || 0) / 1048576;
      var quota = qmb >= 1024 ? (qmb / 1024).toFixed(0) + ' GB' : Math.round(qmb) + ' MB';
      el.textContent = used + ' / ' + quota;
    }).catch(function () { el.textContent = '—'; });
  }

  /* ================= 安装 / Service Worker ================= */

  var deferredPrompt = null;

  /* 装到主屏：不同浏览器的入口不一样，装不上时得给具体路径 */
  var INSTALL_STEPS = {
    edge: [
      '点右上角 <b>⋮</b> 菜单',
      '找 <b>添加到手机</b>（有的版本叫「安装应用」）',
      '没反应就去系统设置 → 应用 → Edge → 权限，把 <b>桌面快捷方式</b> 打开'
    ],
    chrome: [
      '点右上角 <b>⋮</b> 菜单',
      '选 <b>添加到主屏幕</b> / <b>安装应用</b>',
      '没有 Google 服务的机型可能只生成普通快捷方式，图标一样在桌面'
    ],
    miui: [
      '点底部的菜单按钮',
      '选 <b>添加到桌面</b>',
      '小米 / 红米：设置 → 应用设置 → 应用管理 → 浏览器 → 权限，允许 <b>桌面快捷方式</b>'
    ],
    huawei: [
      '点底部菜单',
      '选 <b>添加到桌面</b>',
      '鸿蒙 / EMUI 也要在权限里允许 <b>创建桌面快捷方式</b>'
    ],
    quark: ['点底部菜单', '选 <b>添加到桌面</b>'],
    samsung: ['点右下角 <b>≡</b>', '选 <b>添加页面到</b> → <b>主屏幕</b>'],
    opera: ['点右下角 <b>O</b> 菜单', '选 <b>添加到主屏幕</b>'],
    firefox: ['点 <b>⋮</b> 菜单', '选 <b>添加到主屏幕</b>', '火狐只能加快捷方式，不会全屏独立打开'],
    wechat: ['点右上角 <b>…</b>', '选 <b>在浏览器打开</b>', '微信内置浏览器不给装，换系统浏览器再添加'],
    ios: ['必须用 Safari 打开', '点底部 <b>分享</b> → <b>添加到主屏幕</b>'],
    other: ['浏览器菜单里找 <b>添加到主屏幕</b> / <b>安装应用</b>']
  };

  function browserKind() {
    var ua = navigator.userAgent || '';
    if (/MicroMessenger/i.test(ua)) return 'wechat';
    if (/EdgA?\//i.test(ua)) return 'edge';
    if (/HuaweiBrowser|HarmonyOS/i.test(ua)) return 'huawei';
    if (/MiuiBrowser/i.test(ua)) return 'miui';
    if (/Quark/i.test(ua)) return 'quark';
    if (/SamsungBrowser/i.test(ua)) return 'samsung';
    if (/OPR\//i.test(ua)) return 'opera';
    if (/Firefox\//i.test(ua)) return 'firefox';
    if (/iPhone|iPad|iPod/i.test(ua)) return 'ios';
    if (/Chrome\//i.test(ua)) return 'chrome';
    return 'other';
  }

  function isStandalone() {
    return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ||
      window.navigator.standalone === true;
  }

  function renderInstallCard() {
    var state = $('#installState');
    var hint = $('#installHint');
    var stepsEl = $('#installSteps');
    var btn = $('#installBtn');
    if (!state || !hint || !stepsEl || !btn) return;

    if (isStandalone()) {
      state.textContent = '已安装';
      hint.textContent = '你现在就是装好的状态：独立窗口、没有地址栏。';
      stepsEl.hidden = true;
      btn.hidden = true;
      return;
    }

    if (deferredPrompt) {
      state.textContent = '可安装';
      hint.textContent = '这台浏览器支持直接安装，点下面的按钮。';
      stepsEl.hidden = true;
      btn.hidden = false;
      return;
    }

    var kind = browserKind();
    var steps = INSTALL_STEPS[kind] || INSTALL_STEPS.other;
    state.textContent = '手动添加';
    hint.textContent = '当前浏览器没有给出安装入口，按下面的步骤加：';
    stepsEl.innerHTML = steps.map(function (s) { return '<li>' + s + '</li>'; }).join('') +
      '<li class="steps-tip">桌面还是没出现？长按桌面空白看看是不是被收进「全部应用」了；或在别的浏览器里打开这个链接再试一次。</li>';
    stepsEl.hidden = false;
    btn.hidden = true;
  }

  function copyUrl() {
    var url = location.href.split('#')[0].split('?')[0];
    var done = function () { toast('链接已复制，粘到别的浏览器里打开'); };
    var fail = function () {
      window.prompt('手动复制这个链接：', url);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(done).catch(fail);
    } else {
      fail();
    }
  }

  function bindInstall() {
    window.addEventListener('beforeinstallprompt', function (e) {
      e.preventDefault();
      deferredPrompt = e;
      renderInstallCard();
    });
    window.addEventListener('appinstalled', function () {
      deferredPrompt = null;
      renderInstallCard();
      toast('装好了，回桌面看看');
    });
    $('#copyUrlBtn').addEventListener('click', copyUrl);
    var upd = $('#updateBtn');
    if (upd) upd.addEventListener('click', checkUpdate);
    renderInstallCard();
  }

  function doInstall() {
    if (!deferredPrompt) { toast('用浏览器菜单「添加到主屏幕」即可'); return; }
    deferredPrompt.prompt();
    deferredPrompt.userChoice.then(function (choice) {
      if (choice && choice.outcome === 'accepted') toast('正在安装…');
      deferredPrompt = null;
    });
  }

  function registerSW() {
    if (!('serviceWorker' in navigator)) return;
    if (location.protocol !== 'http:' && location.protocol !== 'https:') return;

    var hadController = !!navigator.serviceWorker.controller;

    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' })
      .then(function (reg) {
        // 每次打开都问一次有没有新版，别等浏览器自己想起来
        reg.update().catch(function () {});
      })
      .catch(function (err) { console.warn('SW 注册失败', err); });

    navigator.serviceWorker.addEventListener('controllerchange', function () {
      if (!hadController) { hadController = true; return; }
      toastAction('已经更新到新版本', '刷新', function () { location.reload(); });
    });
  }

  /* 手动检查更新：拉一次 SW，再重载（导航走 no-store，拿到的就是最新的） */
  function checkUpdate() {
    var btn = $('#updateBtn');
    if (btn) btn.disabled = true;
    toast('检查更新中…');
    var work = Promise.resolve();
    if ('serviceWorker' in navigator) {
      work = navigator.serviceWorker.getRegistration()
        .then(function (reg) { return reg ? reg.update() : null; })
        .catch(function () {});
    }
    work.then(function () {
      setTimeout(function () { location.reload(); }, 350);
    });
  }

  /* ================= 前后台 ================= */

  function onVisibility() {
    if (document.visibilityState === 'hidden') {
      if (openEvent) {
        openEvent.leftCount = (openEvent.leftCount || 0) + 1;
        openEvent.leftAt = Date.now();
        TimeDB.putEvent(Object.assign({}, openEvent)).catch(function () {});
      }
      return;
    }
    onVisible();
  }

  var lastLeaveToast = 0;

  function onVisible() {
    // 回前台：以时间戳为准重算，顺便同步别的标签页写入的数据
    if (!openEvent) { refresh(); return; }
    refresh().then(function () {
      if (openEvent && openEvent.leftCount > 0 && Date.now() - lastLeaveToast > 45000) {
        lastLeaveToast = Date.now();
        toast('离开过 ' + openEvent.leftCount + ' 次，计时没停（' + fmtMin(durationOf(openEvent)) + '）');
      }
    });
  }

  /* ================= 公共小件 ================= */

  function openSheet(el) {
    if (!el) return;
    hideToast();
    el.hidden = false;
    requestAnimationFrame(function () {
      requestAnimationFrame(function () { el.classList.add('is-open'); });
    });
  }

  function closeSheet(el) {
    if (!el) return;
    el.classList.remove('is-open');
    setTimeout(function () { el.hidden = true; }, 240);
  }

  var toastTimer = null;

  function toastAction(msg, label, fn) {
    var el = $('#toast');
    if (!el) return;
    clearTimeout(toastTimer);
    el.innerHTML = '<span>' + esc(msg) + '</span><button class="toast-act" type="button">' + esc(label) + '</button>';
    el.classList.add('is-action');
    el.hidden = false;
    requestAnimationFrame(function () { el.classList.add('is-show'); });
    el.onclick = function (e) {
      if (e.target.closest('.toast-act')) {
        el.classList.remove('is-show');
        el.hidden = true;
        el.onclick = null;
        fn();
      }
    };
    toastTimer = setTimeout(hideToast, 8000);
  }

  function hideToast() {
    var el = $('#toast');
    if (!el) return;
    clearTimeout(toastTimer);
    el.classList.remove('is-show');
    setTimeout(function () { el.hidden = true; }, 240);
  }

  function toast(msg) {
    var el = $('#toast');
    if (!el) return;
    el.onclick = null;
    el.classList.remove('is-action');
    el.textContent = msg;
    el.hidden = false;
    requestAnimationFrame(function () { el.classList.add('is-show'); });
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      el.classList.remove('is-show');
      setTimeout(function () { el.hidden = true; }, 240);
    }, 2800);
  }

  /* ================= 启动 ================= */

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // 便于排查的只读入口
  window.__timelog = {
    get openEvent() { return openEvent; },
    get settings() { return settings; },
    get events() { return allEvents; },
    refresh: refresh
  };
})();
