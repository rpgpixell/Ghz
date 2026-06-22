/*
  ══════════════════════════════════════════════════════
  net.js — Сетевой слой: Telegram-авторизация, 
  сохранение прогресса на сервер (Redis + MongoDB)
  
  🔥 БЕЗ LOCALSTORAGE — все данные на сервере
  ══════════════════════════════════════════════════════
*/
(function () {
  'use strict';

  // ─── НАСТРАИВАЕМЫЙ API URL ───
  var API = (function() {
    var url = new URLSearchParams(window.location.search).get('api') || 
              window.ENV_API_URL || 
              'https://ghz-production.up.railway.app';
    return url.replace(/\/$/, '');
  })();

  var EQUIP_SLOTS = ['weapon', 'armor', 'ring', 'boots', 'helmet'];

  var TG_INIT = '';
  var SYNC = {
    booted: false,
    started: false,
    online: false,
    pushing: false,
    dirtyTimer: null,
    lastServerTs: 0,
    serverConfirmed: false,
    currentTgId: null,
  };

  // ─── ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ───
  function num(v, d) { v = Number(v); return isFinite(v) ? v : d; }
  function clone(o)  { try { return JSON.parse(JSON.stringify(o)); } catch (e) { return Object.assign({}, o); } }

  // ─── ПОЛУЧЕНИЕ TG ID (ТОЛЬКО ИЗ TELEGRAM) ───
  function getTgId() {
    try {
      if (window.Telegram && window.Telegram.WebApp) {
        var unsafe = window.Telegram.WebApp.initDataUnsafe;
        if (unsafe && unsafe.user && unsafe.user.id) {
          return String(unsafe.user.id);
        }
      }
    } catch (e) {}
    return null;
  }

  // ─── ЭКРАН ЗАГРУЗКИ ───
  var LS_MIN_MS = 800;
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
    var elapsed = Date.now() - _lsShownAt;
    var delay = Math.max(0, LS_MIN_MS - elapsed);
    setTimeout(function () {
      lsSetStatus('Готово', 100);
      setTimeout(function () {
        el.classList.add('fade-out');
        setTimeout(function () { el.style.display = 'none'; }, 520);
      }, 300);
    }, delay);
  }

  function lsInitStars() {
    var wrap = document.getElementById('lsStars');
    if (!wrap) return;
    var html = '';
    for (var i = 0; i < 60; i++) {
      var x = (Math.random() * 100).toFixed(1);
      var y = (Math.random() * 100).toFixed(1);
      var dur = (1.5 + Math.random() * 2.5).toFixed(1);
      var del = (Math.random() * 3).toFixed(1);
      var op = (0.1 + Math.random() * 0.4).toFixed(2);
      html += '<div class="ls-star" style="left:' + x + '%;top:' + y + '%;opacity:' + op + ';--dur:' + dur + 's;--delay:-' + del + 's;"></div>';
    }
    wrap.innerHTML = html;
  }

  // ─── СЕРИАЛИЗАЦИЯ ───
  function serializeState() {
    var eq = {};
    EQUIP_SLOTS.forEach(function (slot) {
      var it = G.equipped && G.equipped[slot];
      eq[slot] = it ? it.id : null;
    });

    var inv = (G.inventory || []).map(function (it) {
      var c = clone(it);
      delete c._equipped;
      return c;
    });

    var snap = {
      v: 1,
      tgId: getTgId(),
      charId: (typeof G_CHAR !== 'undefined' && G_CHAR) ? G_CHAR.id : (G.charId || null),

      gold: G.gold, pixr: G.pixr, gram: G.gram,
      level: G.level, xp: G.xp, xpNeeded: G.xpNeeded,
      floor: G.floor, maxFloor: G.maxFloor, killCount: G.killCount,
      hp: G.hp, maxHp: G.maxHp,

      baseStats: clone(G.baseStats),
      stats:     clone(G.stats),
      upg:       clone(G.upg),

      potionLv: G.potionLv, potions: G.potions, potionThreshold: G.potionThreshold,
      bp:     clone(G.bp     || { active: false, claimed: [] }),
      prem:   clone(G.prem   || { tier: null, expiresAt: 0 }),
      skills: clone(G.skills || {}),

      inventory: inv,
      equipped:  eq,
      invIdCounter: (typeof _invIdCounter === 'number') ? _invIdCounter : 0,
      invFilter: G.invFilter || 'all',

      cp: (typeof calcCP === 'function') ? calcCP() : 0,
      updatedAt: Date.now(),
    };
    
    return snap;
  }

  // ─── ПРИМЕНЕНИЕ СНАПШОТА ───
  function applySnapshot(s) {
    if (!s || typeof s !== 'object') return false;

    // Проверка: снапшот от другого пользователя — игнорируем
    var currentTgId = getTgId();
    if (s.tgId && currentTgId && s.tgId !== currentTgId) {
      console.warn('⚠️ Игнорируем снапшот другого пользователя:', s.tgId);
      return false;
    }

    if (s.charId && typeof CHARS !== 'undefined' && CHARS[s.charId]) {
      G_CHAR = CHARS[s.charId];
      G.charId = s.charId;
      if (typeof applyCharacterSprites === 'function') applyCharacterSprites(G_CHAR);
    }

    if (s.baseStats) G.baseStats = Object.assign({}, s.baseStats);
    G.gold = num(s.gold, G.gold);
    G.pixr = num(s.pixr, G.pixr);
    G.gram = num(s.gram, G.gram);
    G.level = num(s.level, G.level);
    G.xp = num(s.xp, G.xp);
    G.xpNeeded = num(s.xpNeeded, G.xpNeeded);
    G.floor = num(s.floor, G.floor);
    G.maxFloor = num(s.maxFloor, G.maxFloor);
    G.killCount = num(s.killCount, G.killCount);

    G.upg = Object.assign(
      { atk: 0, def: 0, hp: 0, spd: 0, crit: 0, dodge: 0, atkSpd: 0 },
      s.upg || {}
    );
    G.potionLv = num(s.potionLv, 0);
    G.potions = num(s.potions, 0);
    G.potionThreshold = num(s.potionThreshold, 30);
    G.bp = s.bp || { active: false, claimed: [] };
    if (!G.bp.claimed) G.bp.claimed = [];
    G.prem = s.prem || { tier: null, expiresAt: 0 };
    G.skills = s.skills || {};
    G.invFilter = s.invFilter || 'all';

    G.inventory = (s.inventory || []).map(function (it) {
      var c = clone(it); c._equipped = false; return c;
    });

    if (typeof s.invIdCounter === 'number') _invIdCounter = s.invIdCounter;
    G.inventory.forEach(function (i) {
      if (typeof i.id === 'number' && i.id > _invIdCounter) _invIdCounter = i.id;
    });

    G.equipped = { weapon: null, armor: null, ring: null, boots: null, helmet: null };
    var eq = s.equipped || {};
    EQUIP_SLOTS.forEach(function (slot) {
      var id = eq[slot];
      if (id == null) return;
      var it = G.inventory.find(function (i) { return i.id === id; });
      if (it) { it._equipped = true; G.equipped[slot] = it; }
    });

    if (typeof recalcStats === 'function') recalcStats();
    var hp = num(s.hp, G.maxHp);
    if (hp <= 0) hp = Math.floor(G.maxHp * 0.3);
    G.hp = Math.max(1, Math.min(hp, G.maxHp));

    return true;
  }

  // ─── СЕРВЕРНЫЕ ЗАПРОСЫ ───
  var START_PARAM = '';

  function serverLoad() {
    if (!SYNC.online) return Promise.resolve(null);
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, 5000) : null;
    
    var tgId = getTgId();
    console.log('🟢 [serverLoad] Пользователь:', tgId);
    
    return fetch(API + '/api/load', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ initData: TG_INIT, startParam: START_PARAM }),
      signal: ctrl ? ctrl.signal : undefined,
    }).then(function (r) { 
      clearTimeout(timer); 
      return r.json(); 
    })
    .catch(function (e) { 
      clearTimeout(timer); 
      console.error('❌ [serverLoad] ошибка:', e.message);
      throw e; 
    });
  }

  function serverSave(snap) {
    if (!SYNC.online) return Promise.resolve({ ok: false });
    console.log('💾 [serverSave] сохранение для:', snap.tgId || getTgId());
    return fetch(API + '/api/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ initData: TG_INIT, data: snap }),
    }).then(function (r) { 
      if (r.status === 403) {
        console.error('🚫 Сервер отклонил сохранение (user_mismatch)');
        return { ok: false, error: 'user_mismatch' };
      }
      return r.json(); 
    });
  }

  function pushServer() {
    if (!SYNC.online || !SYNC.started || !SYNC.serverConfirmed || SYNC.pushing) { 
      return; 
    }
    var snap = serializeState();
    SYNC.pushing = true;
    serverSave(snap)
      .then(function (r) { 
        if (r && r.ok) SYNC.lastServerTs = r.updatedAt || snap.updatedAt; 
      })
      .catch(function () {})
      .then(function () { SYNC.pushing = false; });
  }

  function touch() {
    if (!SYNC.started) return;
    if (!SYNC.online) return;
    clearTimeout(SYNC.dirtyTimer);
    SYNC.dirtyTimer = setTimeout(pushServer, 1200);
  }

  function flush() {
    if (!SYNC.started) return;
    var snap = serializeState();
    if (!SYNC.online || !SYNC.serverConfirmed) return;
    try {
      fetch(API + '/api/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ initData: TG_INIT, data: snap }),
        keepalive: true,
      });
    } catch (e) {}
  }

  // ─── ЭКРАН ВЫБОРА ПЕРСОНАЖА ───
  function stopCharSelectAnims() {
    try { if (typeof _csSpriteTimers !== 'undefined') Object.keys(_csSpriteTimers).forEach(function (k) { clearInterval(_csSpriteTimers[k]); }); } catch (e) {}
    try { if (typeof _csParticleTimer !== 'undefined' && _csParticleTimer) cancelAnimationFrame(_csParticleTimer); } catch (e) {}
  }
  
  function hideCharSelect() {
    var cs = document.getElementById('charSelect');
    if (cs) cs.classList.add('hidden');
    stopCharSelectAnims();
  }

  // ─── СТАРТ ИЗ СНАПШОТА ───
  function bootFromSnapshot(snap) {
    if (SYNC.started) return;
    if (!applySnapshot(snap)) return;
    hideCharSelect();
    SYNC.started = true;
    if (typeof startGame === 'function') startGame();
  }

  function hotApply(snap) {
    if (!applySnapshot(snap)) return;
    if (typeof updateHUD === 'function') updateHUD();
    if (typeof initSkillsHud === 'function') initSkillsHud();
    if (typeof updatePotionHud === 'function') updatePotionHud();
    try { if (typeof switchTab === 'function' && typeof activeTab !== 'undefined') switchTab(activeTab); } catch (e) {}
  }

  // ─── ЦИКЛЫ СИНХРОНИЗАЦИИ ───
  function startSyncLoops() {
    setInterval(pushServer, 5000);

    document.addEventListener('visibilitychange', function () {
      if (document.hidden) flush();
    });

    if (window.Telegram && window.Telegram.WebApp) {
      try { window.Telegram.WebApp.onEvent('close', flush); } catch (e) {}
    }

    window.addEventListener('pagehide', flush);
    window.addEventListener('beforeunload', flush);
  }

  // ─── СБРОС К ЭКРАНУ ВЫБОРА ───
  function resetToCharSelect() {
    if (typeof gameActive !== 'undefined') window.gameActive = false;
    if (typeof G_CHAR !== 'undefined') window.G_CHAR = null;
    try { if (typeof G !== 'undefined') {
      G.charId = null;
      G.gold = 0; G.pixr = 0; G.gram = 0;
      G.level = 1; G.xp = 0; G.floor = 1; G.maxFloor = 1; G.killCount = 0;
      G.inventory = []; G.equipped = {};
      G.upg = { atk:0, def:0, hp:0, spd:0, crit:0, dodge:0, atkSpd:0 };
      G.bp = { active: false, claimed: [] };
      G.prem = { tier: null, expiresAt: 0 };
      G.skills = {};
    }} catch(e) {}
    if (typeof _invIdCounter !== 'undefined') window._invIdCounter = 0;
    
    var cs = document.getElementById('charSelect');
    if (cs) cs.classList.remove('hidden');
    var canvas = document.getElementById('gameCanvas');
    if (canvas) canvas.style.display = 'none';
    var skillsHud = document.getElementById('skillsHud');
    if (skillsHud) skillsHud.classList.remove('visible');
  }

  // ─── BOOT ───
  function initTelegram() {
    if (window.Telegram && window.Telegram.WebApp) {
      try { window.Telegram.WebApp.ready(); } catch (e) {}
      try { window.Telegram.WebApp.expand(); } catch (e) {}
      try { window.Telegram.WebApp.disableVerticalSwipes && window.Telegram.WebApp.disableVerticalSwipes(); } catch (e) {}
      TG_INIT = window.Telegram.WebApp.initData || '';
      try {
        START_PARAM = (window.Telegram.WebApp.initDataUnsafe && window.Telegram.WebApp.initDataUnsafe.start_param) || '';
      } catch (e) { START_PARAM = ''; }
    }
    if (!START_PARAM) {
      try {
        var urlRef = new URLSearchParams(window.location.search).get('ref') || '';
        if (urlRef) START_PARAM = urlRef;
      } catch (e) {}
    }
    SYNC.online = !!TG_INIT;
    
    var tgId = getTgId();
    if (tgId) {
      SYNC.currentTgId = tgId;
    }
    console.log('🟢 [initTelegram] Пользователь:', tgId, 'Online:', SYNC.online);
  }

  function boot() {
    lsInitStars();
    lsSetStatus('Подключение', 10);
    initTelegram();

    var lsTimeout = setTimeout(function () { lsHide(); }, 6000);
    lsSetStatus(SYNC.online ? 'Загрузка с сервера' : 'Офлайн режим', 60);

    // Сверка с сервером
    serverLoad().then(function (r) {
      clearTimeout(lsTimeout);

      if (!r || !r.ok) {
        console.warn('⚠️ [serverLoad] ответ не ok:', r);
        return;
      }

      var server = r.save;
      var currentTgId = getTgId();

      // Проверка: серверный ответ для другого пользователя?
      if (server && server.data && server.data.tgId && currentTgId && server.data.tgId !== currentTgId) {
        console.warn('⚠️ Сервер вернул данные другого пользователя, игнорируем');
        return;
      }

      if (server && server.data && server.data.charId &&
          typeof CHARS !== 'undefined' && CHARS[server.data.charId]) {
        SYNC.serverConfirmed = true;
        lsSetStatus('Применение данных', 85);
        
        if (!SYNC.started) {
          bootFromSnapshot(server.data);
        } else {
          hotApply(server.data);
        }
      } else if (!server || !server.data) {
        // Сервер говорит "пользователь новый или удалён"
        if (SYNC.started) {
          SYNC.started = false;
          SYNC.serverConfirmed = false;
          resetToCharSelect();
        }
      }
    }).catch(function (err) {
      clearTimeout(lsTimeout);
      console.error('❌ [boot] serverLoad ошибка:', err.message);
    }).then(function () {
      SYNC.booted = true;
      startSyncLoops();
      if (SYNC.online && SYNC.started && SYNC.serverConfirmed) pushServer();
      lsHide();
    });
  }

  // ─── ХУКИ ───
  function hookCharSelect() {
    var orig = window.confirmChar;
    if (typeof orig !== 'function') return;
    window.confirmChar = function () {
      var r = orig.apply(this, arguments);
      if (typeof G_CHAR === 'undefined' || !G_CHAR) return r;
      G.charId = G_CHAR.id;
      SYNC.started = true;
      SYNC.serverConfirmed = true;
      stopCharSelectAnims();
      
      var snap = serializeState();
      
      if (SYNC.online) {
        try {
          fetch(API + '/api/character', {
            method: 'POST', 
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ initData: TG_INIT, charId: G.charId }),
          });
        } catch (e) {}
        pushServer();
      }
      return r;
    };
  }

  var _hudSaveTimer = null;
  function saveToServerDebounced() {
    if (_hudSaveTimer) return;
    _hudSaveTimer = setTimeout(function () { 
      _hudSaveTimer = null; 
      pushServer(); 
    }, 500);
  }

  function hookActions() {
    var names = [
      'buyUpgrade', 'equipItem', 'unequipItem', 'destroyItem', 'refineItem',
      'useSkillBook', 'buyBattlePass', 'claimBpReward', 'buyPrem', 'exchangePixr',
      'upgPotion', 'buyPotions', 'revivePlayer', 'goToFloor', 'savePotionThreshold',
    ];
    names.forEach(function (name) {
      var fn = window[name];
      if (typeof fn !== 'function') return;
      window[name] = function () {
        var r = fn.apply(this, arguments);
        try { touch(); } catch (e) {}
        return r;
      };
    });

    var origHUD = window.updateHUD;
    if (typeof origHUD === 'function') {
      window.updateHUD = function () {
        var r = origHUD.apply(this, arguments);
        if (SYNC.started) saveToServerDebounced();
        return r;
      };
    }
  }

  // ─── ИНИЦИАЛИЗАЦИЯ ───
  hookCharSelect();
  hookActions();

  if (document.readyState === 'complete') {
    boot();
  } else {
    window.addEventListener('load', boot);
  }

  // ─── ПУБЛИЧНЫЙ API ───
  window.GameSync = {
    save:      pushServer,
    flush:     flush,
    touch:     touch,
    serialize: serializeState,
    apply:     applySnapshot,
    state:     SYNC,
    getTgId:   getTgId,
    _API:      API,
    get _INIT() { return TG_INIT; },
  };
})();