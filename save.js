/*
  ══════════════════════════════════════════════════════
  save.js — Система сохранений + экран загрузки
  Telegram Mini App авторизация (HMAC через initData)
  Локальное сохранение (localStorage) + сервер Railway
  API: https://ghz-production.up.railway.app/
  ══════════════════════════════════════════════════════
  Подключать ПОСЛЕДНИМ скриптом (после ui.js).
*/

var SaveSystem = (function() {
  'use strict';

  var API                 = 'https://ghz-production.up.railway.app';
  var LS_KEY              = 'pixelrpg_save_v1';
  var AUTO_INTERVAL       = 60;   // авто-сейв каждые N сек
  var MIN_SERVER_INTERVAL = 15;   // throttle

  var _initData       = '';
  var _tgUser         = null;
  var _lastServerSave = 0;
  var _dirty          = false;
  var _autoTimer      = null;
  var _initialized    = false;
  var _charId         = 'fire';

  // ── ЭКРАН ЗАГРУЗКИ ──────────────────────────────────
  var _lsFrameTimer = null;

  function _lsSetStatus(text) {
    var el = document.getElementById('lsStatus');
    if (el) el.textContent = text;
  }
  function _lsSetProgress(pct) {
    var el = document.getElementById('lsProgressFill');
    if (el) el.style.width = Math.min(100, pct) + '%';
  }

  function _lsStartSprite() {
    var canvas = document.getElementById('lsCanvas');
    if (!canvas) return;
    var ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    var img = new Image();
    img.src = 'IDLE.png';
    var frame = 0;
    _lsFrameTimer = setInterval(function() {
      if (!img.complete || img.naturalWidth === 0) return;
      ctx.clearRect(0, 0, 128, 128);
      ctx.drawImage(img, frame * 128, 0, 128, 128, 0, 0, 128, 128);
      frame = (frame + 1) % 7;
    }, 130);
  }

  function _lsStopSprite() {
    if (_lsFrameTimer) { clearInterval(_lsFrameTimer); _lsFrameTimer = null; }
  }

  function _lsStartParticles() {
    var container = document.getElementById('lsParticles');
    if (!container) return;
    var colors = ['#9b59b6','#f5c542','#3498db','#e74c3c','#2ecc71'];
    var sizes  = [3, 4, 4, 6];
    for (var i = 0; i < 18; i++) {
      var div = document.createElement('div');
      div.className = 'ls-particle';
      var sz  = sizes[Math.floor(Math.random() * sizes.length)];
      var col = colors[Math.floor(Math.random() * colors.length)];
      var dur = 4 + Math.random() * 5;
      var del = -(Math.random() * dur);
      div.style.cssText = 'width:' + sz + 'px;height:' + sz + 'px;left:' +
        (Math.random() * 100) + '%;background:' + col +
        ';animation-duration:' + dur.toFixed(1) + 's' +
        ';animation-delay:' + del.toFixed(1) + 's;opacity:0.7';
      container.appendChild(div);
    }
  }

  function _lsShowUser(user) {
    var nameEl   = document.getElementById('lsUserName');
    var avatarEl = document.getElementById('lsUserAvatar');
    if (!nameEl) return;
    if (user && user.first_name) {
      var name = user.first_name + (user.last_name ? ' ' + user.last_name : '');
      nameEl.textContent   = name;
      avatarEl.textContent = name.charAt(0).toUpperCase();
    } else {
      nameEl.textContent   = 'Гость';
      avatarEl.textContent = '?';
    }
  }

  function _lsHide(callback) {
    var el = document.getElementById('loadScreen');
    if (!el) { if (callback) callback(); return; }
    _lsSetProgress(100);
    setTimeout(function() {
      el.classList.add('fade-out');
      setTimeout(function() {
        el.classList.add('hidden');
        _lsStopSprite();
        if (callback) callback();
      }, 520);
    }, 300);
  }

  // ── TELEGRAM AUTH ────────────────────────────────────
  // Пробует получить initData, повторяет до maxTries раз
  function _getTgInitDataAsync(maxTries, callback) {
    var tries = 0;
    function attempt() {
      tries++;
      try {
        var tg = window.Telegram && window.Telegram.WebApp;
        if (tg && tg.initData && tg.initData.length > 0) {
          _tgUser = (tg.initDataUnsafe && tg.initDataUnsafe.user) || null;
          callback(tg.initData);
          return;
        }
      } catch (_) {}

      if (tries < maxTries) {
        setTimeout(attempt, 200);
      } else {
        // DEV fallback
        var devId = localStorage.getItem('pixelrpg_devid');
        if (!devId) {
          devId = 'dev_' + Math.random().toString(36).slice(2, 10);
          localStorage.setItem('pixelrpg_devid', devId);
        }
        _tgUser = { id: devId, first_name: 'Dev' };
        callback('dev:' + devId);
      }
    }
    attempt();
  }

  // ── BUILD / APPLY SAVE ───────────────────────────────
  function buildSave() {
    return {
      gold:      G.gold,       pixr:     G.pixr,
      gram:      G.gram,       level:    G.level,
      xp:        G.xp,         xpNeeded: G.xpNeeded,
      floor:     G.floor,      maxFloor: G.maxFloor,
      killCount: G.killCount,  cp:       calcCP(),
      hp:        G.hp,         maxHp:    G.maxHp,
      upg:       Object.assign({}, G.upg),
      potionLv:  G.potionLv,
      potions:   G.potions  || 0,
      potionThreshold: G.potionThreshold || 30,
      baseStats: Object.assign({}, G.baseStats),
      stats:     Object.assign({}, G.stats),
      charId:    _charId,
      inventory: (G.inventory || []).map(function(i) { return Object.assign({}, i); }),
      equipped:  Object.assign({}, G.equipped),
      owned:     Object.assign({}, G.owned),
      skills:    Object.assign({}, G.skills),
      bp:        { active: G.bp.active, claimed: (G.bp.claimed || []).slice() },
      prem:      Object.assign({}, G.prem),
      invFilter: G.invFilter || 'all',
    };
  }

  // applySave НЕ трогает спрайты и НЕ сбрасывает HP
  function applySave(d) {
    if (!d) return;
    var n = function(v, def) { return (v != null) ? v : def; };

    G.gold      = n(d.gold,      G.gold);
    G.pixr      = n(d.pixr,      G.pixr);
    G.gram      = n(d.gram,      G.gram);
    G.level     = n(d.level,     G.level);
    G.xp        = n(d.xp,        G.xp);
    G.xpNeeded  = n(d.xpNeeded,  G.xpNeeded);
    G.floor     = n(d.floor,     G.floor);
    G.maxFloor  = n(d.maxFloor,  G.maxFloor);
    G.killCount = n(d.killCount, G.killCount);

    // HP восстанавливаем из сейва — НЕ из baseStats персонажа
    G.maxHp = n(d.maxHp, G.maxHp);
    G.hp    = n(d.hp,    G.hp);
    // Гарантируем что hp не превышает maxHp и не отрицательное
    G.hp = Math.max(0, Math.min(G.hp, G.maxHp));

    if (d.upg       && typeof d.upg       === 'object') Object.assign(G.upg, d.upg);
    if (d.baseStats && typeof d.baseStats === 'object') Object.assign(G.baseStats, d.baseStats);
    if (d.stats     && typeof d.stats     === 'object') Object.assign(G.stats, d.stats);

    G.potionLv        = n(d.potionLv,        G.potionLv);
    G.potions         = n(d.potions,         G.potions);
    G.potionThreshold = n(d.potionThreshold, G.potionThreshold);

    if (Array.isArray(d.inventory)) G.inventory = d.inventory.slice();
    if (d.equipped && typeof d.equipped === 'object') Object.assign(G.equipped, d.equipped);
    if (d.owned    && typeof d.owned    === 'object') Object.assign(G.owned,    d.owned);
    if (d.skills   && typeof d.skills   === 'object') Object.assign(G.skills,  d.skills);

    if (d.bp) {
      G.bp.active  = !!d.bp.active;
      G.bp.claimed = Array.isArray(d.bp.claimed) ? d.bp.claimed.slice() : [];
    }
    if (d.prem)      Object.assign(G.prem, d.prem);
    if (d.invFilter) G.invFilter = d.invFilter;
    if (d.charId)    _charId = d.charId;
  }

  // ── LOCAL STORAGE ────────────────────────────────────
  function saveLocal() {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify({ data: buildSave(), ts: Date.now() }));
    } catch (e) { console.warn('[Save] localStorage write failed:', e); }
  }

  function loadLocal() {
    try {
      var raw = localStorage.getItem(LS_KEY);
      if (!raw) return null;
      var snap = JSON.parse(raw);
      return (snap && snap.data) ? snap : null;
    } catch (_) { return null; }
  }

  // ── SERVER SAVE (throttled) ──────────────────────────
  function saveServer() {
    var now = Date.now() / 1000;
    if (now - _lastServerSave < MIN_SERVER_INTERVAL) { _dirty = true; return; }
    _doServerSave();
  }

  function saveNow() { _doServerSave(); }

  function _doServerSave() {
    _lastServerSave = Date.now() / 1000;
    _dirty = false;
    saveLocal();
    if (!_initData) return;
    fetch(API + '/save', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'x-tg-init-data': _initData },
      body:    JSON.stringify({ saveData: buildSave() }),
      keepalive: true,
    })
    .then(function(r) { return r.json(); })
    .then(function(res) { if (!res.ok) console.warn('[Save] server:', res); })
    .catch(function(e) { console.warn('[Save] server save failed:', e.message); });
  }

  // ── LOAD ─────────────────────────────────────────────
  function _loadFromServer() {
    return fetch(API + '/save', {
      method:  'GET',
      headers: { 'x-tg-init-data': _initData },
    })
    .then(function(r) { return r.json(); })
    .then(function(res) {
      if (res.found && res.saveData) {
        applySave(res.saveData);
        saveLocal();
        return { source: 'server', data: res.saveData };
      }
      return _loadFromLocal();
    })
    .catch(function(e) {
      console.warn('[Save] server load failed:', e.message);
      return _loadFromLocal();
    });
  }

  function _loadFromLocal() {
    var snap = loadLocal();
    if (snap && snap.data) {
      applySave(snap.data);
      return { source: 'local', data: snap.data };
    }
    return { source: 'none', data: null };
  }

  // ── AUTO-SAVE + UNLOAD ───────────────────────────────
  function _startAutoSave() {
    if (_autoTimer) clearInterval(_autoTimer);
    _autoTimer = setInterval(function() {
      if (_dirty) saveServer(); else saveLocal();
    }, AUTO_INTERVAL * 1000);
  }

  function _bindUnload() {
    document.addEventListener('visibilitychange', function() {
      if (document.visibilityState === 'hidden') { saveLocal(); _doServerSave(); }
    });
    window.addEventListener('pagehide',     function() { saveLocal(); _doServerSave(); });
    window.addEventListener('beforeunload', function() { saveLocal(); });
  }

  function markDirty() { _dirty = true; saveLocal(); }

  // ── INIT ─────────────────────────────────────────────
  function init() {
    if (_initialized) return;
    _initialized = true;

    _lsStartSprite();
    _lsStartParticles();
    _lsSetStatus('Подключение к Telegram...');
    _lsSetProgress(10);

    // Ждём TG SDK — до 10 попыток по 200мс = 2 сек максимум
    _getTgInitDataAsync(10, function(initData) {
      _initData = initData;
      _lsShowUser(_tgUser);
      _lsSetProgress(30);

      // TG готов — вызываем ready/expand
      try {
        var tg = window.Telegram && window.Telegram.WebApp;
        if (tg) { tg.ready(); tg.expand(); }
      } catch (_) {}

      _lsSetStatus('Загрузка сохранения...');
      _lsSetProgress(50);

      _loadFromServer().then(function(result) {
        _lsSetProgress(85);

        var savedCharId = result.data && result.data.charId;
        var hasSave     = result.source !== 'none';

        _lsSetStatus(hasSave ? 'Сохранение загружено!' : 'Новая игра...');
        _lsSetProgress(95);

        _bindUnload();
        _startAutoSave();

        _lsHide(function() {
          if (hasSave && savedCharId && window.CHARS && CHARS[savedCharId]) {
            // ПОРЯДОК ВАЖЕН:
            // 1. applyCharacter с keepHp=true — только спрайты, HP не трогает
            // 2. applySave уже применён выше (в _loadFromServer/_loadFromLocal)
            //    => G.hp, G.maxHp, G.stats, G.baseStats уже из сейва
            // 3. recalcStats — пересчитать статы с экипировкой
            _charId = savedCharId;
            window.G_CHAR = CHARS[savedCharId];
            if (typeof applyCharacter === 'function') applyCharacter(G_CHAR, true);
            if (typeof recalcStats    === 'function') recalcStats();
            if (typeof startGame      === 'function') startGame();
          } else {
            // Новая игра — показываем выбор персонажа
            var cs = document.getElementById('charSelect');
            if (cs) cs.classList.remove('hidden');
            if (typeof initCharSelectSprites === 'function') initCharSelectSprites();
            if (typeof initCsParticles       === 'function') initCsParticles();
          }
        });
      });
    });
  }

  // ─────────────────────────────────────────────────────
  return {
    init:       init,
    saveLocal:  saveLocal,
    saveServer: saveServer,
    saveNow:    saveNow,
    markDirty:  markDirty,
    buildSave:  buildSave,
    getTgUser:  function() { return _tgUser; },
    getCharId:  function() { return _charId; },
    setCharId:  function(id) { _charId = id; },
  };
})();

// Запуск после полной загрузки страницы (TG SDK должен быть готов)
window.addEventListener('load', function() {
  SaveSystem.init();
});
