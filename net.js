/*
  ══════════════════════════════════════════════════════
  net.js — Сетевой слой с ГАРАНТИРОВАННОЙ загрузкой
  ══════════════════════════════════════════════════════
*/

(function() {
  'use strict';

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
    batchTimer: null,
    lastServerTs: 0,
    serverConfirmed: false,
    currentTgId: null,
    rlBackoffUntil: 0,

    lastHp: 0,
    lastGold: 0,
    lastXp: 0,
    lastKillCount: 0,
    lastPotions: 0,
  };

  // ═══════════════════════════════
  //  ОЧЕРЕДЬ СОХРАНЕНИЙ
  // ═══════════════════════════════
  var saveQueue = [];
  var isSaving = false;

  function processQueue() {
    if (isSaving || saveQueue.length === 0) return;

    isSaving = true;
    var data = saveQueue.shift();

    fetch(API + '/api/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ initData: TG_INIT, data: data }),
    })
    .then(function(r) { return r.json(); })
    .then(function(r) {
      if (r && r.ok) {
        SYNC.lastServerTs = data.updatedAt || Date.now();
        SYNC.serverConfirmed = true;
        saveLocal();
      }
    })
    .catch(function(e) {
      console.warn('⚠️ [save]', e.message);
    })
    .finally(function() {
      isSaving = false;
      processQueue();
    });
  }

  function sendToServer(data) {
    if (!SYNC.online) return;
    saveQueue.push(data);
    processQueue();
  }

  function clearQueue() {
    saveQueue = [];
    isSaving = false;
  }

  function num(v, d) { v = Number(v); return isFinite(v) ? v : d; }
  function clone(o) { try { return JSON.parse(JSON.stringify(o)); } catch (e) { return Object.assign({}, o); } }

  // ═══════════════════════════════
  //  LOCALSTORAGE
  // ═══════════════════════════════
  var LS_KEY = 'pixrpg_save_v2';

  function saveLocal() {
    if (!SYNC.started) return;
    try {
      var snap = serializeState();
      snap._savedAt = Date.now();
      snap._offlineOnly = !SYNC.serverConfirmed;
      localStorage.setItem(LS_KEY, JSON.stringify(snap));
    } catch (e) {}
  }

  function loadLocal() {
    try {
      var raw = localStorage.getItem(LS_KEY);
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      if (parsed && parsed._savedAt && (Date.now() - parsed._savedAt) > 30 * 24 * 3600 * 1000) return null;
      return parsed;
    } catch (e) { return null; }
  }

  function clearLocal() {
    try { localStorage.removeItem(LS_KEY); } catch (e) {}
  }

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

  // ═══════════════════════════════
  //  ЭКРАН ЗАГРУЗКИ
  // ═══════════════════════════════
  var LS_MIN_MS = 800;
  var _lsShownAt = Date.now();
  var _isLoadingComplete = false;

  function lsSetStatus(text, pct) {
    var el = document.getElementById('lsStatus');
    if (el) el.innerHTML = '<span class="ls-dots">' + text + '</span>';
    var bar = document.getElementById('lsBar');
    if (bar && pct != null) bar.style.width = pct + '%';
  }

  function lsHide() {
    var el = document.getElementById('loadingScreen');
    if (!el || el.classList.contains('fade-out')) return;
    
    // 🔥 Скрываем ТОЛЬКО если загрузка завершена
    if (!_isLoadingComplete) {
      console.log('⏳ [lsHide] Ожидание завершения загрузки...');
      return;
    }
    
    el.style.pointerEvents = 'none';
    var elapsed = Date.now() - _lsShownAt;
    var delay = Math.max(0, LS_MIN_MS - elapsed);
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
      var x = (Math.random() * 100).toFixed(1);
      var y = (Math.random() * 100).toFixed(1);
      var dur = (1.5 + Math.random() * 2.5).toFixed(1);
      var del = (Math.random() * 3).toFixed(1);
      var op = (0.1 + Math.random() * 0.4).toFixed(2);
      html += '<div class="ls-star" style="left:' + x + '%;top:' + y + '%;opacity:' + op + ';--dur:' + dur + 's;--delay:-' + del + 's;"></div>';
    }
    wrap.innerHTML = html;
  }

  // ═══════════════════════════════
  //  СЕРИАЛИЗАЦИЯ
  // ═══════════════════════════════
  function serializeState() {
    var eq = {};
    EQUIP_SLOTS.forEach(function(slot) {
      var it = G.equipped && G.equipped[slot];
      eq[slot] = it ? it.id : null;
    });

    var inv = (G.inventory || []).map(function(it) {
      var c = clone(it);
      delete c._equipped;
      return c;
    });

    var full = {
      v: 1,
      tgId: getTgId(),
      charId: (typeof G_CHAR !== 'undefined' && G_CHAR) ? G_CHAR.id : (G.charId || null),

      inventory: inv,
      equipped: eq,
      upg: clone(G.upg),
      skills: clone(G.skills || {}),
      potionLv: G.potionLv,
      potionThreshold: G.potionThreshold,
      floor: G.floor,
      level: G.level,
      pixr: G.pixr,
      gram: G.gram,
      bp: clone(G.bp || { active: false, claimed: [] }),
      prem: clone(G.prem || { tier: null, expiresAt: 0 }),
      boss: clone(G.boss || { floor: 1, lastFightTime: 0 }),

      hp: G.hp,
      gold: G.gold,
      xp: G.xp,
      xpNeeded: G.xpNeeded,
      killCount: G.killCount,
      potions: G.potions,

      invIdCounter: (typeof _invIdCounter === 'number') ? _invIdCounter : 0,
      dailyTasks: clone(G.dailyTasks || { date: '', seconds: 0, claimed: [] }),
      specialTasksClaimed: clone(G.specialTasksClaimed || {}),
      invFilter: G.invFilter || 'all',
      cp: (typeof calcCP === 'function') ? calcCP() : 0,
      updatedAt: Date.now(),
    };

    return full;
  }

  // ═══════════════════════════════
  //  ПРИМЕНЕНИЕ СНАПШОТА
  // ═══════════════════════════════
  function applySnapshot(s) {
    if (!s || typeof s !== 'object') return false;

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

    G.upg = Object.assign(
      { atk: 0, def: 0, hp: 0, spd: 0, crit: 0, dodge: 0, atkSpd: 0 },
      s.upg || {}
    );

    if (G_CHAR && typeof UPG_DEFS !== 'undefined') {
      G.baseStats = Object.assign({}, G_CHAR.baseStats);
      UPG_DEFS.forEach(function(u) {
        var lv = G.upg[u.id] || 0;
        if (lv > 0) {
          G.baseStats[u.stat] = parseFloat(
            ((G.baseStats[u.stat] || 0) + u.bonus * lv).toFixed(4)
          );
        }
      });
      var lvBonuses = num(s.level, 1) - 1;
      if (lvBonuses > 0) {
        G.baseStats.atk    = (G.baseStats.atk    || 0) + lvBonuses * 2;
        G.baseStats.def    = (G.baseStats.def    || 0) + lvBonuses * 1;
        G.baseStats.hp     = (G.baseStats.hp     || 0) + lvBonuses * 10;
        G.baseStats.atkSpd = parseFloat(
          ((G.baseStats.atkSpd || 1.0) + lvBonuses * 0.02).toFixed(4)
        );
      }
    } else if (s.baseStats) {
      G.baseStats = Object.assign({}, s.baseStats);
    }

    G.skills = s.skills || {};
    G.potionLv = num(s.potionLv, 0);
    G.potionThreshold = num(s.potionThreshold, 30);
    G.floor = num(s.floor, G.floor);
    G.level = num(s.level, G.level);
    G.maxFloor = num(s.maxFloor, G.maxFloor);
    G.pixr = num(s.pixr, G.pixr);
    G.gram = num(s.gram, G.gram);
    G.bp = s.bp || { active: false, claimed: [] };
    if (!G.bp.claimed) G.bp.claimed = [];
    G.prem = s.prem || { tier: null, expiresAt: 0 };
    G.boss = s.boss || { floor: 1, lastFightTime: 0 };
    if (!G.boss.floor) G.boss.floor = 1;
    G.invFilter = s.invFilter || 'all';
    G.dailyTasks = s.dailyTasks || { date: '', seconds: 0, claimed: [] };
    G.specialTasksClaimed = s.specialTasksClaimed || {};

    G.gold = num(s.gold, G.gold);
    G.xp = num(s.xp, G.xp);
    G.killCount = num(s.killCount, G.killCount);
    G.potions = num(s.potions, G.potions);

    G.inventory = (s.inventory || []).map(function(it) {
      var c = clone(it);
      c._equipped = false;
      return c;
    });

    if (typeof s.invIdCounter === 'number') _invIdCounter = s.invIdCounter;
    G.inventory.forEach(function(i) {
      if (typeof i.id === 'number' && i.id > _invIdCounter) _invIdCounter = i.id;
    });

    G.equipped = { weapon: null, armor: null, ring: null, boots: null, helmet: null };
    var eq = s.equipped || {};
    EQUIP_SLOTS.forEach(function(slot) {
      var id = eq[slot];
      if (id == null) return;
      var it = G.inventory.find(function(i) { return i.id === id; });
      if (it) { it._equipped = true; G.equipped[slot] = it; }
    });

    if (typeof recalcStats === 'function') recalcStats();

    G.maxHp = num(s.maxHp, G.maxHp);
    G.xpNeeded = num(s.xpNeeded, 0);
    if (!G.xpNeeded || G.xpNeeded < 100) {
      var _xp = 100;
      for (var _lv = 1; _lv < G.level; _lv++) {
        _xp = Math.floor(_xp * (_lv < 7 ? 2.5 : 1.1));
      }
      G.xpNeeded = _xp;
    }

    var hp = num(s.hp, G.maxHp);
    if (hp <= 0) hp = Math.floor(G.maxHp * 0.3);
    G.hp = Math.max(1, Math.min(hp, G.maxHp));

    SYNC.lastHp = G.hp;
    SYNC.lastGold = G.gold;
    SYNC.lastXp = G.xp;
    SYNC.lastKillCount = G.killCount;
    SYNC.lastPotions = G.potions;

    if (typeof updateHUD === 'function') updateHUD();
    if (typeof updatePotionHud === 'function') updatePotionHud();
    if (typeof initSkillsHud === 'function') initSkillsHud();

    return true;
  }

  // ═══════════════════════════════
  //  СЕРВЕРНЫЕ ЗАПРОСЫ
  // ═══════════════════════════════
  var START_PARAM = '';

  function serverLoad() {
    if (!SYNC.online) return Promise.resolve(null);
    
    return fetch(API + '/api/load', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ initData: TG_INIT, startParam: START_PARAM }),
    })
    .then(function(r) { return r.json(); })
    .catch(function(e) {
      console.error('❌ [serverLoad] ошибка:', e.message);
      return null;
    });
  }

  // ═══════════════════════════════
  //  ⚡ МГНОВЕННОЕ СОХРАНЕНИЕ
  // ═══════════════════════════════
  function saveInstant(extraData) {
    if (!SYNC.started || !SYNC.online) return;

    var full = serializeState();

    var critical = {
      inventory: full.inventory,
      equipped: full.equipped,
      pixr: full.pixr,
      gram: full.gram,
      level: full.level,
      floor: full.floor,
      upg: full.upg,
      skills: full.skills,
      potionLv: full.potionLv,
      potionThreshold: full.potionThreshold,
      bp: full.bp,
      prem: full.prem,
      boss: full.boss,
      dailyTasks: full.dailyTasks,
      specialTasksClaimed: full.specialTasksClaimed,
      invIdCounter: full.invIdCounter,
      invFilter: full.invFilter,
      ...extraData,
    };

    if (extraData?.gold !== undefined) critical.gold = extraData.gold;
    if (extraData?.hp !== undefined) critical.hp = extraData.hp;
    if (extraData?.xp !== undefined) critical.xp = extraData.xp;
    if (extraData?.killCount !== undefined) critical.killCount = extraData.killCount;
    if (extraData?.potions !== undefined) critical.potions = extraData.potions;

    sendToServer(critical);
  }

  // ═══════════════════════════════
  //  ⏱️ ПЕРИОДИЧЕСКОЕ СОХРАНЕНИЕ
  // ═══════════════════════════════
  function savePeriodic() {
    if (!SYNC.started || !SYNC.online) return;

    if (Date.now() - SYNC.lastServerTs < 10000) return;

    var currentHp = G.hp;
    var currentGold = G.gold;
    var currentXp = G.xp;
    var currentKillCount = G.killCount;
    var currentPotions = G.potions;

    var hasChanges =
      currentHp !== SYNC.lastHp ||
      currentGold !== SYNC.lastGold ||
      currentXp !== SYNC.lastXp ||
      currentKillCount !== SYNC.lastKillCount ||
      currentPotions !== SYNC.lastPotions;

    if (!hasChanges) return;

    var full = serializeState();
    full.hp = currentHp;
    full.gold = currentGold;
    full.xp = currentXp;
    full.killCount = currentKillCount;
    full.potions = currentPotions;

    sendToServer(full);

    SYNC.lastHp = currentHp;
    SYNC.lastGold = currentGold;
    SYNC.lastXp = currentXp;
    SYNC.lastKillCount = currentKillCount;
    SYNC.lastPotions = currentPotions;
  }

  // ═══════════════════════════════
  //  ЭКРАН ВЫБОРА ПЕРСОНАЖА
  // ═══════════════════════════════
  function stopCharSelectAnims() {
    try {
      if (typeof _csSpriteTimers !== 'undefined') {
        Object.keys(_csSpriteTimers).forEach(function(k) {
          clearInterval(_csSpriteTimers[k]);
        });
      }
    } catch (e) {}
    try {
      if (typeof _csParticleTimer !== 'undefined' && _csParticleTimer) {
        cancelAnimationFrame(_csParticleTimer);
      }
    } catch (e) {}
  }

  function hideCharSelect() {
    var cs = document.getElementById('charSelect');
    if (cs) cs.classList.add('hidden');
    stopCharSelectAnims();
  }

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
    try {
      if (typeof switchTab === 'function' && typeof activeTab !== 'undefined') {
        switchTab(activeTab);
      }
    } catch (e) {}
  }

  function resetToCharSelect() {
    if (typeof gameActive !== 'undefined') window.gameActive = false;
    if (typeof G_CHAR !== 'undefined') window.G_CHAR = null;
    try {
      if (typeof G !== 'undefined') {
        G.charId = null;
        G.gold = 0;
        G.pixr = 0;
        G.gram = 0;
        G.level = 1;
        G.xp = 0;
        G.floor = 1;
        G.maxFloor = 1;
        G.killCount = 0;
        G.inventory = [];
        G.equipped = {};
        G.upg = { atk:0, def:0, hp:0, spd:0, crit:0, dodge:0, atkSpd:0 };
        G.bp = { active: false, claimed: [] };
        G.prem = { tier: null, expiresAt: 0 };
        G.skills = {};
        G.potions = 0;
        G.potionLv = 0;
        G.dailyTasks = { date: '', seconds: 0, claimed: [] };
        G.specialTasksClaimed = {};
      }
    } catch(e) {}
    if (typeof _invIdCounter !== 'undefined') window._invIdCounter = 0;

    var cs = document.getElementById('charSelect');
    if (cs) cs.classList.remove('hidden');
    var canvas = document.getElementById('gameCanvas');
    if (canvas) canvas.style.display = 'none';
    var skillsHud = document.getElementById('skillsHud');
    if (skillsHud) skillsHud.classList.remove('visible');
  }

  // ═══════════════════════════════
  //  ЦИКЛЫ СИНХРОНИЗАЦИИ
  // ═══════════════════════════════
  function startSyncLoops() {
    SYNC.batchTimer = setInterval(savePeriodic, 10000);
    setInterval(saveLocal, 30000);

    document.addEventListener('visibilitychange', function() {
      if (document.hidden) {
        savePeriodic();
      }
    });

    if (window.Telegram && window.Telegram.WebApp) {
      try { window.Telegram.WebApp.onEvent('close', function() { savePeriodic(); }); } catch (e) {}
    }

    window.addEventListener('pagehide', function() { savePeriodic(); });
    window.addEventListener('beforeunload', function() { savePeriodic(); });
  }

  // ═══════════════════════════════
  //  BOOT — С ГАРАНТИРОВАННОЙ ЗАГРУЗКОЙ
  // ═══════════════════════════════
  function initTelegram() {
    if (window.Telegram && window.Telegram.WebApp) {
      try { window.Telegram.WebApp.ready(); } catch (e) {}
      try { window.Telegram.WebApp.expand(); } catch (e) {}
      try {
        if (window.Telegram.WebApp.disableVerticalSwipes) {
          window.Telegram.WebApp.disableVerticalSwipes();
        }
      } catch (e) {}
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
    if (tgId) SYNC.currentTgId = tgId;
    console.log('🟢 [initTelegram] Пользователь:', tgId, 'Online:', SYNC.online);
  }

  function _tryBootFromLocal() {
    if (SYNC.started) return;
    var local = loadLocal();
    if (!local || !local.charId) return;
    var currentTgId = getTgId();
    if (local.tgId && currentTgId && local.tgId !== currentTgId) return;
    console.warn('⚠️ [boot] Сервер недоступен, загружаем из localStorage');
    lsSetStatus('Офлайн режим', 85);
    if (applySnapshot(local)) {
      hideCharSelect();
      SYNC.started = true;
      if (typeof startGame === 'function') startGame();
    }
  }

  function boot() {
    lsInitStars();
    lsSetStatus('Подключение', 10);
    initTelegram();

    console.log('🔄 [boot] Начинаем загрузку...');

    // 🔥 НЕ СКРЫВАЕМ ЭКРАН, ПОКА НЕ ЗАГРУЗЯТСЯ ДАННЫЕ
    lsSetStatus('Загрузка данных...', 40);

    // Пробуем загрузить с сервера
    serverLoad()
      .then(function(r) {
        if (r && r.ok && r.data) {
          console.log('✅ [boot] Данные с сервера получены');
          lsSetStatus('Данные загружены', 80);
          
          // Применяем данные
          applySnapshot(r.data);
          
          if (r.data.charId) {
            // Уже есть персонаж → сразу в игру
            SYNC.serverConfirmed = true;
            SYNC.started = true;
            
            if (typeof G_CHAR !== 'undefined' && G_CHAR) {
              hideCharSelect();
              if (typeof startGame === 'function') startGame();
            }
          } else {
            // Нет персонажа → показываем выбор
            SYNC.serverConfirmed = true;
          }
          
          // 🔥 ПОМЕЧАЕМ ЗАГРУЗКУ ЗАВЕРШЕННОЙ
          _isLoadingComplete = true;
          lsSetStatus('Готово', 100);
          
        } else {
          console.warn('⚠️ [boot] Сервер не вернул данные, пробуем localStorage');
          _tryBootFromLocal();
          
          // 🔥 ПОМЕЧАЕМ ЗАГРУЗКУ ЗАВЕРШЕННОЙ (даже если из localStorage)
          _isLoadingComplete = true;
        }
      })
      .catch(function(err) {
        console.error('❌ [boot] Ошибка загрузки:', err.message);
        _tryBootFromLocal();
        
        // 🔥 ПОМЕЧАЕМ ЗАГРУЗКУ ЗАВЕРШЕННОЙ
        _isLoadingComplete = true;
      })
      .finally(function() {
        console.log('✅ [boot] Загрузка завершена, скрываем экран');
        
        // 🔥 ВСЕГДА СКРЫВАЕМ ЭКРАН, НО ПОСЛЕ ЗАГРУЗКИ
        setTimeout(function() {
          lsHide();
        }, 500);
        
        // Запускаем периодические сохранения
        startSyncLoops();
        
        // Если данные не загрузились, но есть локальный бекап — он уже применился
        if (!SYNC.started) {
          // Если нет данных и нет персонажа — оставляем экран выбора
          console.log('ℹ️ [boot] Нет сохранений, показываем выбор персонажа');
        }
      });
  }

  // ═══════════════════════════════
  //  ХУКИ
  // ═══════════════════════════════
  function hookCharSelect() {
    var orig = window.confirmChar;
    if (typeof orig !== 'function') return;
    window.confirmChar = function() {
      var r = orig.apply(this, arguments);
      if (typeof G_CHAR === 'undefined' || !G_CHAR) return r;
      G.charId = G_CHAR.id;
      SYNC.started = true;
      SYNC.serverConfirmed = true;
      stopCharSelectAnims();

      if (SYNC.online) {
        try {
          fetch(API + '/api/character', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ initData: TG_INIT, charId: G.charId }),
          });
        } catch (e) {}
        var snap = serializeState();
        saveInstant({
          charId: G.charId,
          inventory: snap.inventory,
          equipped: snap.equipped,
          upg: snap.upg,
          skills: snap.skills,
          potionLv: snap.potionLv,
          potionThreshold: snap.potionThreshold,
          floor: snap.floor,
          level: snap.level,
          pixr: snap.pixr,
          gram: snap.gram,
          bp: snap.bp,
          prem: snap.prem,
        });
      }
      return r;
    };
  }

  var _hudSaveTimer = null;

  function saveToServerDebounced() {
    if (_hudSaveTimer) return;
    _hudSaveTimer = setTimeout(function() {
      _hudSaveTimer = null;
      savePeriodic();
    }, 500);
  }

  function hookActions() {
    var instantActions = [
      'equipItem', 'unequipItem', 'destroyItem', 'refineItem',
      'useSkillBook', 'buyBattlePass', 'claimBpReward', 'buyPrem',
      'upgPotion', 'goToFloor', 'buyPotions'
    ];

    instantActions.forEach(function(name) {
      var fn = window[name];
      if (typeof fn !== 'function') return;
      window[name] = function() {
        var r = fn.apply(this, arguments);
        try {
          saveInstant();
        } catch (e) {}
        return r;
      };
    });

    var origHUD = window.updateHUD;
    if (typeof origHUD === 'function') {
      window.updateHUD = function() {
        var r = origHUD.apply(this, arguments);
        if (SYNC.started) saveToServerDebounced();
        return r;
      };
    }
  }

  // ═══════════════════════════════
  //  ЭКСПОРТ
  // ═══════════════════════════════
  window.GameSync = {
    save: savePeriodic,
    saveInstant: saveInstant,
    load: serverLoad,
    flush: function() { savePeriodic(); },
    touch: function() { saveToServerDebounced(); },
    serialize: serializeState,
    apply: applySnapshot,
    state: SYNC,
    getTgId: getTgId,
    saveLocal: saveLocal,
    clearLocal: clearLocal,
    clearQueue: clearQueue,
    _API: API,
    get _INIT() { return TG_INIT; },
  };

  // ═══════════════════════════════
  //  ИНИЦИАЛИЗАЦИЯ
  // ═══════════════════════════════
  hookCharSelect();
  hookActions();

  if (document.readyState === 'complete') {
    boot();
  } else {
    window.addEventListener('load', boot);
  }

})();