/*
  ══════════════════════════════════════════════════════
  net.js — Сетевой слой: авторизация Telegram,
           сохранение прогресса на сервер (MongoDB)

  СТРАТЕГИЯ СОХРАНЕНИЯ:
  ⚡ МГНОВЕННО (saveInstant):
       inventory, equipped, upg, skills, boss, pvp,
       potionLv, potionThreshold, floor, level, pixr,
       gram, bp, prem, marketUnlocked, ore, blessStones, runes
  📦 КАЖДЫЕ 10 СЕК (delta batch):
       hp, gold, xp, killCount, potions — только изменения
  🔚 ПРИ ЗАКРЫТИИ (flush):
       полный снапшот всех данных
  ══════════════════════════════════════════════════════
*/
(function () {
  'use strict';

  // ─── Константы ───────────────────────────────────────
  var API = (function () {
    var url = new URLSearchParams(window.location.search).get('api') ||
              window.ENV_API_URL ||
              'https://ghz-production.up.railway.app';
    return url.replace(/\/$/, '');
  })();

  var EQUIP_SLOTS = ['weapon', 'body', 'legs', 'gloves', 'belt', 'ring', 'boots', 'helmet'];

  // ─── Состояние синхронизации ─────────────────────────
  var TG_INIT    = '';
  var START_PARAM = '';

  var SYNC = {
    booted:          false,
    started:         false,
    online:          false,
    pushing:         false,
    serverConfirmed: false,
    batchTimer:      null,
    rlBackoffUntil:  0,
    // Последние сохранённые значения накопительных полей
    lastHp:        0,
    lastGold:      0,
    lastXp:        0,
    lastKillCount: 0,
    lastPotions:   0,
    lastLevel:     0,
    lastFloor:     0,
    lastPixr:      0,
  };

  // ─── Офлайн-статус ────────────────────────────────────
  var _connDown  = false;
  var _pingTimer = null;


  // ══════════════════════════════════════════════════════
  //  УТИЛИТЫ
  // ══════════════════════════════════════════════════════

  function num(v, d) { v = Number(v); return isFinite(v) ? v : d; }
  function clone(o)  { try { return JSON.parse(JSON.stringify(o)); } catch (e) { return Object.assign({}, o); } }

  function getTgId() {
    try {
      var u = window.Telegram && window.Telegram.WebApp &&
              window.Telegram.WebApp.initDataUnsafe &&
              window.Telegram.WebApp.initDataUnsafe.user;
      if (u && u.id) return String(u.id);
    } catch (e) {}
    return null;
  }


  // ══════════════════════════════════════════════════════
  //  ЭКРАН ЗАГРУЗКИ
  // ══════════════════════════════════════════════════════

  var LS_MIN_MS  = 800;
  var _lsShownAt = Date.now();

  function lsSetStatus(text, pct) {
    var el = document.getElementById('lsStatus');
    if (el) el.innerHTML = '<span class="ls-dots">' + text + '</span>';
    var bar = document.getElementById('lsBar');
    if (bar && pct != null) bar.style.width = pct + '%';
  }

  function lsHide() {
    var el = document.getElementById('loadingScreen');
    if (!el || el.classList.contains('fade-out')) return;
    el.style.pointerEvents = 'none';
    var delay = Math.max(0, LS_MIN_MS - (Date.now() - _lsShownAt));
    setTimeout(function () {
      lsSetStatus('Готово', 100);
      setTimeout(function () {
        el.classList.add('fade-out');
        setTimeout(function () {
          el.style.display = 'none';
          el.classList.add('hidden-done');
        }, 520);
      }, 300);
    }, delay);
  }

  function lsInitStars() {
    var wrap = document.getElementById('lsStars');
    if (!wrap) return;
    var html = '';
    for (var i = 0; i < 60; i++) {
      var x   = (Math.random() * 100).toFixed(1);
      var y   = (Math.random() * 100).toFixed(1);
      var dur = (1.5 + Math.random() * 2.5).toFixed(1);
      var del = (Math.random() * 3).toFixed(1);
      var op  = (0.1 + Math.random() * 0.4).toFixed(2);
      html += '<div class="ls-star" style="left:' + x + '%;top:' + y +
              '%;opacity:' + op + ';--dur:' + dur + 's;--delay:-' + del + 's;"></div>';
    }
    wrap.innerHTML = html;
  }

  // Показ ошибки на экране загрузки (игра остаётся заблокированной)
  function lsShowError(msg, retryFn) {
    var statusEl = document.getElementById('lsStatus');
    if (statusEl) {
      statusEl.innerHTML =
        '<span style="color:#e74c3c;font-size:13px;">❌ ' + (msg || 'Нет соединения с сервером') + '</span>' +
        '<br><span style="font-size:10px;color:#888;margin-top:4px;display:block;">Проверьте интернет и повторите</span>';
    }
    var barFill = document.getElementById('lsBar');
    if (barFill) {
      barFill.style.width = '100%';
      barFill.style.background = 'linear-gradient(90deg,#8B0000,#e74c3c)';
    }
    var barWrap = document.querySelector('.ls-bar-wrap');
    if (barWrap && !document.querySelector('.ls-retry-btn')) {
      var btn = document.createElement('button');
      btn.className  = 'ls-retry-btn';
      btn.textContent = '🔄 ПОВТОРИТЬ';
      btn.style.cssText = 'margin-top:16px;padding:10px 28px;background:#0d0d1a;border:2px solid #f5c542;border-radius:10px;color:#f5c542;font-size:13px;font-family:"Courier New",monospace;letter-spacing:1px;cursor:pointer;display:block;width:160px;margin-left:auto;margin-right:auto;box-shadow:0 0 12px rgba(245,197,66,0.25);';
      btn.onclick = retryFn || function () { location.reload(); };
      barWrap.parentNode.insertBefore(btn, barWrap.nextSibling);
    }
    // Экран остаётся поверх игры
    var ls = document.getElementById('loadingScreen');
    if (ls) {
      ls.style.display    = '';
      ls.style.pointerEvents = 'all';
      ls.classList.remove('fade-out', 'hidden-done');
    }
  }


  // ══════════════════════════════════════════════════════
  //  СЕРИАЛИЗАЦИЯ СОСТОЯНИЯ
  // ══════════════════════════════════════════════════════

  function serializeState() {
    var eq = {};
    EQUIP_SLOTS.forEach(function (slot) {
      var it = G.equipped && G.equipped[slot];
      eq[slot] = it ? it.id : null;
    });
    var inv = (G.inventory || []).map(function (it) {
      var c = clone(it); delete c._equipped; return c;
    });
    return {
      v:                   1,
      tgId:                getTgId(),
      charId:              (typeof G_CHAR !== 'undefined' && G_CHAR) ? G_CHAR.id : (G.charId || null),
      inventory:           inv,
      equipped:            eq,
      upg:                 clone(G.upg),
      skills:              clone(G.skills || {}),
      potionLv:            G.potionLv,
      potionThreshold:     G.potionThreshold,
      floor:               G.floor,
      level:               G.level,
      pixr:                G.pixr,
      gram:                G.gram,
      bp:                  clone(G.bp   || { active: false, claimed: [] }),
      prem:                clone(G.prem || { tier: null, expiresAt: 0 }),
      boss:                clone(G.boss || { floor: 1, lastFightTime: 0 }),
      marketUnlocked:      G.marketUnlocked || false,
      arenaRating:         G.arenaRating    || 1000,
      ore:                 Object.assign({ core:0, uore:0, rore:0, eore:0, lore:0 }, G.ore  || {}),
      blessStones:         G.blessStones    || 0,
      runes:               Object.assign({ crune:0, urune:0, rrune:0, erune:0, lrune:0 }, G.runes || {}),
      pvpAttempts:         G.pvpAttempts     || 0,
      pvpAttemptsDate:     G.pvpAttemptsDate || '',
      pvpRefreshes:        G.pvpRefreshes    || 0,
      pvpRefreshDate:      G.pvpRefreshDate  || '',
      hp:                  G.hp,
      gold:                G.gold,
      xp:                  G.xp,
      xpNeeded:            G.xpNeeded,
      killCount:           G.killCount,
      potions:             G.potions,
      invIdCounter:        (typeof _invIdCounter === 'number') ? _invIdCounter : 0,
      dailyTasks:          clone(G.dailyTasks          || { date: '', seconds: 0, claimed: [] }),
      specialTasksClaimed: clone(G.specialTasksClaimed || {}),
      invFilter:           G.invFilter || 'all',
      cp:                  (typeof calcCP === 'function') ? calcCP() : 0,
      updatedAt:           Date.now(),
    };
  }


  // ══════════════════════════════════════════════════════
  //  ПРИМЕНЕНИЕ СНАПШОТА С СЕРВЕРА
  // ══════════════════════════════════════════════════════

  function applySnapshot(s) {
    if (!s || typeof s !== 'object') return false;

    var currentTgId = getTgId();
    if (s.tgId && currentTgId && s.tgId !== currentTgId) {
      console.warn('⚠️ Игнорируем снапшот другого пользователя:', s.tgId);
      return false;
    }

    // Поддержка вложенных форматов { data: { ... } }
    var d = s.data || s;
    if (d.data && typeof d.data === 'object' && !Array.isArray(d.data)) d = d.data;

    // Персонаж
    if (d.charId && typeof CHARS !== 'undefined' && CHARS[d.charId]) {
      G_CHAR    = CHARS[d.charId];
      G.charId  = d.charId;
      if (typeof applyCharacterSprites === 'function') applyCharacterSprites(G_CHAR);
    }

    // Апгрейды и базовые характеристики
    G.upg = Object.assign({ atk:0, def:0, hp:0, spd:0, crit:0, dodge:0, atkSpd:0, critDmg:0 }, d.upg || {});
    if (G_CHAR && typeof UPG_DEFS !== 'undefined') {
      G.baseStats = Object.assign({}, G_CHAR.baseStats);
      UPG_DEFS.forEach(function (u) {
        var lv = G.upg[u.id] || 0;
        if (lv > 0) G.baseStats[u.stat] = parseFloat(((G.baseStats[u.stat] || 0) + u.bonus * lv).toFixed(4));
      });
      var lvBonus = num(d.level, 1) - 1;
      if (lvBonus > 0) {
        G.baseStats.atk    = (G.baseStats.atk    || 0) + lvBonus * 2;
        G.baseStats.def    = (G.baseStats.def    || 0) + lvBonus * 1;
        G.baseStats.hp     = (G.baseStats.hp     || 0) + lvBonus * 10;
        G.baseStats.atkSpd = parseFloat(((G.baseStats.atkSpd || 1.0) + lvBonus * 0.02).toFixed(4));
      }
    } else if (d.baseStats) {
      G.baseStats = Object.assign({}, d.baseStats);
    }

    // Основные поля
    G.skills           = d.skills || {};
    G.potionLv         = num(d.potionLv, 0);
    G.potionThreshold  = num(d.potionThreshold, 30);
    G.floor            = num(d.floor,   G.floor);
    G.level            = num(d.level,   G.level);
    G.maxFloor         = num(d.maxFloor, G.maxFloor);
    G.pixr             = num(d.pixr,    G.pixr);
    G.gram             = num(d.gram,    G.gram);
    G.gold             = num(d.gold,    G.gold);
    G.xp               = num(d.xp,      G.xp);
    G.killCount        = num(d.killCount, G.killCount);
    G.potions          = num(d.potions,  G.potions);
    G.bp               = d.bp   || { active: false, claimed: [] };
    if (!G.bp.claimed)  G.bp.claimed = [];
    G.prem             = d.prem || { tier: null, expiresAt: 0 };
    G.boss             = d.boss || { floor: 1, lastFightTime: 0 };
    if (!G.boss.floor) G.boss.floor = 1;
    G.marketUnlocked   = d.marketUnlocked || false;
    G.arenaRating      = typeof d.arenaRating === 'number' ? d.arenaRating : 1000;
    G.ore              = Object.assign({ core:0, uore:0, rore:0, eore:0, lore:0 }, d.ore  || {});
    G.blessStones      = d.blessStones    || 0;
    G.runes            = Object.assign({ crune:0, urune:0, rrune:0, erune:0, lrune:0 }, d.runes || {});
    G.pvpAttempts      = d.pvpAttempts     || 0;
    G.pvpAttemptsDate  = d.pvpAttemptsDate || '';
    G.pvpRefreshes     = d.pvpRefreshes    || 0;
    G.pvpRefreshDate   = d.pvpRefreshDate  || '';
    G.invFilter        = d.invFilter || 'all';
    G.dailyTasks       = d.dailyTasks       || { date: '', seconds: 0, claimed: [] };
    G.specialTasksClaimed = d.specialTasksClaimed || {};

    // Инвентарь
    G.inventory = (d.inventory || []).map(function (it) {
      var c = clone(it); c._equipped = false; return c;
    });
    if (typeof d.invIdCounter === 'number') _invIdCounter = d.invIdCounter;
    G.inventory.forEach(function (i) {
      if (typeof i.id === 'number' && i.id > _invIdCounter) _invIdCounter = i.id;
    });

    // Надетые предметы
    G.equipped = { weapon:null, body:null, legs:null, gloves:null, belt:null, ring:null, boots:null, helmet:null };
    var eq = d.equipped || {};
    EQUIP_SLOTS.forEach(function (slot) {
      var id = eq[slot];
      if (id == null) return;
      var it = G.inventory.find(function (i) { return i.id === id; });
      if (it) { it._equipped = true; G.equipped[slot] = it; }
    });

    if (typeof recalcStats === 'function') recalcStats();

    // HP и XP
    G.maxHp    = num(d.maxHp, G.maxHp);
    G.xpNeeded = num(d.xpNeeded, 0);
    if (!G.xpNeeded || G.xpNeeded < 100) {
      var xpBase = 100;
      for (var lv = 1; lv < G.level; lv++) xpBase = Math.floor(xpBase * (lv < 7 ? 2.5 : 1.1));
      G.xpNeeded = xpBase;
    }
    var hp = num(d.hp, G.maxHp);
    if (hp <= 0) hp = Math.floor(G.maxHp * 0.3);
    G.hp = Math.max(1, Math.min(hp, G.maxHp));

    // Синхронизируем baseline для delta batch
    SYNC.lastHp        = G.hp;
    SYNC.lastGold      = G.gold;
    SYNC.lastXp        = G.xp;
    SYNC.lastKillCount = G.killCount;
    SYNC.lastPotions   = G.potions;
    SYNC.lastLevel     = G.level;
    SYNC.lastFloor     = G.floor;
    SYNC.lastPixr      = G.pixr || 0;

    return true;
  }


  // ══════════════════════════════════════════════════════
  //  ОФЛАЙН — БЛОКИРОВКА ИГРЫ
  // ══════════════════════════════════════════════════════

  function showConnOverlay() {
    var el = document.getElementById('connOverlay');
    if (el) el.classList.remove('hidden');
  }

  function hideConnOverlay() {
    var el = document.getElementById('connOverlay');
    if (el) el.classList.add('hidden');
  }

  function onConnLost() {
    if (_connDown) return;
    _connDown = true;
    console.warn('📵 [conn] Соединение потеряно');
    if (typeof window.gameActive !== 'undefined') window.gameActive = false;
    showConnOverlay();
    schedulePing();
  }

  function onConnRestored() {
    if (!_connDown) return;
    _connDown = false;
    console.log('✅ [conn] Соединение восстановлено');
    if (_pingTimer) { clearTimeout(_pingTimer); _pingTimer = null; }
    hideConnOverlay();
    if (SYNC.started) {
      if (typeof window.gameActive !== 'undefined') window.gameActive = true;
      if (typeof startGame === 'function' && !window._loopRunning) startGame();
    }
    // Сохраняем текущее состояние после восстановления
    if (SYNC.started && SYNC.serverConfirmed) postSave(serializeState());
  }

  function schedulePing() {
    if (_pingTimer) return;
    _pingTimer = setTimeout(function () { _pingTimer = null; doPing(); }, 5000);
  }

  function doPing() {
    fetch(API + '/api/ping', { method: 'GET' })
      .then(function (r) { r.ok ? onConnRestored() : schedulePing(); })
      .catch(schedulePing);
  }


  // ══════════════════════════════════════════════════════
  //  СЕРВЕРНЫЕ ЗАПРОСЫ
  // ══════════════════════════════════════════════════════

  // Загрузка данных при старте
  function serverLoad() {
    if (!SYNC.online) return Promise.resolve(null);
    var timeout = new Promise(function (_, reject) { setTimeout(function () { reject(new Error('timeout')); }, 10000); });
    var request = fetch(API + '/api/load', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ initData: TG_INIT, startParam: START_PARAM }),
    }).then(function (r) {
      var ct = r.headers.get('content-type') || '';
      if (!ct.includes('application/json')) return { ok: false };
      return r.json();
    });
    return Promise.race([request, timeout]).catch(function (e) { throw e; });
  }

  // Базовый POST на /api/save
  function postSave(data, keepalive) {
    return fetch(API + '/api/save', {
      method:    'POST',
      headers:   { 'Content-Type': 'application/json' },
      body:      JSON.stringify({ initData: TG_INIT, data: data }),
      keepalive: !!keepalive,
    })
    .then(function (r) { return r.json(); })
    .then(function (r) {
      if (r && r.ok) {
        onConnRestored();
        if (r.updatedAt) _syncBatchBaseline();
      } else if (r && r.error === 'reset_detected') {
        forceCloseApp();
      }
      return r;
    })
    .catch(function (e) { onConnLost(); throw e; });
  }

  // Синхронизируем baseline чтобы batch не дублировал уже сохранённое
  function _syncBatchBaseline() {
    SYNC.lastHp        = G.hp;
    SYNC.lastGold      = G.gold;
    SYNC.lastXp        = G.xp;
    SYNC.lastKillCount = G.killCount;
    SYNC.lastPotions   = G.potions;
    SYNC.lastLevel     = G.level;
    SYNC.lastFloor     = G.floor;
    SYNC.lastPixr      = G.pixr;
  }


  // ══════════════════════════════════════════════════════
  //  МГНОВЕННОЕ СОХРАНЕНИЕ (важные действия)
  //  Инвентарь, экипировка, апгрейды, этаж, уровень…
  // ══════════════════════════════════════════════════════

  var _instantPending = {};
  var _instantTimer   = null;

  function saveInstant(data) {
    if (!SYNC.started || !SYNC.online || !SYNC.serverConfirmed) return;
    Object.assign(_instantPending, data);
    clearTimeout(_instantTimer);
    _instantTimer = setTimeout(_flushInstant, 300);
  }

  function _flushInstant() {
    if (!SYNC.online || !SYNC.serverConfirmed) return;
    var d = _instantPending;
    _instantPending = {};
    var snap = serializeState();
    // Перекрываем полным снапшотом + переданные данные
    Object.keys(d).forEach(function (k) { snap[k] = d[k]; });
    snap.updatedAt = Date.now();
    postSave(snap).then(function (r) {
      if (r && r.ok) _syncBatchBaseline();
    }).catch(function () {});
  }


  // ══════════════════════════════════════════════════════
  //  BATCH DELTA — КАЖДЫЕ 10 СЕК
  //  Только накопительные поля: hp, gold, xp, kills, potions
  // ══════════════════════════════════════════════════════

  function serverSaveBatch() {
    if (!SYNC.online || !SYNC.serverConfirmed || SYNC.pushing) return;
    if (SYNC.rlBackoffUntil && Date.now() < SYNC.rlBackoffUntil) return;

    var snap = {
      hp:        G.hp,
      gold:      G.gold,
      xp:        G.xp,
      killCount: G.killCount,
      potions:   G.potions,
      level:     G.level,
      floor:     G.floor,
      pixr:      G.pixr,
    };

    // Шлём только если что-то изменилось
    var delta = {
      tgId:      getTgId(),
      charId:    (typeof G_CHAR !== 'undefined' && G_CHAR) ? G_CHAR.id : (G.charId || null),
      updatedAt: Date.now(),
      cp:        (typeof calcCP === 'function') ? calcCP() : 0,
    };
    var changed = false;
    if (snap.hp        !== SYNC.lastHp)        { delta.hp        = snap.hp;        changed = true; }
    if (snap.gold      !== SYNC.lastGold)      { delta.gold      = snap.gold;      changed = true; }
    if (snap.xp        !== SYNC.lastXp)        { delta.xp        = snap.xp;        changed = true; }
    if (snap.killCount !== SYNC.lastKillCount) { delta.killCount = snap.killCount; changed = true; }
    if (snap.potions   !== SYNC.lastPotions)   { delta.potions   = snap.potions;   changed = true; }
    if (snap.level     !== SYNC.lastLevel)     { delta.level     = snap.level;     delta.xpNeeded = G.xpNeeded; changed = true; }
    if (snap.floor     !== SYNC.lastFloor)     { delta.floor     = snap.floor;     delta.maxFloor = G.maxFloor; changed = true; }
    if (snap.pixr      !== SYNC.lastPixr)      { delta.pixr      = snap.pixr;      changed = true; }
    if (!changed) return;

    SYNC.pushing = true;

    fetch(API + '/api/save/delta', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ initData: TG_INIT, delta: delta }),
    })
    .then(function (r) { return r.json(); })
    .then(function (r) {
      SYNC.pushing = false;
      if (!r || !r.ok) {
        if (r && r.error === 'reset_detected') forceCloseApp();
        if (r && r.error === 'rate_limit') SYNC.rlBackoffUntil = Date.now() + 6000;
        return;
      }
      onConnRestored();
      SYNC.lastHp        = snap.hp;
      SYNC.lastGold      = snap.gold;
      SYNC.lastXp        = snap.xp;
      SYNC.lastKillCount = snap.killCount;
      SYNC.lastPotions   = snap.potions;
      SYNC.lastLevel     = snap.level;
      SYNC.lastFloor     = snap.floor;
      SYNC.lastPixr      = snap.pixr;
      SYNC.rlBackoffUntil = 0;

      // Серверный sync — применяем данные от сервера (admin изменения)
      if (r.sync) {
        if (r.sync.gram      !== undefined) G.gram = r.sync.gram;
        if (r.sync.gold      !== undefined) { G.gold = r.sync.gold; SYNC.lastGold = G.gold; }
        if (r.sync.pixr      !== undefined) { G.pixr = r.sync.pixr; SYNC.lastPixr = G.pixr; }
        if (r.sync.inventory !== undefined) {
          G.inventory = r.sync.inventory;
          if (typeof renderInventory === 'function') renderInventory();
        }
        if (typeof updateHUD      === 'function') updateHUD();
        if (typeof renderWallet   === 'function') renderWallet();
      }
    })
    .catch(function () { SYNC.pushing = false; onConnLost(); });
  }


  // ══════════════════════════════════════════════════════
  //  FLUSH — ПОЛНОЕ СОХРАНЕНИЕ ПРИ ЗАКРЫТИИ
  // ══════════════════════════════════════════════════════

  function flush() {
    if (!SYNC.started || !SYNC.online || !SYNC.serverConfirmed) return;
    var snap = serializeState();
    snap.updatedAt = Date.now();
    try {
      fetch(API + '/api/save', {
        method:    'POST',
        headers:   { 'Content-Type': 'application/json' },
        body:      JSON.stringify({ initData: TG_INIT, data: snap }),
        keepalive: true,   // keepalive позволяет запросу завершиться после закрытия страницы
      });
    } catch (e) {}
  }


  // ══════════════════════════════════════════════════════
  //  ПОЛЛИНГ — СЕРВЕРНЫЕ УВЕДОМЛЕНИЯ (каждые 9 сек)
  // ══════════════════════════════════════════════════════

  var _pollTimer  = null;
  var _isPolling  = false;
  var _lastEventId = 0;

  function startPolling() {
    if (!SYNC.started || !SYNC.online) return;
    if (_pollTimer) { clearTimeout(_pollTimer); _pollTimer = null; }
    doPoll();
  }

  function stopPolling() {
    if (_pollTimer) { clearTimeout(_pollTimer); _pollTimer = null; }
    _isPolling = false;
  }

  function doPoll() {
    if (!SYNC.started || !SYNC.online || _isPolling) return;
    var tgId = getTgId();
    if (!tgId) { _pollTimer = setTimeout(doPoll, 9000); return; }

    _isPolling = true;
    fetch(API + '/api/poll', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ initData: TG_INIT, lastEventId: _lastEventId }),
    })
    .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then(function (response) {
      _isPolling  = false;
      _lastEventId = response.timestamp || Date.now();

      (response.notifications || []).forEach(function (n) {
        if (n.event === 'force_close') {
          forceCloseApp();
        } else if (n.event === 'reload') {
          window.forceReload ? window.forceReload().then(function (ok) {
            if (ok) { if (typeof renderWallet === 'function') renderWallet(); if (typeof updateHUD === 'function') updateHUD(); }
          }) : location.reload();
        } else if (n.event === 'market_sold' || n.event === 'market_expired') {
          if (typeof window._handleMarketNotif === 'function') window._handleMarketNotif(n.event, n.data || {});
        }
      });

      if (SYNC.started && SYNC.online) _pollTimer = setTimeout(doPoll, 9000);
    })
    .catch(function () {
      _isPolling = false;
      if (SYNC.started && SYNC.online) _pollTimer = setTimeout(doPoll, 9000);
    });
  }


  // ══════════════════════════════════════════════════════
  //  ПРИНУДИТЕЛЬНОЕ ЗАКРЫТИЕ (команда от сервера / admin)
  // ══════════════════════════════════════════════════════

  function forceCloseApp() {
    console.warn('🚪 [forceClose] Закрываем приложение по команде сервера');
    SYNC.serverConfirmed = false;
    SYNC.started         = false;
    if (typeof window.gameActive     !== 'undefined') window.gameActive     = false;
    if (typeof window._loopRunning   !== 'undefined') window._loopRunning   = false;
    try {
      if (window.Telegram && window.Telegram.WebApp && typeof window.Telegram.WebApp.close === 'function') {
        window.Telegram.WebApp.close(); return;
      }
    } catch (e) {}
    // Фолбэк — показываем экран
    var ls = document.getElementById('loadingScreen');
    if (ls) {
      ls.style.display = ''; ls.style.pointerEvents = 'all';
      ls.classList.remove('fade-out', 'hidden-done');
      var st = document.getElementById('lsStatus');
      if (st) st.innerHTML =
        '<span style="color:#f5c542;font-size:13px;">⚠️ Прогресс был сброшен администратором</span>' +
        '<br><span style="font-size:11px;color:#888;margin-top:6px;display:block;">Перезапустите игру</span>';
      var bar = document.getElementById('lsBar');
      if (bar) bar.style.width = '0%';
    }
  }

  // Перезагрузка данных с сервера (без перезапуска страницы)
  window.forceReload = function () {
    return serverLoad().then(function (r) {
      if (r && r.ok && r.save && r.save.data) {
        applySnapshot(r.save.data);
        if (typeof updateHUD          === 'function') updateHUD();
        if (typeof renderInventory    === 'function') renderInventory();
        if (typeof renderWallet       === 'function') renderWallet();
        if (typeof updatePotionHud    === 'function') updatePotionHud();
        if (typeof switchTab          === 'function') switchTab(activeTab);
        return true;
      }
      return false;
    }).catch(function () { return false; });
  };


  // ══════════════════════════════════════════════════════
  //  ВЫБОР ПЕРСОНАЖА
  // ══════════════════════════════════════════════════════

  function stopCharSelectAnims() {
    try { if (typeof _csSpriteTimers !== 'undefined') Object.keys(_csSpriteTimers).forEach(function (k) { clearInterval(_csSpriteTimers[k]); }); } catch (e) {}
    try { if (typeof _csParticleTimer !== 'undefined' && _csParticleTimer) cancelAnimationFrame(_csParticleTimer); } catch (e) {}
  }

  function hideCharSelect() {
    var cs = document.getElementById('charSelect');
    if (cs) cs.classList.add('hidden');
    stopCharSelectAnims();
  }

  // Хук на подтверждение выбора персонажа
  function hookCharSelect() {
    var orig = window.confirmChar;
    if (typeof orig !== 'function') return;
    window.confirmChar = function () {
      var r = orig.apply(this, arguments);
      if (typeof G_CHAR === 'undefined' || !G_CHAR) return r;
      G.charId = G_CHAR.id;
      SYNC.started         = true;
      SYNC.serverConfirmed = true;
      stopCharSelectAnims();
      if (SYNC.online) {
        fetch(API + '/api/character', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ initData: TG_INIT, charId: G.charId }),
        }).catch(function () {});
        saveInstant({ charId: G.charId });
      }
      return r;
    };
  }


  // ══════════════════════════════════════════════════════
  //  ЗАПУСК ИГРЫ ИЗ СНАПШОТА
  // ══════════════════════════════════════════════════════

  function bootFromSnapshot(snap) {
    if (SYNC.started) return;
    var d = snap.data || snap;
    if (d.data && typeof d.data === 'object' && !Array.isArray(d.data)) d = d.data;
    if (!applySnapshot(d)) return;
    hideCharSelect();
    SYNC.started = true;
    if (typeof startGame === 'function') {
      if (!window._loopRunning) startGame();
      else {
        if (typeof updateHUD      === 'function') updateHUD();
        if (typeof initSkillsHud  === 'function') initSkillsHud();
        if (typeof updatePotionHud === 'function') updatePotionHud();
      }
    }
    setTimeout(startPolling, 2000);
  }

  function hotApply(snap) {
    if (!applySnapshot(snap)) return;
    if (typeof updateHUD       === 'function') updateHUD();
    if (typeof initSkillsHud   === 'function') initSkillsHud();
    if (typeof updatePotionHud === 'function') updatePotionHud();
    try { if (typeof switchTab === 'function') switchTab(activeTab); } catch (e) {}
  }


  // ══════════════════════════════════════════════════════
  //  СБРОС К ЭКРАНУ ВЫБОРА ПЕРСОНАЖА
  // ══════════════════════════════════════════════════════

  function resetToCharSelect() {
    if (typeof window.gameActive !== 'undefined') window.gameActive = false;
    if (typeof window.G_CHAR    !== 'undefined') window.G_CHAR    = null;
    stopPolling();
    try {
      Object.assign(G, {
        charId: null, gold: 0, pixr: 0, gram: 0,
        level: 1, xp: 0, floor: 1, maxFloor: 1, killCount: 0,
        inventory: [], equipped: {},
        upg: { atk:0, def:0, hp:0, spd:0, crit:0, dodge:0, atkSpd:0, critDmg:0 },
        bp: { active: false, claimed: [] }, prem: { tier: null, expiresAt: 0 },
        skills: {}, potions: 0, potionLv: 0,
        dailyTasks: { date: '', seconds: 0, claimed: [] }, specialTasksClaimed: {},
        ore: { core:0, uore:0, rore:0, eore:0, lore:0 },
        runes: { crune:0, urune:0, rrune:0, erune:0, lrune:0 },
        blessStones: 0, arenaRating: 1000,
        pvpAttempts: 0, pvpAttemptsDate: '', pvpRefreshes: 0, pvpRefreshDate: '',
        boss: { floor: 1, lastFightTime: 0 }, marketUnlocked: false,
      });
    } catch (e) {}
    if (typeof window._invIdCounter !== 'undefined') window._invIdCounter = 0;
    var cs = document.getElementById('charSelect');
    if (cs) cs.classList.remove('hidden');
    var canvas = document.getElementById('gameCanvas');
    if (canvas) canvas.style.display = 'none';
    var skillsHud = document.getElementById('skillsHud');
    if (skillsHud) skillsHud.classList.remove('visible');
  }


  // ══════════════════════════════════════════════════════
  //  ИНИЦИАЛИЗАЦИЯ TELEGRAM
  // ══════════════════════════════════════════════════════

  function initTelegram() {
    if (window.Telegram && window.Telegram.WebApp) {
      try { window.Telegram.WebApp.ready(); }   catch (e) {}
      try { window.Telegram.WebApp.expand(); }  catch (e) {}
      try { window.Telegram.WebApp.disableVerticalSwipes && window.Telegram.WebApp.disableVerticalSwipes(); } catch (e) {}
      TG_INIT = window.Telegram.WebApp.initData || '';
      try { START_PARAM = (window.Telegram.WebApp.initDataUnsafe && window.Telegram.WebApp.initDataUnsafe.start_param) || ''; } catch (e) {}
    }
    // Параметр реферала из URL как запасной вариант
    if (!START_PARAM) {
      try {
        var p = new URLSearchParams(window.location.search);
        START_PARAM = p.get('start') || p.get('startapp') || p.get('ref') || '';
      } catch (e) {}
    }
    SYNC.online = !!(window.Telegram && window.Telegram.WebApp && TG_INIT);
    console.log('🟢 [initTelegram] tgId:', getTgId(), '| online:', SYNC.online, '| startParam:', START_PARAM || 'none');
  }


  // ══════════════════════════════════════════════════════
  //  BOOT
  // ══════════════════════════════════════════════════════

  function boot() {
    lsInitStars();
    lsSetStatus('Подключение', 10);
    initTelegram();

    // Не в Telegram — блокируем
    if (!SYNC.online) {
      lsSetStatus('', 100);
      var statusEl = document.getElementById('lsStatus');
      if (statusEl) statusEl.innerHTML =
        '<span style="color:#4a8aff;font-size:13px;">📱 Открой игру в Telegram</span>' +
        '<br><span style="font-size:10px;color:#888;margin-top:4px;display:block;">Игра работает только через Telegram</span>';
      var barFill = document.getElementById('lsBar');
      if (barFill) {
        barFill.style.width = '100%';
        barFill.style.background = 'linear-gradient(90deg,#1a3a6a,#2a6aaa)';
      }
      var barWrap = document.querySelector('.ls-bar-wrap');
      if (barWrap && !document.querySelector('.ls-telegram-btn')) {
        var tgBtn = document.createElement('button');
        tgBtn.className  = 'ls-telegram-btn';
        tgBtn.innerHTML  = '📱 ОТКРЫТЬ В TELEGRAM';
        tgBtn.style.cssText = 'margin-top:16px;padding:10px 24px;background:linear-gradient(90deg,#1a3a6a,#2a6aaa);border:2px solid #4a8aff;border-radius:10px;color:#fff;font-size:13px;font-weight:bold;cursor:pointer;font-family:"Courier New",monospace;letter-spacing:1px;display:block;margin-left:auto;margin-right:auto;box-shadow:0 0 12px rgba(74,138,255,0.3);';
        tgBtn.onclick = function () {
          window.open('https://t.me/' + (window.BOT_USERNAME || 'pixel_rpg_bot') + (START_PARAM ? '?start=' + START_PARAM : ''), '_blank');
        };
        barWrap.parentNode.insertBefore(tgBtn, barWrap.nextSibling);
      }
      return;
    }

    // Анимация прогресса загрузки
    lsSetStatus('Загрузка с сервера', 30);
    var _pct = 30;
    var _progressTimer = setInterval(function () {
      if (_pct < 85) { _pct++; lsSetStatus('Загрузка с сервера', _pct); }
    }, 300);
    function stopProgress() { clearInterval(_progressTimer); }

    function finalize() {
      SYNC.batchTimer = setInterval(serverSaveBatch, 10000);
      // Сохранение при скрытии вкладки и закрытии
      document.addEventListener('visibilitychange', function () { if (document.hidden) flush(); });
      window.addEventListener('pagehide',      flush);
      window.addEventListener('beforeunload',  flush);
      try { if (window.Telegram && window.Telegram.WebApp) window.Telegram.WebApp.onEvent('close', flush); } catch (e) {}
      // Обработка потери/восстановления сети
      window.addEventListener('online',  function () { if (_connDown) setTimeout(doPing, 1000); });
      window.addEventListener('offline', onConnLost);
      SYNC.booted = true;
      lsHide();
    }

    serverLoad().then(function (r) {
      stopProgress();
      if (!r || !r.ok) { lsShowError(); return; }

      var server     = r.save;
      var currentId  = getTgId();
      if (server && server.data && server.data.tgId && currentId && server.data.tgId !== currentId) {
        lsShowError('Ошибка идентификации. Повторите попытку.'); return;
      }

      if (server && server.data && server.data.charId &&
          typeof CHARS !== 'undefined' && CHARS[server.data.charId]) {
        // Игрок с персонажем — запускаем игру
        SYNC.serverConfirmed = true;
        lsSetStatus('Применение данных', 90);
        if (!SYNC.started) bootFromSnapshot(server.data);
        else               hotApply(server.data);
        setTimeout(finalize, 300);
      } else {
        // Новый игрок или персонаж не найден — показываем выбор
        finalize();
      }
    }).catch(function () {
      stopProgress();
      lsShowError();
    });
  }


  // ══════════════════════════════════════════════════════
  //  ЭКСПОРТ — события из game.js
  // ══════════════════════════════════════════════════════

  // Вызывается из game.js при получении уровня
  window.onLevelUp = function () {
    saveInstant({ level: G.level, xpNeeded: G.xpNeeded });
  };

  // Вызывается из game.js при открытии нового этажа
  window.onFloorChange = function () {
    saveInstant({ floor: G.floor, maxFloor: G.maxFloor });
  };


  // ══════════════════════════════════════════════════════
  //  ЗАПУСК
  // ══════════════════════════════════════════════════════

  hookCharSelect();

  if (document.readyState === 'complete') boot();
  else window.addEventListener('load', boot);


  // ══════════════════════════════════════════════════════
  //  ПУБЛИЧНЫЙ API
  // ══════════════════════════════════════════════════════

  window.GameSync = {
    saveInstant:    saveInstant,
    flush:          flush,
    serialize:      serializeState,
    apply:          applySnapshot,
    state:          SYNC,
    getTgId:        getTgId,
    resetToCharSelect: resetToCharSelect,
    _API:           API,
    get _INIT()     { return TG_INIT; },
  };

})();
