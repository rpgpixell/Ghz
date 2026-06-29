// net.js — удаляем или комментируем всё, что связано с офлайн-режимом

(function () {
  'use strict';

  var API = (function() {
    var url = new URLSearchParams(window.location.search).get('api') || 
              window.ENV_API_URL || 
              'https://ghz-production.up.railway.app';
    return url.replace(/\/$/, '');
  })();

  var EQUIP_SLOTS = ['weapon', 'body', 'legs', 'gloves', 'belt', 'ring', 'boots', 'helmet'];
  
  var INSTANT_FIELDS = [
    'inventory', 'equipped', 'upg', 'skills', 
    'potionLv', 'potionThreshold', 'floor', 'level',
    'pixr', 'gram', 'bp', 'prem', 'marketUnlocked'
  ];

  var TG_INIT = '';
  var START_PARAM = '';

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
    lastLevel: 0,
    lastFloor: 0,
    lastPixr: 0,
  };

  var AUTH = {
    authorized: false,
    error: null
  };

  // ✅ УДАЛЯЕМ функции офлайн-режима
  // _showConnOverlay, _hideConnOverlay, _onConnLost, _onConnRestored, _schedulePing, _doPing

  // ✅ Новая функция: проверка соединения (простая, без офлайн-режима)
  function checkConnection() {
    if (!SYNC.online) {
      console.warn('⚠️ Нет соединения с сервером');
      showNoConnectionError();
      return false;
    }
    return true;
  }

  function showNoConnectionError() {
    var overlay = document.getElementById('connOverlay');
    if (overlay) overlay.classList.remove('hidden');
    // Блокируем игру
    if (typeof window.gameActive !== 'undefined') window.gameActive = false;
    if (typeof window._loopRunning !== 'undefined') window._loopRunning = false;
  }

  function hideConnectionError() {
    var overlay = document.getElementById('connOverlay');
    if (overlay) overlay.classList.add('hidden');
    // Возобновляем игру
    if (SYNC.started) {
      if (typeof window.gameActive !== 'undefined') window.gameActive = true;
      if (typeof window._loopRunning !== 'undefined' && !window._loopRunning) {
        if (typeof startGame === 'function') startGame();
      }
    }
  }

  // ═══════════════════════════════
  //  СЕРИАЛИЗАЦИЯ И СЖАТИЕ
  // ═══════════════════════════════

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
      arenaRating:         G.arenaRating || 1000,
      ore:                 Object.assign({ core:0, uore:0, rore:0, eore:0, lore:0 }, G.ore || {}),
      blessStones:         G.blessStones || 0,
      runes:               Object.assign({ crune:0, urune:0, rrune:0, erune:0, lrune:0 }, G.runes || {}),
      pvpAttempts:         G.pvpAttempts || 0,
      pvpAttemptsDate:     G.pvpAttemptsDate || '',
      pvpRefreshes:        G.pvpRefreshes || 0,
      pvpRefreshDate:      G.pvpRefreshDate || '',
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

    var d = s.data || s;
    if (d.data && typeof d.data === 'object' && !Array.isArray(d.data)) {
      d = d.data;
    }

    console.log('📦 [applySnapshot] Применяем данные:', Object.keys(d));

    if (d.charId && typeof CHARS !== 'undefined' && CHARS[d.charId]) {
      G_CHAR = CHARS[d.charId];
      G.charId = d.charId;
      if (typeof applyCharacterSprites === 'function') applyCharacterSprites(G_CHAR);
    }

    G.upg = Object.assign(
      { atk: 0, def: 0, hp: 0, spd: 0, crit: 0, dodge: 0, atkSpd: 0, critDmg: 0 },
      d.upg || {}
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
      var lvBonuses = num(d.level, 1) - 1;
      if (lvBonuses > 0) {
        G.baseStats.atk    = (G.baseStats.atk    || 0) + lvBonuses * 2;
        G.baseStats.def    = (G.baseStats.def    || 0) + lvBonuses * 1;
        G.baseStats.hp     = (G.baseStats.hp     || 0) + lvBonuses * 10;
        G.baseStats.atkSpd = parseFloat(
          ((G.baseStats.atkSpd || 1.0) + lvBonuses * 0.02).toFixed(4)
        );
      }
    } else if (d.baseStats) {
      G.baseStats = Object.assign({}, d.baseStats);
    }

    G.skills = d.skills || {};
    G.potionLv = num(d.potionLv, 0);
    G.potionThreshold = num(d.potionThreshold, 30);
    G.floor = num(d.floor, G.floor);
    G.level = num(d.level, G.level);
    G.maxFloor = num(d.maxFloor, G.maxFloor);
    G.pixr = num(d.pixr, G.pixr);
    G.gram = num(d.gram, G.gram);
    G.gold = num(d.gold, G.gold);
    G.xp = num(d.xp, G.xp);
    G.killCount = num(d.killCount, G.killCount);
    G.potions = num(d.potions, G.potions);

    G.bp = d.bp || { active: false, claimed: [] };
    if (!G.bp.claimed) G.bp.claimed = [];
    G.prem = d.prem || { tier: null, expiresAt: 0 };
    G.boss = d.boss || { floor: 1, lastFightTime: 0 };
    if (!G.boss.floor) G.boss.floor = 1;
    G.marketUnlocked = d.marketUnlocked || false;
    G.arenaRating    = typeof d.arenaRating === 'number' ? d.arenaRating : 1000;
    G.ore            = Object.assign({ core:0, uore:0, rore:0, eore:0, lore:0 }, d.ore || {});
    G.blessStones    = d.blessStones || 0;
    G.runes          = Object.assign({ crune:0, urune:0, rrune:0, erune:0, lrune:0 }, d.runes || {});
    G.pvpAttempts    = d.pvpAttempts    || 0;
    G.pvpAttemptsDate = d.pvpAttemptsDate || '';
    G.pvpRefreshes   = d.pvpRefreshes   || 0;
    G.pvpRefreshDate = d.pvpRefreshDate  || '';

    G.invFilter = d.invFilter || 'all';
    G.dailyTasks = d.dailyTasks || { date: '', seconds: 0, claimed: [] };
    G.specialTasksClaimed = d.specialTasksClaimed || {};

    G.inventory = (d.inventory || []).map(function (it) {
      var c = clone(it);
      c._equipped = false;
      return c;
    });

    if (typeof d.invIdCounter === 'number') _invIdCounter = d.invIdCounter;
    G.inventory.forEach(function (i) {
      if (typeof i.id === 'number' && i.id > _invIdCounter) _invIdCounter = i.id;
    });

    G.equipped = { 
      weapon: null, 
      body: null, 
      legs: null, 
      gloves: null, 
      belt: null, 
      ring: null, 
      boots: null, 
      helmet: null 
    };
    var eq = d.equipped || {};
    EQUIP_SLOTS.forEach(function (slot) {
      var id = eq[slot];
      if (id == null) return;
      var it = G.inventory.find(function (i) { return i.id === id; });
      if (it) {
        it._equipped = true;
        G.equipped[slot] = it;
      }
    });

    if (typeof recalcStats === 'function') recalcStats();

    G.maxHp = num(d.maxHp, G.maxHp);
    G.xpNeeded = num(d.xpNeeded, 0);
    if (!G.xpNeeded || G.xpNeeded < 100) {
      var _xp = 100;
      for (var _lv = 1; _lv < G.level; _lv++) {
        _xp = Math.floor(_xp * (_lv < 7 ? 2.5 : 1.1));
      }
      G.xpNeeded = _xp;
    }

    var hp = num(d.hp, G.maxHp);
    if (hp <= 0) hp = Math.floor(G.maxHp * 0.3);
    G.hp = Math.max(1, Math.min(hp, G.maxHp));

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

  // ═══════════════════════════════
  //  СЕРВЕРНЫЕ ЗАПРОСЫ (с проверкой соединения)
  // ═══════════════════════════════

  function serverLoad() {
    if (!SYNC.online) {
      showNoConnectionError();
      return Promise.reject(new Error('no_connection'));
    }

    var timeoutPromise = new Promise(function(_, reject) {
      setTimeout(function() { reject(new Error('timeout')); }, 10000);
    });

    var fetchPromise = fetch(API + '/api/load', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ initData: TG_INIT, startParam: START_PARAM }),
    }).then(function (r) {
      var ct = r.headers.get('content-type') || '';
      if (!ct.includes('application/json')) {
        console.warn('⚠️ [serverLoad] не-JSON ответ, статус:', r.status);
        return { ok: false };
      }
      return r.json();
    });

    return Promise.race([fetchPromise, timeoutPromise])
      .catch(function (e) { 
        console.error('❌ [serverLoad] ошибка:', e.message);
        showNoConnectionError();
        throw e; 
      });
  }

  // ═══════════════════════════════
  //  СОХРАНЕНИЕ (с проверкой соединения)
  // ═══════════════════════════════

  function serverSaveInstant(data) {
    if (!SYNC.online || !SYNC.serverConfirmed) {
      showNoConnectionError();
      return Promise.resolve({ ok: false, error: 'no_connection' });
    }

    var snap = serializeState();
    Object.keys(data).forEach(function(key) { snap[key] = data[key]; });
    snap.updatedAt = Date.now();

    return fetch(API + '/api/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ initData: TG_INIT, data: snap }),
    })
    .then(function(r) { return r.json(); })
    .then(function(r) {
      if (r && r.ok) {
        hideConnectionError();
        if (r.updatedAt) SYNC.lastServerTs = r.updatedAt;
      } else if (r && r.error === 'reset_detected') {
        console.warn('🛑 [instant] reset_detected — закрываем приложение');
        forceCloseApp();
      }
      return r;
    })
    .catch(function(e) {
      showNoConnectionError();
      throw e;
    });
  }

  function serverSaveBatch() {
    if (!SYNC.online || !SYNC.serverConfirmed || SYNC.pushing) {
      if (!SYNC.online) showNoConnectionError();
      return;
    }
    if (SYNC.rlBackoffUntil && Date.now() < SYNC.rlBackoffUntil) return;

    var currentHp        = G.hp;
    var currentGold      = G.gold;
    var currentXp        = G.xp;
    var currentKillCount = G.killCount;
    var currentPotions   = G.potions;
    var currentLevel     = G.level;
    var currentFloor     = G.floor;
    var currentPixr      = G.pixr;

    var delta = {
      tgId:      getTgId(),
      charId:    (typeof G_CHAR !== 'undefined' && G_CHAR) ? G_CHAR.id : (G.charId || null),
      updatedAt: Date.now(),
      cp:        (typeof calcCP === 'function') ? calcCP() : 0,
    };

    var hasChanges = false;

    if (currentHp        !== SYNC.lastHp)        { delta.hp        = currentHp;        hasChanges = true; }
    if (currentGold      !== SYNC.lastGold)      { delta.gold      = currentGold;      hasChanges = true; }
    if (currentXp        !== SYNC.lastXp)        { delta.xp        = currentXp;        hasChanges = true; }
    if (currentKillCount !== SYNC.lastKillCount) { delta.killCount = currentKillCount; hasChanges = true; }
    if (currentPotions   !== SYNC.lastPotions)   { delta.potions   = currentPotions;   hasChanges = true; }
    if (currentLevel     !== SYNC.lastLevel)     { delta.level     = currentLevel;     delta.xpNeeded = G.xpNeeded; hasChanges = true; }
    if (currentFloor     !== SYNC.lastFloor)     { delta.floor     = currentFloor;     delta.maxFloor = G.maxFloor; hasChanges = true; }
    if (currentPixr      !== SYNC.lastPixr)      { delta.pixr      = currentPixr;      hasChanges = true; }

    if (!hasChanges) return;

    SYNC.pushing = true;

    fetch(API + '/api/save/delta', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ initData: TG_INIT, delta: delta }),
    }).then(function (r) { return r.json(); })
      .then(function (r) {
        if (r && r.ok) {
          hideConnectionError();
          SYNC.lastHp        = currentHp;
          SYNC.lastGold      = currentGold;
          SYNC.lastXp        = currentXp;
          SYNC.lastKillCount = currentKillCount;
          SYNC.lastPotions   = currentPotions;
          SYNC.lastLevel     = currentLevel;
          SYNC.lastFloor     = currentFloor;
          SYNC.lastPixr      = currentPixr;
          SYNC.lastServerTs  = r.updatedAt || delta.updatedAt;
          SYNC.rlBackoffUntil = 0;

          if (r.sync) {
            console.log('🔄 [batch] Применяем серверный sync:', Object.keys(r.sync));
            if (r.sync.gram      !== undefined) G.gram      = r.sync.gram;
            if (r.sync.gold      !== undefined) G.gold      = r.sync.gold;
            if (r.sync.pixr      !== undefined) G.pixr      = r.sync.pixr;
            if (r.sync.inventory !== undefined) {
              G.inventory = r.sync.inventory;
              if (typeof renderInventory === 'function') renderInventory();
            }
            if (typeof updateHUD === 'function') updateHUD();
            if (typeof renderWallet === 'function') renderWallet();
            SYNC.lastGold = G.gold;
            SYNC.lastPixr = G.pixr;
          }
        } else if (r && r.error === 'reset_detected') {
          console.warn('🛑 [batch] reset_detected — закрываем приложение');
          forceCloseApp();
        } else if (r && r.error === 'rate_limit') {
          SYNC.rlBackoffUntil = Date.now() + 6000;
          console.warn('⚠️ [save] rate limit, пауза 6s');
        } else {
          // Ошибка на сервере
          console.warn('⚠️ [batch] Ошибка сохранения:', r);
          showNoConnectionError();
        }
      })
      .catch(function () { 
        showNoConnectionError(); 
      })
      .then(function () { SYNC.pushing = false; });
  }

  // ═══════════════════════════════
  //  СИНХРОНИЗАЦИЯ ИНВЕНТАРЯ (объединение)
  // ═══════════════════════════════

  function syncInventoryFromServer(rawInventory) {
    var serverItems = {};
    (rawInventory || []).forEach(function(item) {
      if (!item.isOre) {
        var copy = Object.assign({}, item);
        copy._equipped = false;
        serverItems[copy.id] = copy;
      }
    });

    var localItems = {};
    G.inventory.forEach(function(item) {
      if (!item.isOre) {
        if (serverItems[item.id]) {
          var serverItem = serverItems[item.id];
          localItems[item.id] = Object.assign({}, serverItem, {
            _equipped: item._equipped || false
          });
          delete serverItems[item.id];
        } else {
          // Сохраняем локальный предмет, если его нет на сервере
          // (это может быть оптимистичное обновление)
          localItems[item.id] = item;
        }
      }
    });

    var mergedInventory = Object.values(localItems).concat(Object.values(serverItems));
    G.inventory = mergedInventory;

    var SLOTS = ['weapon', 'body', 'legs', 'gloves', 'boots', 'helmet', 'ring', 'belt'];
    var equippedCopy = {};
    SLOTS.forEach(function(slot) {
      var currentEquipped = G.equipped[slot];
      if (currentEquipped) {
        var foundItem = G.inventory.find(function(item) { return item.id === currentEquipped.id; });
        if (foundItem) {
          foundItem._equipped = true;
          equippedCopy[slot] = foundItem;
        } else {
          equippedCopy[slot] = null;
        }
      } else {
        equippedCopy[slot] = null;
      }
    });
    G.equipped = equippedCopy;

    if (typeof recalcStats === 'function') recalcStats();
    if (typeof updateHUD === 'function') updateHUD();
  }

  // ═══════════════════════════════
  //  ПОЛЛИНГ (с проверкой соединения)
  // ═══════════════════════════════

  var pollTimer = null;
  var isPolling = false;
  var lastEventId = 0;

  function startPolling() {
    if (!SYNC.started || !SYNC.online) {
      if (!SYNC.online) showNoConnectionError();
      return;
    }
    if (pollTimer) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
    console.log('🔄 [Poll] Запуск опроса...');
    doPoll();
  }

  function doPoll() {
    if (!SYNC.started || !SYNC.online) {
      if (!SYNC.online) showNoConnectionError();
      return;
    }
    if (isPolling) return;

    var tgId = getTgId();
    if (!tgId) {
      pollTimer = setTimeout(doPoll, 9000);
      return;
    }

    isPolling = true;

    fetch(API + '/api/poll', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        initData: TG_INIT,
        lastEventId: lastEventId
      })
    })
    .then(function(r) { 
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json(); 
    })
    .then(function(response) {
      isPolling = false;
      lastEventId = response.timestamp || Date.now();
      hideConnectionError();

      if (response.ok && response.notifications && response.notifications.length > 0) {
        console.log('📨 [Poll] Получено ' + response.notifications.length + ' уведомлений');
        response.notifications.forEach(function(notification) {
          if (notification.event === 'force_close') {
            console.warn('🚪 [Poll] Команда закрытия от сервера — сброс прогресса');
            forceCloseApp();
            return;
          } else if (notification.event === 'reload') {
            console.log('🔄 [Poll] Обновление данных с сервера...');
            if (typeof window.forceReload === 'function') {
              window.forceReload().then(function(success) {
                if (success) {
                  if (typeof renderWallet === 'function') renderWallet();
                  if (typeof updateHUD === 'function') updateHUD();
                }
              });
            } else {
              location.reload();
            }
          } else if (notification.event === 'market_sold' || notification.event === 'market_expired') {
            if (typeof window._handleMarketNotif === 'function') {
              window._handleMarketNotif(notification.event, notification.data || {});
            }
          }
        });
      }

      if (SYNC.started && SYNC.online) {
        pollTimer = setTimeout(doPoll, 9000);
      }
    })
    .catch(function(error) {
      isPolling = false;
      console.error('❌ [Poll] Ошибка:', error.message);
      showNoConnectionError();
      if (SYNC.started && SYNC.online) {
        pollTimer = setTimeout(doPoll, 9000);
      }
    });
  }

  function stopPolling() {
    if (pollTimer) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
    isPolling = false;
    console.log('🛑 [Poll] Остановлен');
  }

  // ═══════════════════════════════
  //  ПРИНУДИТЕЛЬНАЯ ПЕРЕЗАГРУЗКА
  // ═══════════════════════════════

  function forceCloseApp() {
    console.warn('🚪 [forceClose] Закрываем приложение по команде сервера');
    SYNC.serverConfirmed = false;
    SYNC.started = false;
    if (typeof window.gameActive !== 'undefined') window.gameActive = false;
    if (typeof window._loopRunning !== 'undefined') window._loopRunning = false;
    try {
      if (window.Telegram && window.Telegram.WebApp && typeof window.Telegram.WebApp.close === 'function') {
        window.Telegram.WebApp.close();
        return;
      }
    } catch (e) {}
    var ls = document.getElementById('loadingScreen');
    if (ls) {
      ls.style.display = '';
      ls.style.pointerEvents = 'all';
      ls.classList.remove('fade-out', 'hidden-done');
      var statusEl = document.getElementById('lsStatus');
      if (statusEl) {
        statusEl.innerHTML = '<span style="color:#f5c542;font-size:13px;">⚠️ Прогресс был сброшен администратором</span>' +
          '<br><span style="font-size:11px;color:#888;margin-top:6px;display:block;">Перезапустите игру</span>';
      }
      var barFill = document.getElementById('lsBar');
      if (barFill) barFill.style.width = '0%';
    }
  }

  window.forceReload = function() {
    console.log('🔄 [forceReload] Запрос обновления данных...');
    return serverLoad().then(function(r) {
      if (r && r.ok && r.save && r.save.data) {
        console.log('✅ [forceReload] Данные получены, применяем...');
        applySnapshot(r.save.data);
        if (typeof updateHUD === 'function') updateHUD();
        if (typeof renderInventory === 'function') renderInventory();
        if (typeof renderWallet === 'function') renderWallet();
        if (typeof updatePotionHud === 'function') updatePotionHud();
        if (typeof switchTab === 'function') switchTab(activeTab);
        console.log('✅ [forceReload] Готово! GRAM:', G.gram);
        return true;
      } else {
        console.warn('⚠️ [forceReload] Не удалось загрузить данные');
        return false;
      }
    }).catch(function(e) {
      console.error('❌ [forceReload] Ошибка:', e.message);
      return false;
    });
  };

  // ═══════════════════════════════
  //  ЭКРАН ВЫБОРА ПЕРСОНАЖА
  // ═══════════════════════════════

  function stopCharSelectAnims() {
    try { if (typeof _csSpriteTimers !== 'undefined') Object.keys(_csSpriteTimers).forEach(function (k) { clearInterval(_csSpriteTimers[k]); }); } catch (e) {}
    try { if (typeof _csParticleTimer !== 'undefined' && _csParticleTimer) cancelAnimationFrame(_csParticleTimer); } catch (e) {}
  }
  
  function hideCharSelect() {
    var cs = document.getElementById('charSelect');
    if (cs) cs.classList.add('hidden');
    stopCharSelectAnims();
  }

  // ═══════════════════════════════
  //  СТАРТ ИЗ СНАПШОТА
  // ═══════════════════════════════

  function bootFromSnapshot(snap) {
    if (SYNC.started) return;
    var data = snap.data || snap;
    if (data.data && typeof data.data === 'object' && !Array.isArray(data.data)) {
      data = data.data;
    }
    if (!applySnapshot(data)) return;
    hideCharSelect();
    SYNC.started = true;
    if (typeof startGame === 'function') {
      if (typeof window._loopRunning === 'undefined' || !window._loopRunning) {
        startGame();
      } else {
        if (typeof updateHUD === 'function') updateHUD();
        if (typeof initSkillsHud === 'function') initSkillsHud();
        if (typeof updatePotionHud === 'function') updatePotionHud();
      }
    }
    setTimeout(startPolling, 2000);
  }

  function hotApply(snap) {
    if (!applySnapshot(snap)) return;
    if (typeof updateHUD === 'function') updateHUD();
    if (typeof initSkillsHud === 'function') initSkillsHud();
    if (typeof updatePotionHud === 'function') updatePotionHud();
    try { if (typeof switchTab === 'function' && typeof activeTab !== 'undefined') switchTab(activeTab); } catch (e) {}
  }

  // ═══════════════════════════════
  //  СИНХРОНИЗАЦИЯ — 10 СЕКУНД
  // ═══════════════════════════════

  function startSyncLoops() {
    if (SYNC.booted) return;
    SYNC.batchTimer = setInterval(serverSaveBatch, 10000);

    document.addEventListener('visibilitychange', function () {
      if (document.hidden) {
        // При сворачивании сохраняем всё
        var snap = serializeState();
        snap.updatedAt = Date.now();
        try {
          fetch(API + '/api/save', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ initData: TG_INIT, data: snap }),
            keepalive: true,
          });
        } catch (e) {}
      }
    });

    if (window.Telegram && window.Telegram.WebApp) {
      try { window.Telegram.WebApp.onEvent('close', function() {
        var snap = serializeState();
        snap.updatedAt = Date.now();
        try {
          fetch(API + '/api/save', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ initData: TG_INIT, data: snap }),
            keepalive: true,
          });
        } catch (e) {}
      }); } catch (e) {}
    }

    window.addEventListener('pagehide', function() {
      var snap = serializeState();
      snap.updatedAt = Date.now();
      try {
        fetch(API + '/api/save', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ initData: TG_INIT, data: snap }),
          keepalive: true,
        });
      } catch (e) {}
    });
  }

  // ═══════════════════════════════
  //  СБРОС К ЭКРАНУ ВЫБОРА
  // ═══════════════════════════════

  function resetToCharSelect() {
    if (typeof gameActive !== 'undefined') window.gameActive = false;
    if (typeof G_CHAR !== 'undefined') window.G_CHAR = null;
    
    stopPolling();
    
    try { if (typeof G !== 'undefined') {
      G.charId = null;
      G.gold = 0; G.pixr = 0; G.gram = 0;
      G.level = 1; G.xp = 0; G.floor = 1; G.maxFloor = 1; G.killCount = 0;
      G.inventory = []; G.equipped = {};
      G.upg = { atk:0, def:0, hp:0, spd:0, crit:0, dodge:0, atkSpd:0 };
      G.bp = { active: false, claimed: [] };
      G.prem = { tier: null, expiresAt: 0 };
      G.skills = {};
      G.potions = 0;
      G.potionLv = 0;
      G.dailyTasks = { date: '', seconds: 0, claimed: [] };
      G.specialTasksClaimed = {};
    }} catch(e) {}
    if (typeof _invIdCounter !== 'undefined') window._invIdCounter = 0;
    
    var cs = document.getElementById('charSelect');
    if (cs) cs.classList.remove('hidden');
    var canvas = document.getElementById('gameCanvas');
    if (canvas) canvas.style.display = 'none';
    var skillsHud = document.getElementById('skillsHud');
    if (skillsHud) skillsHud.classList.remove('visible');
  }

  // ═══════════════════════════════
  //  BOOT
  // ═══════════════════════════════

  function initTelegram() {
    if (window.Telegram && window.Telegram.WebApp) {
      try { window.Telegram.WebApp.ready(); } catch (e) {}
      try { window.Telegram.WebApp.expand(); } catch (e) {}
      try { window.Telegram.WebApp.disableVerticalSwipes && window.Telegram.WebApp.disableVerticalSwipes(); } catch (e) {}
      TG_INIT = window.Telegram.WebApp.initData || '';
      try {
        START_PARAM = (window.Telegram.WebApp.initDataUnsafe && window.Telegram.WebApp.initDataUnsafe.start_param) || '';
      } catch (e) { START_PARAM = ''; }
      
      if (!TG_INIT) {
        AUTH.authorized = false;
        AUTH.error = 'Нет данных авторизации (initData)';
        console.warn('⚠️ [initTelegram] Нет initData');
      } else {
        AUTH.authorized = true;
      }
    } else {
      AUTH.authorized = false;
      AUTH.error = 'Игра запущена не через Telegram WebApp';
      console.warn('⚠️ [initTelegram] Telegram.WebApp не найден');
    }
    
    if (!START_PARAM) {
      try {
        var urlParams = new URLSearchParams(window.location.search);
        var start = urlParams.get('start');
        var startapp = urlParams.get('startapp');
        var ref = urlParams.get('ref');
        
        if (start) START_PARAM = start;
        else if (startapp) START_PARAM = startapp;
        else if (ref) START_PARAM = ref;
        
        console.log('🔍 [initTelegram] startParam из URL:', START_PARAM || 'none');
      } catch (e) {}
    }
    
    SYNC.online = AUTH.authorized && !!TG_INIT;
    
    var tgId = getTgId();
    if (tgId) {
      SYNC.currentTgId = tgId;
    }
    console.log('🟢 [initTelegram] Пользователь:', tgId, 'Online:', SYNC.online, 'startParam:', START_PARAM || 'none');
  }

  function boot() {
    lsInitStars();
    lsSetStatus('Подключение', 10);
    initTelegram();

    if (!AUTH.authorized) {
      console.warn('⚠️ [boot] Нет авторизации в Telegram:', AUTH.error);
      _showNoServerError('Открой игру в Telegram');
      return;
    }

    function _bootFinalize() {
      try {
        startSyncLoops();
        SYNC.booted = true;
        if (SYNC.online && SYNC.started && SYNC.serverConfirmed) {
          serverSaveBatch();
        }
      } catch (e) {
        console.error('❌ [boot] finalize error:', e.message);
      }
      lsHide();
    }

    lsSetStatus(SYNC.online ? 'Загрузка с сервера' : 'Нет соединения', 30);

    var _pct = 30;
    var _progressTimer = SYNC.online ? setInterval(function () {
      if (_pct < 85) { _pct += 1; lsSetStatus('Загрузка с сервера', _pct); }
    }, 300) : null;

    function _stopProgress() {
      if (_progressTimer) { clearInterval(_progressTimer); _progressTimer = null; }
    }

    serverLoad().then(function (r) {
      _stopProgress();

      if (!r || !r.ok) {
        console.warn('⚠️ [serverLoad] ответ не ok:', r);
        _showNoServerError('Сервер недоступен');
        return;
      }

      var server = r.save;
      var currentTgId = getTgId();

      if (server && server.data && server.data.tgId && currentTgId && server.data.tgId !== currentTgId) {
        console.warn('⚠️ Сервер вернул данные другого пользователя, игнорируем');
        _showNoServerError('Ошибка идентификации. Повторите попытку.');
        return;
      }

      if (server && server.data && server.data.charId &&
          typeof CHARS !== 'undefined' && CHARS[server.data.charId]) {

        SYNC.serverConfirmed = true;
        lsSetStatus('Применение данных', 90);

        if (!SYNC.started) {
          bootFromSnapshot(server.data);
          setTimeout(function () { _bootFinalize(); }, 300);
        } else {
          hotApply(server.data);
          setTimeout(function () { _bootFinalize(); }, 300);
        }
      } else if (!server || !server.data) {
        _bootFinalize();
      } else {
        _bootFinalize();
      }
    }).catch(function (err) {
      _stopProgress();
      console.error('❌ [boot] serverLoad ошибка:', err.message);
      _showNoServerError('Нет соединения с сервером');
    });
  }

  function _showNoServerError(customMsg) {
    var msg = customMsg || 'Нет соединения с сервером';

    var statusEl = document.getElementById('lsStatus');
    if (statusEl) {
      statusEl.innerHTML =
        '<span style="color:#e74c3c;font-size:13px;">❌ ' + msg + '</span>' +
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
      btn.className = 'ls-retry-btn';
      btn.textContent = '🔄 ПОВТОРИТЬ';
      btn.style.cssText = [
        'margin-top:16px',
        'padding:10px 28px',
        'background:#0d0d1a',
        'border:2px solid #f5c542',
        'border-radius:10px',
        'color:#f5c542',
        'font-size:13px',
        'font-family:"Courier New",monospace',
        'letter-spacing:1px',
        'cursor:pointer',
        'display:block',
        'width:160px',
        'margin-left:auto',
        'margin-right:auto',
        'box-shadow:0 0 12px rgba(245,197,66,0.25)',
      ].join(';');
      btn.onclick = function() { location.reload(); };
      barWrap.parentNode.insertBefore(btn, barWrap.nextSibling);
    }

    var ls = document.getElementById('loadingScreen');
    if (ls) {
      ls.style.display = '';
      ls.style.pointerEvents = 'all';
      ls.classList.remove('fade-out');
      ls.classList.remove('hidden-done');
    }
  }

  // ═══════════════════════════════
  //  ХУКИ
  // ═══════════════════════════════

  function hookCharSelect() {
    var orig = window.confirmChar;
    if (typeof orig !== 'function') return;
    window.confirmChar = function () {
      if (!SYNC.online) {
        _showNoServerError('Нет соединения с сервером');
        return;
      }
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
        serverSaveInstant({
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

  function hookActions() {
    var instantActions = [
      'buyUpgrade',
      'equipItem', 'unequipItem', 'destroyItem', 'refineItem',
      'useSkillBook', 'buyBattlePass', 'claimBpReward', 'buyPrem',
      'upgPotion', 'goToFloor', 'buyPotions'
    ];
    
    instantActions.forEach(function (name) {
      var fn = window[name];
      if (typeof fn !== 'function') return;
      window[name] = function () {
        if (!SYNC.online) {
          showNoConnectionError();
          return;
        }
        var r = fn.apply(this, arguments);
        try {
          var snap = serializeState();
          var data = {};
          INSTANT_FIELDS.forEach(function(field) {
            if (snap[field] !== undefined) data[field] = snap[field];
          });
          saveInstant(data);
        } catch (e) {}
        return r;
      };
    });
  }

  // ═══════════════════════════════
  //  ЭКСПОРТ ДЛЯ ИГРОВЫХ СОБЫТИЙ
  // ═══════════════════════════════

  window.onPixrDrop = function(amount) {
    G.pixr = (G.pixr || 0) + amount;
    saveInstant({ pixr: G.pixr });
  };

  window.onExchangePixr = function() {
    saveInstant({ pixr: G.pixr, gram: G.gram });
  };

  window.onItemDrop = function(item) {
    G.inventory.push(item);
    saveInstant({ inventory: G.inventory });
  };

  window.onEquip = function(item) {
    saveInstant({ equipped: G.equipped });
  };

  window.onUpgrade = function(upgId, newLevel) {
    saveInstant({ upg: G.upg });
  };

  window.onSkillUpgrade = function(skillId, newLevel) {
    saveInstant({ skills: G.skills });
  };

  window.onLevelUp = function() {
    saveInstant({ level: G.level, xpNeeded: G.xpNeeded });
  };

  window.onFloorChange = function(newFloor) {
    saveInstant({ floor: G.floor, maxFloor: G.maxFloor });
  };

  window.GameSync = {
    save:        serverSaveBatch,
    flush:       function() { /* flush при закрытии */ },
    touch:       function() { /* touch больше не нужен */ },
    serialize:   serializeState,
    apply:       applySnapshot,
    state:       SYNC,
    getTgId:     getTgId,
    saveInstant: serverSaveInstant,
    syncInventory: syncInventoryFromServer,
    _API:        API,
    get _INIT() { return TG_INIT; },
    checkConnection: checkConnection,
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