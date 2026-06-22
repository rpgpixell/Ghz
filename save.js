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

  var API                  = 'https://ghz-production.up.railway.app';
  var LS_KEY               = 'pixelrpg_save_v1';
  var AUTO_INTERVAL        = 60;   // авто-сейв на сервер каждые N сек
  var MIN_SERVER_INTERVAL  = 15;   // throttle: не чаще раза в 15 сек

  var _initData       = '';
  var _tgUser         = null;      // { id, first_name, username, ... }
  var _lastServerSave = 0;
  var _dirty          = false;
  var _autoTimer      = null;
  var _initialized    = false;
  var _charId         = 'fire';

  // ────────────────────────────────────────────────────
  //  ЭКРАН ЗАГРУЗКИ
  // ────────────────────────────────────────────────────
  var _lsCanvas      = null;
  var _lsCtx         = null;
  var _lsImg         = null;
  var _lsFrame       = 0;
  var _lsFrameTimer  = null;
  var _lsParticleRaf = null;

  function _lsSetStatus(text) {
    var el = document.getElementById('lsStatus');
    if (el) el.textContent = text;
  }

  function _lsSetProgress(pct) {
    var el = document.getElementById('lsProgressFill');
    if (el) el.style.width = Math.min(100, pct) + '%';
  }

  // Рисуем спрайт idle мага на канвасе загрузочного экрана
  function _lsStartSprite() {
    _lsCanvas = document.getElementById('lsCanvas');
    if (!_lsCanvas) return;
    _lsCtx = _lsCanvas.getContext('2d');
    _lsCtx.imageSmoothingEnabled = false;

    _lsImg = new Image();
    _lsImg.src = 'IDLE.png'; // fire idle по умолчанию
    _lsFrame = 0;

    _lsFrameTimer = setInterval(function() {
      if (!_lsCtx || !_lsImg || !_lsImg.complete || _lsImg.naturalWidth === 0) return;
      var fw = 128, fh = 128;
      _lsCtx.clearRect(0, 0, 128, 128);
      _lsCtx.drawImage(_lsImg, _lsFrame * fw, 0, fw, fh, 0, 0, 128, 128);
      _lsFrame = (_lsFrame + 1) % 7;
    }, 130);
  }

  function _lsStopSprite() {
    if (_lsFrameTimer) { clearInterval(_lsFrameTimer); _lsFrameTimer = null; }
  }

  // Пиксельные частицы фона
  function _lsStartParticles() {
    var container = document.getElementById('lsParticles');
    if (!container) return;

    var colors  = ['#9b59b6','#f5c542','#3498db','#e74c3c','#2ecc71'];
    var sizes   = [3, 4, 4, 6];
    var count   = 18;
    var els     = [];

    for (var i = 0; i < count; i++) {
      var div = document.createElement('div');
      div.className = 'ls-particle';
      var sz  = sizes[Math.floor(Math.random() * sizes.length)];
      var col = colors[Math.floor(Math.random() * colors.length)];
      var dur = 4 + Math.random() * 5;
      var del = -(Math.random() * dur);
      div.style.cssText = [
        'width:'  + sz + 'px',
        'height:' + sz + 'px',
        'left:'   + (Math.random() * 100) + '%',
        'background:' + col,
        'animation-duration:' + dur.toFixed(1) + 's',
        'animation-delay:'    + del.toFixed(1) + 's',
        'opacity:0.7',
      ].join(';');
      container.appendChild(div);
      els.push(div);
    }
    return els;
  }

  // Показать имя пользователя TG
  function _lsShowUser(user) {
    var nameEl   = document.getElementById('lsUserName');
    var avatarEl = document.getElementById('lsUserAvatar');
    if (!nameEl) return;

    if (user && user.first_name) {
      var name = user.first_name + (user.last_name ? ' ' + user.last_name : '');
      nameEl.textContent   = name;
      avatarEl.textContent = name.charAt(0).toUpperCase();
    } else {
      nameEl.textContent   = 'Гость (без Telegram)';
      avatarEl.textContent = '?';
    }
  }

  // Скрыть экран загрузки с fade-out
  function _lsHide(callback) {
    var el = document.getElementById('loadScreen');
    if (!el) { if (callback) callback(); return; }

    _lsSetProgress(100);
    setTimeout(function() {
      el.classList.add('fade-out');
      setTimeout(function() {
        el.classList.add('hidden');
        _lsStopSprite();
        if (_lsParticleRaf) { cancelAnimationFrame(_lsParticleRaf); _lsParticleRaf = null; }
        if (callback) callback();
      }, 520);
    }, 300);
  }

  // ────────────────────────────────────────────────────
  //  TELEGRAM AUTH
  // ────────────────────────────────────────────────────
  function _getTelegramInitData() {
    try {
      var tg = window.Telegram && window.Telegram.WebApp;
      if (tg && tg.initData && tg.initData.length > 0) {
        // Реальный Telegram Mini App
        _tgUser = tg.initDataUnsafe && tg.initDataUnsafe.user
          ? tg.initDataUnsafe.user
          : null;
        return tg.initData;
      }
    } catch (_) {}

    // DEV fallback: генерируем стабильный dev-userId
    var devId = localStorage.getItem('pixelrpg_devid');
    if (!devId) {
      devId = 'dev_' + Math.random().toString(36).slice(2, 10);
      localStorage.setItem('pixelrpg_devid', devId);
    }
    _tgUser = { id: devId, first_name: 'Dev', username: devId };
    return 'dev:' + devId;
  }

  // ────────────────────────────────────────────────────
  //  BUILD / APPLY SAVE
  // ────────────────────────────────────────────────────
  function buildSave() {
    return {
      gold:      G.gold,
      pixr:      G.pixr,
      gram:      G.gram,
      level:     G.level,
      xp:        G.xp,
      xpNeeded:  G.xpNeeded,
      floor:     G.floor,
      maxFloor:  G.maxFloor,
      killCount: G.killCount,
      cp:        calcCP(),
      hp:        G.hp,
      maxHp:     G.maxHp,
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

  function applySave(d) {
    if (!d) return;
    var n = function(v, def) { return v != null ? v : def; };

    G.gold      = n(d.gold,      G.gold);
    G.pixr      = n(d.pixr,      G.pixr);
    G.gram      = n(d.gram,      G.gram);
    G.level     = n(d.level,     G.level);
    G.xp        = n(d.xp,        G.xp);
    G.xpNeeded  = n(d.xpNeeded,  G.xpNeeded);
    G.floor     = n(d.floor,     G.floor);
    G.maxFloor  = n(d.maxFloor,  G.maxFloor);
    G.killCount = n(d.killCount, G.killCount);
    G.hp        = n(d.hp,        G.hp);
    G.maxHp     = n(d.maxHp,     G.maxHp);

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

  // ────────────────────────────────────────────────────
  //  LOCAL STORAGE
  // ────────────────────────────────────────────────────
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

  // ────────────────────────────────────────────────────
  //  SERVER SAVE (throttled)
  // ────────────────────────────────────────────────────
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

  // ────────────────────────────────────────────────────
  //  LOAD (сервер → localStorage → новая игра)
  // ────────────────────────────────────────────────────
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

  // ────────────────────────────────────────────────────
  //  АВТО-СЕЙВ + UNLOAD HANDLERS
  // ────────────────────────────────────────────────────
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
    window.addEventListener('pagehide', function() { saveLocal(); _doServerSave(); });
    window.addEventListener('beforeunload', function() { saveLocal(); });
  }

  function markDirty() { _dirty = true; saveLocal(); }

  // ────────────────────────────────────────────────────
  //  ГЛАВНАЯ ТОЧКА ВХОДА — init()
  //  Запускает экран загрузки, TG auth, загрузку сейва,
  //  затем показывает charSelect (или сразу игру если сейв есть)
  // ────────────────────────────────────────────────────
  function init() {
    if (_initialized) return;
    _initialized = true;

    // Запускаем анимации загрузочного экрана
    _lsStartSprite();
    _lsStartParticles();

    // Инициализация Telegram WebApp
    _lsSetStatus('Подключение к Telegram...');
    _lsSetProgress(10);

    try {
      var tg = window.Telegram && window.Telegram.WebApp;
      if (tg) { tg.ready(); tg.expand(); }
    } catch (_) {}

    _initData = _getTelegramInitData();
    _lsShowUser(_tgUser);
    _lsSetProgress(25);

    // Небольшая пауза чтобы TG успел инициализироваться
    setTimeout(function() {
      _lsSetStatus('Загрузка сохранения...');
      _lsSetProgress(45);

      _loadFromServer().then(function(result) {
        _lsSetProgress(80);

        var savedCharId = result.data && result.data.charId;
        var hasSave     = result.source !== 'none';

        _lsSetStatus(hasSave ? 'Сохранение загружено!' : 'Новая игра...');
        _lsSetProgress(95);

        _bindUnload();
        _startAutoSave();

        _lsHide(function() {
          if (hasSave && savedCharId && window.CHARS && CHARS[savedCharId]) {
            // Есть сейв — применяем персонажа и запускаем игру напрямую
            _charId = savedCharId;
            window.G_CHAR = CHARS[savedCharId];
            if (typeof applyCharacter === 'function') applyCharacter(G_CHAR);
            if (typeof recalcStats    === 'function') recalcStats();
            if (typeof initCharSelectSprites === 'function') initCharSelectSprites();
            if (typeof startGame      === 'function') startGame();
          } else {
            // Нет сейва — показываем экран выбора персонажа
            var cs = document.getElementById('charSelect');
            if (cs) cs.classList.remove('hidden');
            if (typeof initCharSelectSprites === 'function') initCharSelectSprites();
            if (typeof initCsParticles       === 'function') initCsParticles();
          }
        });
      });
    }, 400);
  }

  // ────────────────────────────────────────────────────
  return {
    init:        init,
    saveLocal:   saveLocal,
    saveServer:  saveServer,
    saveNow:     saveNow,
    markDirty:   markDirty,
    buildSave:   buildSave,
    getTgUser:   function() { return _tgUser; },
    getCharId:   function() { return _charId; },
    setCharId:   function(id) { _charId = id; },
  };
})();

// ── Запуск сразу при загрузке DOM ──────────────────────
document.addEventListener('DOMContentLoaded', function() {
  SaveSystem.init();
});
