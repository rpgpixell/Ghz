/*
  ══════════════════════════════════════════════════════
  api.js — Авторизация и сохранение прогресса
  Порядок подключения: после state.js, до render.js

  API.init()          — auth + load save → { isNew, charId }
  API.saveLocal()     — быстрое сохранение в localStorage
  API.saveServer()    — отправка на сервер (keepalive)
  API.saveCritical()  — saveLocal + saveServer одновременно
  ══════════════════════════════════════════════════════
*/

var API = (function() {

  var BASE_URL  = 'https://ghz-production.up.railway.app';
  var LS_KEY    = 'ghz_save_v1';
  var TOKEN_KEY = 'ghz_token';

  var _token    = null;
  var _saveTimer = null;
  var _pendingSave = false;

  // ── Поля G которые сохраняем ──
  var SAVE_FIELDS = [
    'gold', 'pixr', 'gram', 'level', 'xp', 'xpNeeded',
    'floor', 'maxFloor', 'killCount',
    'stats', 'hp', 'maxHp',
    'upg', 'potionLv', 'potionThreshold', 'potions',
    'bp', 'prem',
    'owned', 'skills', 'inventory', 'equipped', 'baseStats',
  ];

  // ── Сериализация G (только нужные поля) ──
  function serializeG() {
    var state = {};
    SAVE_FIELDS.forEach(function(k) {
      if (k in G) state[k] = G[k];
    });
    // Восстанавливаем _invIdCounter из инвентаря при загрузке
    state._invIdCounter = typeof _invIdCounter !== 'undefined' ? _invIdCounter : 0;
    return state;
  }

  // ── Применение загруженного стейта в G ──
  function applyState(state) {
    if (!state) return;
    SAVE_FIELDS.forEach(function(k) {
      if (k in state) G[k] = state[k];
    });
    // Восстановить счётчик предметов
    if (state._invIdCounter) {
      if (typeof _invIdCounter !== 'undefined') {
        _invIdCounter = state._invIdCounter;
      }
      // Также ищем максимальный id среди предметов на случай расхождения
      if (G.inventory && G.inventory.length) {
        var maxId = G.inventory.reduce(function(m, i) { return Math.max(m, i.id || 0); }, 0);
        if (typeof _invIdCounter !== 'undefined' && maxId > _invIdCounter) {
          _invIdCounter = maxId;
        }
      }
    }
    // hp не должен превышать maxHp после загрузки
    if (G.hp > G.maxHp) G.hp = G.maxHp;
  }

  // ══════════════════════════════════════════════
  //  ЛОКАЛЬНОЕ СОХРАНЕНИЕ
  // ══════════════════════════════════════════════
  function saveLocal() {
    try {
      var data = {
        charId:    typeof G_CHAR !== 'undefined' && G_CHAR ? G_CHAR.id : null,
        gameState: serializeG(),
        savedAt:   Date.now(),
      };
      localStorage.setItem(LS_KEY, JSON.stringify(data));
    } catch (e) {
      console.warn('[API] saveLocal error:', e);
    }
  }

  function loadLocal() {
    try {
      var raw = localStorage.getItem(LS_KEY);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (e) {
      return null;
    }
  }

  // ══════════════════════════════════════════════
  //  СОХРАНЕНИЕ НА СЕРВЕР
  // ══════════════════════════════════════════════
  function saveServer(useKeepalive) {
    if (!_token) return;
    try {
      var body = JSON.stringify({
        charId:    typeof G_CHAR !== 'undefined' && G_CHAR ? G_CHAR.id : null,
        gameState: serializeG(),
      });
      fetch(BASE_URL + '/save', {
        method:   'POST',
        headers:  {
          'Content-Type':  'application/json',
          'Authorization': 'Bearer ' + _token,
        },
        body:     body,
        keepalive: !!useKeepalive,
      }).catch(function(e) {
        console.warn('[API] saveServer error:', e);
      });
    } catch (e) {
      console.warn('[API] saveServer exception:', e);
    }
  }

  // ══════════════════════════════════════════════
  //  КРИТИЧЕСКОЕ СОХРАНЕНИЕ (local + server)
  // ══════════════════════════════════════════════
  function saveCritical() {
    saveLocal();
    saveServer(false);
  }

  // ══════════════════════════════════════════════
  //  AUTH → LOAD
  // ══════════════════════════════════════════════
  function init() {
    return new Promise(function(resolve) {

      // Получаем initData из Telegram SDK
      var initData = '';
      var devMode  = false;
      if (window.Telegram && window.Telegram.WebApp && window.Telegram.WebApp.initData) {
        initData = window.Telegram.WebApp.initData;
      } else {
        // Dev-режим вне Telegram
        devMode = true;
        console.warn('[API] No Telegram initData — dev mode');
      }

      var authBody;
      if (devMode) {
        // В dev-режиме используем случайный userId из localStorage чтобы не терять сейв
        var devId = localStorage.getItem('ghz_dev_id');
        if (!devId) { devId = 'dev_' + Math.floor(Math.random() * 999999); localStorage.setItem('ghz_dev_id', devId); }
        authBody = JSON.stringify({ initData: '', devUserId: devId, devUsername: 'DevPlayer' });
      } else {
        authBody = JSON.stringify({ initData: initData });
      }

      // Auth request
      fetch(BASE_URL + '/auth', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    authBody,
      })
      .then(function(r) { return r.json(); })
      .then(function(authRes) {
        if (!authRes.ok || !authRes.token) {
          throw new Error('Auth failed: ' + (authRes.error || 'unknown'));
        }
        _token = authRes.token;
        sessionStorage.setItem(TOKEN_KEY, _token);

        // Load save from server
        return fetch(BASE_URL + '/load', {
          headers: { 'Authorization': 'Bearer ' + _token },
        });
      })
      .then(function(r) { return r.json(); })
      .then(function(loadRes) {
        if (loadRes.found && loadRes.gameState) {
          // Сервер вернул сейв — применяем
          applyState(loadRes.gameState);
          _startAutoSave();
          resolve({ isNew: false, charId: loadRes.charId });
        } else {
          // Попробуем localStorage как fallback
          var local = loadLocal();
          if (local && local.gameState) {
            applyState(local.gameState);
            _startAutoSave();
            resolve({ isNew: false, charId: local.charId });
          } else {
            _startAutoSave();
            resolve({ isNew: true, charId: null });
          }
        }
      })
      .catch(function(e) {
        console.error('[API] init error:', e);
        // Сервер недоступен — пробуем localStorage
        var local = loadLocal();
        if (local && local.gameState) {
          applyState(local.gameState);
          _startAutoSave();
          resolve({ isNew: false, charId: local.charId });
        } else {
          _startAutoSave();
          resolve({ isNew: true, charId: null });
        }
      });
    });
  }

  // ══════════════════════════════════════════════
  //  AUTO-SAVE каждые 30 секунд
  // ══════════════════════════════════════════════
  function _startAutoSave() {
    if (_saveTimer) clearInterval(_saveTimer);
    _saveTimer = setInterval(function() {
      // Сохраняем только если игра уже запущена (G_CHAR задан)
      if (typeof G_CHAR !== 'undefined' && G_CHAR) {
        saveServer(false);
      }
    }, 30000);
  }

  // ══════════════════════════════════════════════
  //  СОХРАНЕНИЕ ПРИ УХОДЕ ИЗ ПРИЛОЖЕНИЯ
  // ══════════════════════════════════════════════

  // visibilitychange — надёжнее всего в Telegram WebApp
  document.addEventListener('visibilitychange', function() {
    if (document.visibilityState === 'hidden') {
      if (typeof G_CHAR !== 'undefined' && G_CHAR) {
        saveLocal();          // мгновенно
        saveServer(true);     // keepalive — успеет уйти после закрытия
      }
    }
  });

  // pagehide — iOS Safari / Telegram iOS
  window.addEventListener('pagehide', function() {
    if (typeof G_CHAR !== 'undefined' && G_CHAR) {
      saveLocal();
    }
  });

  // beforeunload — десктоп / Android Chrome
  window.addEventListener('beforeunload', function() {
    if (typeof G_CHAR !== 'undefined' && G_CHAR) {
      saveLocal();
    }
  });

  // ── Public API ──
  return {
    init:          init,
    saveLocal:     saveLocal,
    saveServer:    saveServer,
    saveCritical:  saveCritical,
  };

})();
