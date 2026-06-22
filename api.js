/*
  ══════════════════════════════════════════════════════
  api.js — Клиентский модуль сохранения/загрузки
  Pixel Runner RPG

  СТРАТЕГИЯ СОХРАНЕНИЙ (С MERGE):
  1. localStorage — мгновенное сохранение при каждом изменении
  2. Сервер — сохранение каждые 30 секунд
  3. При загрузке: берем НОВЕЙШЕЕ (сервер vs локальное)
  4. При закрытии: только localStorage (гарантированно!)

  API.init()          — загрузка (merge сервер + локальное)
  API.save()          — сохранение на сервер (каждые 30 сек)
  API.saveLocal()     — мгновенное сохранение в localStorage
  API.partial()       — частичное обновление (сервер + кэш)
  API.markDirty()     — пометить для серверного сохранения
  ══════════════════════════════════════════════════════
*/

const API = (function() {
  'use strict';

  const BASE_URL = 'https://ghz-production.up.railway.app';
  const LS_KEY = 'pixelrpg_save';

  let _initData = '';
  let _userId = '';
  let _photoUrl = '';
  let _firstName = '';
  let _saveTimer = null;
  let _dirty = false;
  let _savedHp = null;
  let _isSaving = false;

  function getInitData() {
    if (window.Telegram && window.Telegram.WebApp && window.Telegram.WebApp.initData) {
      return window.Telegram.WebApp.initData;
    }
    var urlParams = new URLSearchParams(window.location.search);
    return urlParams.get('initData') || '';
  }

  // ── fetch с авторизацией ──
  async function apiFetch(path, opts) {
    opts = opts || {};
    opts.headers = opts.headers || {};
    if (_initData) opts.headers['Authorization'] = 'tma ' + _initData;
    opts.headers['Content-Type'] = 'application/json';
    var res = await fetch(BASE_URL + path, opts);
    if (!res.ok) {
      var body = await res.json().catch(function() { return {}; });
      throw new Error(body.error || 'HTTP ' + res.status);
    }
    return res.json();
  }

  // ══════════════════════════════════════════════════════
  //  LOCAL STORAGE (мгновенное сохранение)
  // ══════════════════════════════════════════════════════

  function writeLocal(snapshot) {
    try {
      var key = _userId ? LS_KEY + '_' + _userId : LS_KEY;
      // ✅ Добавляем timestamp для сравнения
      var data = {
        data: snapshot,
        timestamp: Date.now(),
        userId: _userId
      };
      localStorage.setItem(key, JSON.stringify(data));
      return true;
    } catch(e) {
      console.warn('[API] Local save failed:', e.message);
      return false;
    }
  }

  function readLocal() {
    try {
      var key = _userId ? LS_KEY + '_' + _userId : LS_KEY;
      var raw = localStorage.getItem(key);
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      return {
        data: parsed.data,
        timestamp: parsed.timestamp || 0
      };
    } catch(e) {
      return null;
    }
  }

  function clearLocal() {
    try {
      var key = _userId ? LS_KEY + '_' + _userId : LS_KEY;
      localStorage.removeItem(key);
    } catch(e) {}
  }

  // ══════════════════════════════════════════════════════
  //  MERGE — берем новейшее
  // ══════════════════════════════════════════════════════

  function mergeSaves(serverSave, localData) {
    // Если нет локального — берем сервер
    if (!localData) {
      console.log('[API] No local save, using server');
      return serverSave;
    }
    
    // Если нет серверного — берем локальное
    if (!serverSave) {
      console.log('[API] No server save, using local');
      return localData.data;
    }
    
    // ✅ Сравниваем по timestamp
    var localTs = localData.timestamp || 0;
    var serverTs = serverSave._ts || 0;
    
    if (localTs > serverTs) {
      console.log('[API] Using LOCAL save (newer by ' + Math.round((localTs - serverTs) / 1000) + 's)');
      return localData.data;
    }
    
    console.log('[API] Using SERVER save (newer or equal)');
    return serverSave;
  }

  // ══════════════════════════════════════════════════════
  //  ПРИМЕНЕНИЕ СОХРАНЕНИЯ
  // ══════════════════════════════════════════════════════

  function applySave(save) {
    if (!save) return null;

    var scalars = [
      'gold','pixr','gram','level','xp','xpNeeded',
      'floor','maxFloor','killCount',
      'potionLv','potions','potionThreshold',
    ];
    scalars.forEach(function(k) {
      if (save[k] !== undefined && save[k] !== null) G[k] = save[k];
    });

    if (save.hp !== undefined && save.hp !== null) {
      _savedHp = { hp: save.hp, maxHp: save.maxHp };
    }

    if (save.baseStats) Object.assign(G.baseStats, save.baseStats);
    if (save.stats)     Object.assign(G.stats,     save.stats);
    if (save.upg)       Object.assign(G.upg,       save.upg);
    if (save.equipped)  Object.assign(G.equipped,  save.equipped);

    if (save.bp)   G.bp   = { active: !!save.bp.active, claimed: save.bp.claimed || [] };
    if (save.prem) G.prem = { tier: save.prem.tier || null, expiresAt: save.prem.expiresAt || 0 };

    if (Array.isArray(save.inventory))                G.inventory = save.inventory;
    if (save.skills && typeof save.skills === 'object') G.skills   = save.skills;

    return save.charId || null;
  }

  function buildSnapshot() {
    return {
      charId:    window.G_CHAR ? window.G_CHAR.id : null,
      gold:      G.gold,
      pixr:      G.pixr,
      gram:      G.gram,
      level:     G.level,
      xp:        G.xp,
      xpNeeded:  G.xpNeeded,
      floor:     G.floor,
      maxFloor:  G.maxFloor,
      killCount: G.killCount,
      hp:        G.hp,
      maxHp:     G.maxHp,
      baseStats: Object.assign({}, G.baseStats),
      stats:     Object.assign({}, G.stats),
      upg:       Object.assign({}, G.upg),
      potionLv:  G.potionLv  || 0,
      potions:   G.potions   || 0,
      potionThreshold: G.potionThreshold || 30,
      bp:        { active: G.bp.active, claimed: G.bp.claimed.slice() },
      prem:      { tier: G.prem.tier, expiresAt: G.prem.expiresAt },
      inventory: G.inventory.slice(),
      equipped:  Object.assign({}, G.equipped),
      skills:    Object.assign({}, G.skills),
      _ts:       Date.now(),  // ✅ timestamp для сравнения
    };
  }

  // ══════════════════════════════════════════════════════
  //  ПУБЛИЧНОЕ API
  // ══════════════════════════════════════════════════════

  async function init() {
    _initData = getInitData();
    if (!_initData) {
      console.warn('[API] No initData');
      return null;
    }

    try {
      var res = await apiFetch('/auth', {
        method: 'POST',
        body: JSON.stringify({ initData: _initData }),
      });
      
      _userId    = res.userId;
      _photoUrl  = res.photoUrl  || '';
      _firstName = res.firstName || '';
      console.log('[API] Auth OK userId=' + _userId);

      var serverSave = res.save;
      
      // ✅ Читаем локальное сохранение
      var localData = readLocal();
      
      // ✅ MERGE — берем новейшее
      var bestSave = mergeSaves(serverSave, localData);
      var charId = applySave(bestSave);
      
      // ✅ Если взяли локальное — отправляем на сервер
      if (localData && localData.timestamp > (serverSave?._ts || 0)) {
        console.log('[API] Local is newer, syncing to server...');
        // Отправляем асинхронно
        setTimeout(function() {
          save().catch(function(e) {
            console.warn('[API] Sync to server failed:', e.message);
          });
        }, 1000);
      }
      
      // ✅ Обновляем локальное сохранение (кэш)
      writeLocal(buildSnapshot());

      // ✅ Серверное сохранение каждые 30 секунд
      _saveTimer = setInterval(function() {
        if (_dirty && !_isSaving) {
          save().catch(function(e) {
            console.warn('[API] Server save failed:', e.message);
          });
          _dirty = false;
        }
      }, 30000);

      return charId;

    } catch (e) {
      console.error('[API] Auth failed:', e.message);
      
      // ✅ Если сервер упал — пробуем локальное сохранение
      var localData = readLocal();
      if (localData && localData.data) {
        console.log('[API] Using local save (server unavailable)');
        return applySave(localData.data);
      }
      
      return null;
    }
  }

  // ✅ Мгновенное сохранение в localStorage
  function saveLocal() {
    if (!_initData) return;
    var snapshot = buildSnapshot();
    writeLocal(snapshot);
  }

  // ✅ Сохранение на сервер
  async function save() {
    if (!_initData || _isSaving) return;
    _isSaving = true;
    var snapshot = buildSnapshot();
    
    try {
      await apiFetch('/save', {
        method: 'POST',
        body: JSON.stringify(snapshot),
      });
      // ✅ После успеха — обновляем локальное сохранение
      writeLocal(snapshot);
      console.log('[API] Server save OK');
    } catch (e) {
      console.error('[API] Server save failed:', e.message);
      throw e;
    } finally {
      _isSaving = false;
    }
  }

  // ✅ Частичное обновление (сервер + локально)
  async function partial(fields) {
    if (!_initData || _isSaving) return;
    _dirty = false;
    
    var snapshot = buildSnapshot();
    
    try {
      await apiFetch('/save/partial', {
        method: 'POST',
        body: JSON.stringify({ fields: fields }),
      });
      // ✅ Обновляем локальное сохранение
      writeLocal(snapshot);
      console.log('[API] Partial OK');
    } catch (e) {
      console.error('[API] Partial failed:', e.message);
      // ✅ При ошибке — все равно сохраняем локально
      writeLocal(snapshot);
      throw e;
    }
  }

  // ✅ Пометить, что нужно сохранить на сервер + мгновенно локально
  function markDirty() {
    _dirty = true;
    // ✅ Мгновенно сохраняем локально!
    saveLocal();
  }

  return {
    init:           init,
    save:           save,
    saveLocal:      saveLocal,
    partial:        partial,
    markDirty:      markDirty,
    get loaded()    { return !!_userId; },
    get userId()    { return _userId; },
    get savedHp()   { return _savedHp; },
    get photoUrl()  { return _photoUrl; },
    get firstName() { return _firstName; },
  };
})();