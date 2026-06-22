/*
  ══════════════════════════════════════════════════════
  net.js — Сетевой слой: Telegram-авторизация, сохранение
  прогресса на сервер (MongoDB), локальный кеш.

  Логика:
   • При запуске: моментальный старт из localStorage (без
     мигания экрана выбора), затем сверка с сервером.
   • HP / баланс / весь снапшот:
       – localStorage каждые 1 сек,
       – сервер каждые 15 сек,
       – + при закрытии/сворачивании (visibilitychange + TG close event).
   • Структурные действия (покупка, экипировка, заточка,
     навыки, BP, premium, этаж, выбор персонажа) —
     сохраняются сразу (debounce 1.2с).
   • Полный снапшот, поэтому при обновлении/закрытии в
     Telegram прогресс не теряется.

  Версия: 2.0.0
  Подключать ПОСЛЕ ui.js (последним скриптом).
  ══════════════════════════════════════════════════════
*/
(function () {
  'use strict';

  var API_VERSION = 'v1';
  var API    = 'https://ghz-production.up.railway.app/api/' + API_VERSION;
  var LS_KEY = 'prrpg_save_v1';
  var EQUIP_SLOTS = ['weapon', 'armor', 'ring', 'boots', 'helmet'];
  var SNAPSHOT_VERSION = 1;

  // Лимиты для валидации
  var LIMITS = {
    maxLevel: 9999,
    maxGold: 999999999,
    maxInventory: 500,
    maxFloor: 9999,
    minHp: 1
  };

  var TG_INIT = '';
  var SYNC = {
    booted: false,   // прошёл boot
    started: false,  // игра запущена (персонаж есть)
    online: false,   // есть валидный initData -> можем писать на сервер
    pushing: false,
    dirtyTimer: null,
    lastServerTs: 0,
    pendingSaves: [], // очередь неудачных сохранений
    syncIndicator: null, // DOM элемент индикатора синхронизации
  };

  // ───────────────────────────────
  //  ЭКРАН ЗАГРУЗКИ
  // ───────────────────────────────
  var LS_MIN_MS = 800; // минимальное время показа (чтоб не мелькало)
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

  // Генерация звёзд фона
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

  function num(v, d) { v = Number(v); return isFinite(v) ? v : d; }
  
  function clone(o) { 
    try { 
      return JSON.parse(JSON.stringify(o)); 
    } catch (e) { 
      console.warn('Deep clone failed, using shallow copy');
      return Object.assign({}, o); 
    } 
  }

  // ───────────────────────────────
  //  ВАЛИДАЦИЯ ДАННЫХ
  // ───────────────────────────────
  function validateSnapshot(s) {
    if (!s || typeof s !== 'object') return false;
    if (s.v !== SNAPSHOT_VERSION) {
      console.warn('Unknown snapshot version:', s.v);
      return false;
    }

    // Проверка критических полей на разумные значения
    if (s.gold < 0 || s.gold > LIMITS.maxGold) return false;
    if (s.level < 1 || s.level > LIMITS.maxLevel) return false;
    if (s.floor < 0 || s.floor > LIMITS.maxFloor) return false;
    if (s.hp < 0 || s.maxHp < 1) return false;
    if (s.inventory && s.inventory.length > LIMITS.maxInventory) return false;

    return true;
  }

  // ───────────────────────────────
  //  СЕРИАЛИЗАЦИЯ СОСТОЯНИЯ (полный снапшот G)
  // ───────────────────────────────
  function serializeState() {
    var eq = {};
    EQUIP_SLOTS.forEach(function (slot) {
      var it = G.equipped && G.equipped[slot];
      eq[slot] = it ? it.id : null;
    });

    var inv = (G.inventory || []).map(function (it) {
      var c = clone(it);
      delete c._equipped; // ссылку восстанавливаем по equipped при загрузке
      return c;
    });

    return {
      v: SNAPSHOT_VERSION,
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
      clientVersion: '2.0.0'
    };
  }

  // ───────────────────────────────
  //  ПРИМЕНЕНИЕ СНАПШОТА К G
  // ───────────────────────────────
  function applySnapshot(s) {
    if (!validateSnapshot(s)) return false;

    // Персонаж (спрайты, без сброса прокачанных статов)
    if (s.charId && typeof CHARS !== 'undefined' && CHARS[s.charId]) {
      G_CHAR = CHARS[s.charId];
      G.charId = s.charId;
      if (typeof applyCharacterSprites === 'function') applyCharacterSprites(G_CHAR);
    }

    // Базовые статы и числа
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

    // Инвентарь
    G.inventory = (s.inventory || []).map(function (it) {
      var c = clone(it); c._equipped = false; return c;
    });

    // Счётчик id (не ниже максимального существующего)
    if (typeof s.invIdCounter === 'number') _invIdCounter = s.invIdCounter;
    G.inventory.forEach(function (i) {
      if (typeof i.id === 'number' && i.id > _invIdCounter) _invIdCounter = i.id;
    });

    // Экипировка: восстанавливаем ССЫЛКИ на объекты инвентаря
    G.equipped = { weapon: null, armor: null, ring: null, boots: null, helmet: null };
    var eq = s.equipped || {};
    EQUIP_SLOTS.forEach(function (slot) {
      var id = eq[slot];
      if (id == null) return;
      var it = G.inventory.find(function (i) { return i.id === id; });
      if (it) { it._equipped = true; G.equipped[slot] = it; }
    });

    // Пересчёт статов от базы + экипировки, затем HP
    if (typeof recalcStats === 'function') recalcStats();
    var hp = num(s.hp, G.maxHp);
    if (hp <= 0) hp = Math.floor(G.maxHp * 0.3);
    G.hp = Math.max(LIMITS.minHp, Math.min(hp, G.maxHp));

    return true;
  }

  // ───────────────────────────────
  //  ЛОКАЛЬНЫЙ КЕШ
  // ───────────────────────────────
  function writeLocal(snap) {
    try { 
      localStorage.setItem(LS_KEY, JSON.stringify(snap)); 
    } catch (e) {
      console.warn('Failed to write to localStorage:', e);
      // Если localStorage переполнен - очищаем старые данные
      if (e.name === 'QuotaExceededError') {
        try {
          localStorage.clear();
          localStorage.setItem(LS_KEY, JSON.stringify(snap));
        } catch (e2) {
          console.error('Failed to clear localStorage:', e2);
        }
      }
    }
  }
  
  function readLocal() {
    try { 
      var s = localStorage.getItem(LS_KEY); 
      return s ? JSON.parse(s) : null; 
    } catch (e) { 
      console.warn('Failed to read from localStorage:', e);
      return null; 
    }
  }
  
  function saveLocal() { 
    if (SYNC.started) {
      var snap = serializeState();
      writeLocal(snap);
    }
  }

  // ───────────────────────────────
  //  СЕРВЕР
  // ───────────────────────────────
  function serverLoad() {
    if (!SYNC.online) return Promise.resolve(null);
    
    return fetch(API + '/load', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ initData: TG_INIT }),
    })
    .then(function (r) { 
      if (!r.ok) {
        throw new Error('Server returned ' + r.status);
      }
      return r.json(); 
    });
  }

  function serverSave(snap) {
    if (!SYNC.online) return Promise.resolve({ ok: false });
    
    return fetch(API + '/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ initData: TG_INIT, data: snap }),
    })
    .then(function (r) { 
      if (!r.ok) {
        throw new Error('Server returned ' + r.status);
      }
      return r.json(); 
    });
  }

  // Отправка логов ошибок на сервер
  function sendErrorLog(errorData) {
    if (!SYNC.online) return;
    
    try {
      fetch(API + '/log', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          initData: TG_INIT,
          type: 'client_error',
          timestamp: Date.now(),
          data: errorData,
          userAgent: navigator.userAgent,
          url: window.location.href
        }),
        keepalive: true
      }).catch(function() {});
    } catch (e) {}
  }

  // Обновление индикатора синхронизации
  function updateSyncIndicator(status) {
    if (!SYNC.syncIndicator) {
      SYNC.syncIndicator = document.getElementById('syncIndicator');
      if (!SYNC.syncIndicator) return;
    }
    
    switch(status) {
      case 'saving':
        SYNC.syncIndicator.className = 'sync-indicator saving';
        SYNC.syncIndicator.title = 'Сохранение...';
        break;
      case 'saved':
        SYNC.syncIndicator.className = 'sync-indicator saved';
        SYNC.syncIndicator.title = 'Сохранено';
        setTimeout(function() {
          if (SYNC.syncIndicator) {
            SYNC.syncIndicator.className = 'sync-indicator';
          }
        }, 2000);
        break;
      case 'error':
        SYNC.syncIndicator.className = 'sync-indicator error';
        SYNC.syncIndicator.title = 'Ошибка сохранения';
        break;
      default:
        SYNC.syncIndicator.className = 'sync-indicator';
        SYNC.syncIndicator.title = 'Ожидание';
    }
  }

  function pushServer() {
    if (!SYNC.online || !SYNC.started || SYNC.pushing) { 
      saveLocal(); 
      return; 
    }
    
    var snap = serializeState();
    writeLocal(snap);
    SYNC.pushing = true;
    
    updateSyncIndicator('saving');
    
    serverSave(snap)
      .then(function (r) { 
        if (r && r.ok) {
          SYNC.lastServerTs = r.updatedAt || snap.updatedAt;
          updateSyncIndicator('saved');
        } else {
          updateSyncIndicator('error');
          queueFailedSave(snap);
        }
      })
      .catch(function (err) {
        console.warn('Server save failed:', err);
        updateSyncIndicator('error');
        queueFailedSave(snap);
        sendErrorLog({
          message: 'Server save failed',
          error: err.message
        });
      })
      .then(function () { 
        SYNC.pushing = false; 
        processQueue(); // Обрабатываем очередь неудачных сохранений
      });
  }

  // Очередь неудачных сохранений
  function queueFailedSave(snap) {
    SYNC.pendingSaves.push({ 
      snap: snap, 
      retries: 0, 
      timestamp: Date.now(),
      maxRetries: 3
    });
  }

  function processQueue() {
    if (SYNC.pendingSaves.length === 0 || SYNC.pushing) return;
    
    var save = SYNC.pendingSaves[0];
    if (save.retries >= save.maxRetries) {
      console.warn('Dropping failed save after ' + save.maxRetries + ' retries');
      SYNC.pendingSaves.shift();
      return;
    }
    
    SYNC.pushing = true;
    updateSyncIndicator('saving');
    
    serverSave(save.snap)
      .then(function (r) {
        if (r && r.ok) {
          SYNC.pendingSaves.shift();
          updateSyncIndicator('saved');
        } else {
          save.retries++;
          updateSyncIndicator('error');
        }
      })
      .catch(function () {
        save.retries++;
        updateSyncIndicator('error');
      })
      .then(function () {
        SYNC.pushing = false;
        // Продолжаем обрабатывать очередь через небольшую задержку
        setTimeout(processQueue, 5000);
      });
  }

  // Сохранение «сразу» после структурных действий (с коалесингом)
  function touch() {
    if (!SYNC.started) return;
    saveLocal();
    if (!SYNC.online) return;
    clearTimeout(SYNC.dirtyTimer);
    SYNC.dirtyTimer = setTimeout(pushServer, 1200);
  }

  function flush() {
    if (!SYNC.started) return;
    
    var snap = serializeState();
    writeLocal(snap);
    
    if (!SYNC.online) return;
    
    var body = JSON.stringify({ initData: TG_INIT, data: snap });
    
    // keepalive имеет ограничение на размер ~64KB
    var useKeepalive = body.length < 60000;
    
    var options = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body
    };
    
    if (useKeepalive) {
      options.keepalive = true;
    }
    
    fetch(API + '/save', options).catch(function(err) {
      console.warn('Flush failed:', err);
    });
  }

  // ───────────────────────────────
  //  ЭКРАН ВЫБОРА ПЕРСОНАЖА
  // ───────────────────────────────
  function stopCharSelectAnims() {
    try { 
      if (typeof _csSpriteTimers !== 'undefined') {
        Object.keys(_csSpriteTimers).forEach(function (k) { 
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

  // ───────────────────────────────
  //  СТАРТ ИГРЫ ИЗ СНАПШОТА
  // ───────────────────────────────
  function bootFromSnapshot(snap) {
    if (SYNC.started) return;
    if (!applySnapshot(snap)) return;
    hideCharSelect();
    SYNC.started = true;
    if (typeof startGame === 'function') startGame();
  }

  // Применить серверный снапшот поверх уже идущей игры (другое устройство)
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

  // Разрешение конфликтов между локальными и серверными данными
  function resolveConflicts(local, server) {
    if (!server || !server.updatedAt) return local;
    if (!local || !local.updatedAt) return server;
    
    // Серверные данные новее - приоритет серверу
    if (server.updatedAt > local.updatedAt) return server;
    
    // Локальные данные новее (редко, но возможно)
    if (local.updatedAt > server.updatedAt) return local;
    
    // Временные метки совпадают - сохраняем более прогрессивного персонажа
    if (local.level > server.level) return local;
    if (server.level > local.level) return server;
    
    // При прочих равных - больше золота
    return local.gold >= server.gold ? local : server;
  }

  // ───────────────────────────────
  //  ЦИКЛЫ СИНХРОНИЗАЦИИ
  // ───────────────────────────────
  var syncTimers = {
    local: null,
    server: null
  };

  function startSyncLoops() {
    // Очищаем старые таймеры
    stopSyncLoops();
    
    syncTimers.local = setInterval(saveLocal, 1000);    // localStorage каждую 1 сек
    syncTimers.server = setInterval(pushServer, 15000);  // сервер каждые 15 сек

    // visibilitychange — срабатывает при сворачивании в Telegram
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) flush();
    });

    // Telegram WebApp события — надёжнее beforeunload
    if (window.Telegram && window.Telegram.WebApp) {
      try { window.Telegram.WebApp.onEvent('close', flush); } catch (e) {}
      try { window.Telegram.WebApp.onEvent('viewportChanged', saveLocal); } catch (e) {}
    }

    // pagehide — иногда работает в некоторых WebView
    window.addEventListener('pagehide', flush);
    // beforeunload — НЕ работает в Telegram WebView, но оставим для браузера
    window.addEventListener('beforeunload', flush);
  }

  function stopSyncLoops() {
    if (syncTimers.local) {
      clearInterval(syncTimers.local);
      syncTimers.local = null;
    }
    if (syncTimers.server) {
      clearInterval(syncTimers.server);
      syncTimers.server = null;
    }
  }

  // Глобальный обработчик ошибок
  function initErrorHandling() {
    window.addEventListener('error', function(event) {
      sendErrorLog({
        message: event.message,
        stack: event.error ? event.error.stack : null,
        source: event.filename,
        line: event.lineno,
        col: event.colno
      });
    });

    window.addEventListener('unhandledrejection', function(event) {
      sendErrorLog({
        message: 'Unhandled Promise Rejection',
        stack: event.reason ? (event.reason.stack || event.reason.message) : null
      });
    });
  }

  // ───────────────────────────────
  //  BOOT
  // ───────────────────────────────
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
    }
    SYNC.online = !!TG_INIT;
  }

  function boot() {
    lsInitStars();
    lsSetStatus('Подключение', 10);
    initTelegram();
    initErrorHandling();
    
    var booted = false; // Защита от двойной загрузки
    var local = readLocal();

    // Таймаут: если сервер не ответил за 6 сек — грузим из localStorage (офлайн)
    var lsTimeout = setTimeout(function () {
      if (booted) return;
      booted = true;
      
      if (local && local.charId && typeof CHARS !== 'undefined' && CHARS[local.charId]) {
        lsSetStatus('Офлайн загрузка', 40);
        bootFromSnapshot(local);
      } else {
        lsSetStatus('Нет данных', 40);
      }
      lsHide();
    }, 6000);

    lsSetStatus(SYNC.online ? 'Загрузка с сервера' : 'Офлайн режим', 60);

    // 2) Сверка с сервером
    serverLoad().then(function (r) {
      if (booted) return;
      booted = true;
      clearTimeout(lsTimeout);
      
      var server = r && r.save;
      var hasServerData = server && server.data && server.data.charId &&
                          typeof CHARS !== 'undefined' && CHARS[server.data.charId];

      if (r && r.ok) {
        if (hasServerData) {
          // На сервере ЕСТЬ данные — загружаем их
          lsSetStatus('Загрузка с сервера', 70);
          
          // Разрешаем конфликты между локальными и серверными данными
          var finalData = resolveConflicts(local, server.data);
          
          // Сохраняем финальные данные в localStorage
          writeLocal(finalData);
          
          // Запускаем игру
          if (!SYNC.started) {
            bootFromSnapshot(finalData);
          } else {
            hotApply(finalData);
          }
          
          lsSetStatus('Готово', 90);
          
        } else {
          // НА СЕРВЕРЕ ПУСТО — проверяем localStorage
          if (local && local.charId && typeof CHARS !== 'undefined' && CHARS[local.charId]) {
            // Загружаем из localStorage и отправляем на сервер
            lsSetStatus('Восстановление', 50);
            bootFromSnapshot(local);
            if (SYNC.online) pushServer();
          } else {
            // Полностью новый игрок
            try {
              localStorage.removeItem(LS_KEY);
            } catch (e) {}
            
            lsSetStatus('Новый игрок', 50);
            
            stopCharSelectAnims();
            
            var cs = document.getElementById('charSelect');
            if (cs) {
              cs.classList.remove('hidden');
              if (typeof initCharSelect === 'function') {
                initCharSelect();
              }
              if (typeof window._csSelected === 'object') {
                window._csSelected = null;
              }
              if (typeof updateConfirmBtn === 'function') {
                updateConfirmBtn();
              }
            }
          }
        }
      } else {
        // Сервер вернул ошибку — используем localStorage
        if (local && local.charId && typeof CHARS !== 'undefined' && CHARS[local.charId]) {
          lsSetStatus('Офлайн загрузка', 40);
          bootFromSnapshot(local);
        }
      }
      
    }).catch(function (err) {
      if (booted) return;
      booted = true;
      clearTimeout(lsTimeout);
      
      console.warn('Server load failed:', err);
      
      // Если сервер не ответил — загружаем из localStorage (офлайн режим)
      if (local && local.charId && typeof CHARS !== 'undefined' && CHARS[local.charId]) {
        lsSetStatus('Офлайн загрузка', 40);
        bootFromSnapshot(local);
      } else {
        lsSetStatus('Ошибка загрузки', 40);
      }
      
      sendErrorLog({
        message: 'Server load failed in boot',
        error: err.message
      });
      
    }).then(function () {
      if (!SYNC.booted) {
        SYNC.booted = true;
        startSyncLoops();
        if (SYNC.online && SYNC.started) pushServer();
        lsHide();
      }
    });
  }

  // ───────────────────────────────
  //  ХУКИ: выбор персонажа + структурные действия
  // ───────────────────────────────
  function hookCharSelect() {
    var orig = window.confirmChar;
    if (typeof orig !== 'function') return;
    window.confirmChar = function () {
      var r = orig.apply(this, arguments);
      if (typeof G_CHAR === 'undefined' || !G_CHAR) return r;
      G.charId = G_CHAR.id;
      SYNC.started = true;
      stopCharSelectAnims();
      saveLocal();
      if (SYNC.online) {
        try {
          fetch(API + '/character', {
            method: 'POST', 
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ initData: TG_INIT, charId: G.charId }),
          }).catch(function() {});
        } catch (e) {}
        pushServer();
      }
      return r;
    };
  }

  // Дебаунс для saveLocal из updateHUD
  var _hudSaveTimer = null;
  function saveLocalDebounced() {
    if (_hudSaveTimer) return;
    _hudSaveTimer = setTimeout(function () { 
      _hudSaveTimer = null; 
      if (SYNC.started) saveLocal(); 
    }, 500);
  }

  function hookActions() {
    // Структурные действия — сохраняем сразу (debounce 1.2с на сервер)
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

    // updateHUD вызывается при каждом изменении HP/XP/золота
    var origHUD = window.updateHUD;
    if (typeof origHUD === 'function') {
      window.updateHUD = function () {
        var r = origHUD.apply(this, arguments);
        if (SYNC.started) saveLocalDebounced();
        return r;
      };
    }
  }

  // Установка хуков сразу (все скрипты выше уже загружены)
  hookCharSelect();
  hookActions();

  // Boot после полной загрузки
  if (document.readyState === 'complete') {
    boot();
  } else {
    window.addEventListener('load', boot);
  }

  // Публичный API
  window.GameSync = {
    save: pushServer,
    flush: flush,
    touch: touch,
    serialize: serializeState,
    apply: applySnapshot,
    resolveConflicts: resolveConflicts,
    state: SYNC,
  };
})();