/* 时光账本 · 数据层
 * IndexedDB 事件流：events（时段记录）+ reviews（每日复盘）
 * 对外暴露 window.TimeDB
 */
(function () {
  'use strict';

  var DB_NAME = 'timelog';
  var DB_VERSION = 1;
  var _dbp = null;

  function open() {
    if (_dbp) return _dbp;
    _dbp = new Promise(function (resolve, reject) {
      if (!('indexedDB' in window)) {
        reject(new Error('这个浏览器不支持 IndexedDB'));
        return;
      }
      var req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains('events')) {
          var s = db.createObjectStore('events', { keyPath: 'id' });
          s.createIndex('byStart', 'startAt');
          s.createIndex('byType', 'type');
          s.createIndex('byState', 'state');
        }
        if (!db.objectStoreNames.contains('reviews')) {
          db.createObjectStore('reviews', { keyPath: 'date' });
        }
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
      req.onblocked = function () { reject(new Error('数据库被另一个标签页占用，请关掉其它标签页再试')); };
    });
    return _dbp;
  }

  function store(name, mode) {
    return open().then(function (db) {
      return db.transaction(name, mode).objectStore(name);
    });
  }

  function wrap(req) {
    return new Promise(function (resolve, reject) {
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }

  function put(storeName, value) {
    return store(storeName, 'readwrite').then(function (s) { return wrap(s.put(value)); });
  }

  function get(storeName, key) {
    return store(storeName, 'readonly').then(function (s) { return wrap(s.get(key)); });
  }

  function del(storeName, key) {
    return store(storeName, 'readwrite').then(function (s) { return wrap(s.delete(key)); });
  }

  function all(storeName) {
    return store(storeName, 'readonly').then(function (s) { return wrap(s.getAll()); });
  }

  function byIndex(storeName, indexName, range) {
    return store(storeName, 'readonly').then(function (s) {
      return wrap(s.index(indexName).getAll(range));
    });
  }

  function clear(name) {
    return store(name, 'readwrite').then(function (s) { return wrap(s.clear()); });
  }

  window.TimeDB = {
    open: open,

    /* ---- 事件 ---- */
    putEvent: function (ev) { return put('events', ev); },
    getEvent: function (id) { return get('events', id); },
    deleteEvent: function (id) { return del('events', id); },
    allEvents: function () { return all('events'); },

    putEvents: function (list) {
      return open().then(function (db) {
        return new Promise(function (resolve, reject) {
          var tx = db.transaction('events', 'readwrite');
          var s = tx.objectStore('events');
          list.forEach(function (ev) { s.put(ev); });
          tx.oncomplete = function () { resolve(list.length); };
          tx.onerror = function () { reject(tx.error); };
        });
      });
    },

    /* 时间段内开始的事件（含正在进行中的） */
    rangeEvents: function (from, to) {
      return byIndex('events', 'byStart', IDBKeyRange.bound(from, to, false, true));
    },

    /* 未闭合的事件 */
    openEvents: function () {
      return byIndex('events', 'byState', IDBKeyRange.only('open'));
    },

    /* ---- 复盘 ---- */
    putReview: function (r) { return put('reviews', r); },
    getReview: function (date) { return get('reviews', date); },
    allReviews: function () { return all('reviews'); },
    deleteReview: function (date) { return del('reviews', date); },

    /* ---- 整体 ---- */
    clearAll: function () {
      return Promise.all([clear('events'), clear('reviews')]);
    }
  };
})();
