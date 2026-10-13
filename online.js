/* ============================================================
   online.js  ― オンライン対戦の通信本体（3つ目のファイル）

   ・firebase-config.js の後に読み込みます。
   ・ゲーム本体(index.html)からは window.PugNet だけを使います。
   ・設定が空欄なら PugNet.available() が false になり、何もしません。

   しくみ（ホストが審判）
   ┌ ホスト(部屋を作った人) … サイコロ・じゃんけん・あみだの結果を決め、
   │                          ゲームの状態を pub に配信する
   └ ゲスト               … 「サイコロを振る」「グーを出す」などの
                              行動(act)だけを送る。結果は決められない
   じゃんけん・あみだの選択(act)は、ルールにより本人とホストにしか読めません。

   セキュリティの約束
   ・ログインは匿名(名前・メールは集めない)
   ・受け取ったデータは必ず形と長さを確認してから使う
   ・名前は表示前に危険な文字を取り除く(画面には textContent で出す)
   ・送信は連打を間引く
   ============================================================ */

(function () {
  'use strict';

  var CFG = window.PUG_ONLINE || { enabled: false };
  var CODE_RE = /^[0-9]{6}$/;
  var KIND_RE = /^[a-z0-9_]{1,12}$/;
  var MAX_PUB = 16000, MAX_EV = 2000, MAX_V = 40, MAX_NAME = 12, MAX_CFG = 200;
  var SEND_GAP_MS = 120;

  var sdk = null, app = null, auth = null, db = null, me = null;
  var R = null;                 // 今いる部屋
  var handlers = {};            // イベント受付
  var initPromise = null;

  /* ---------- 小道具 ---------- */
  function on(ev, fn) { (handlers[ev] = handlers[ev] || []).push(fn); return function () { off(ev, fn); }; }
  function off(ev, fn) { var a = handlers[ev] || []; var i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); }
  function emit(ev, data) {
    (handlers[ev] || []).slice().forEach(function (fn) {
      try { fn(data); } catch (e) { console.error('[PugNet] handler', ev, e); }
    });
  }
  function NetError(code, msg) { var e = new Error(msg || code); e.netCode = code; return e; }
  function isDenied(e) { return /permission[_ ]denied/i.test(String((e && (e.code || e.message)) || '')); }
  function withTimeout(p, ms, code) {
    return new Promise(function (res, rej) {
      var t = setTimeout(function () { rej(NetError(code || 'timeout')); }, ms);
      p.then(function (v) { clearTimeout(t); res(v); }, function (e) { clearTimeout(t); rej(e); });
    });
  }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function rnd(n) {               // 暗号レベルの乱数で 0〜n-1
    var a = new Uint32Array(1), lim = Math.floor(0x100000000 / n) * n;
    do { crypto.getRandomValues(a); } while (a[0] >= lim);
    return a[0] % n;
  }
  function genCode() { var s = ''; for (var i = 0; i < 6; i++) s += rnd(10); return s; }
  function path() { return 'rooms/' + R.code + (arguments.length ? '/' + Array.prototype.join.call(arguments, '/') : ''); }
  function ref(p) { return sdk.ref(db, p); }

  /* 名前を安全にする: 制御文字・タグ記号を消し、12文字(ルールと同じ数え方)まで */
  function safeName(s) {
    s = String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f-\u009f<>&"'`\\​-‏‪-‮⁦-⁩]/g, '').trim();
    var out = '';
    Array.from(s).some(function (ch) { if ((out + ch).length > MAX_NAME) return true; out += ch; return false; });
    return out || 'パグ';
  }
  function safeBreed(b) { b = String(b); return /^[0-9]{1,2}$/.test(b) ? b : '0'; }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* 受け取った席データの形チェック */
  function cleanPlayers(v) {
    var out = {};
    if (!v || typeof v !== 'object') return out;
    for (var s = 0; s < (CFG.maxPlayers || 4); s++) {
      var p = v[s] || v[String(s)];
      if (!p || typeof p !== 'object' || typeof p.uid !== 'string') continue;
      out[s] = { uid: p.uid, cpu: p.uid === 'cpu', name: safeName(p.name), breed: safeBreed(p.breed) };
    }
    return out;
  }
  function cleanMeta(v) {
    if (!v || typeof v !== 'object' || typeof v.host !== 'string') return null;
    var cfg = {};
    try { cfg = typeof v.cfg === 'string' && v.cfg.length <= MAX_CFG ? JSON.parse(v.cfg) : {}; } catch (e) { cfg = {}; }
    if (!cfg || typeof cfg !== 'object') cfg = {};
    return {
      host: v.host,
      status: ['lobby', 'playing', 'ended'].indexOf(v.status) >= 0 ? v.status : 'ended',
      upd: typeof v.upd === 'number' ? v.upd : 0,
      cfg: cfg
    };
  }

  function friendly(e) {
    var c = e && e.netCode;
    var m = {
      disabled: 'オンライン対戦の設定がまだです（firebase-config.js）',
      sdk: 'Firebaseを読み込めませんでした。電波の良い所でもう一度ためしてね',
      auth: 'ログインできませんでした。もう一度ためしてね',
      timeout: '通信に時間がかかっています。電波を確認してね',
      badcode: '部屋番号は6けたの数字です',
      notfound: 'その部屋番号は見つかりません',
      started: 'その部屋はもうゲームが始まっています',
      full: '部屋がいっぱいです（4人まで）',
      ended: 'その部屋はもう終わっています',
      nocode: '部屋を作れませんでした。少し待ってもう一度',
      toobig: 'データが大きすぎて送れませんでした',
      notroom: '部屋に入っていません',
      nothost: 'ホストだけができる操作です',
      denied: 'その操作は許可されていません'
    };
    if (c === 'auth' || c === 'sdk') {        // 原因が分かるようにヒントとコードを添える
      var raw = String((e && e.message) || '');
      var code = (raw.match(/auth\/[a-z0-9-]+/) || [''])[0];
      var hint = '';
      if (/referer|referrer|API_KEY_HTTP_REFERRER|requests-from/i.test(raw)) hint = '（APIキーの「ウェブサイトの制限」が合っていません）';
      else if (/admin-restricted|operation-not-allowed/i.test(raw)) hint = '（Firebaseで「匿名」ログインが有効になっていません）';
      else if (/api-key-not-valid|invalid-api-key|API key not valid/i.test(raw)) hint = '（firebase-config.js の apiKey が違います）';
      else if (/network-request-failed|Failed to fetch/i.test(raw)) hint = '（通信できませんでした。電波を確認してね）';
      return m[c] + hint + (code ? ' [' + code + ']' : '');
    }
    if (c && m[c]) return m[c];
    if (isDenied(e)) return m.denied;
    return '通信エラーが起きました。もう一度ためしてね';
  }

  /* ---------- 準備(SDK読み込み + 匿名ログイン) ---------- */
  function available() { return !!CFG.enabled; }

  function loadSdk() {
    if (window.__PUG_FAKE_SDK) return Promise.resolve(window.__PUG_FAKE_SDK);   // テスト用
    var base = 'https://www.gstatic.com/firebasejs/' + CFG.sdkVersion + '/';
    return Promise.all([
      import(base + 'firebase-app.js'),
      import(base + 'firebase-auth.js'),
      import(base + 'firebase-database.js')
    ]).then(function (m) { return Object.assign({}, m[0], m[1], m[2]); });
  }

  function init() {
    if (!available()) return Promise.reject(NetError('disabled'));
    if (me) return Promise.resolve(me);
    if (initPromise) return initPromise;
    initPromise = withTimeout(loadSdk(), 20000, 'sdk').catch(function (e) {
      throw e.netCode ? e : NetError('sdk', String(e));
    }).then(function (s) {
      sdk = s;
      app = (s.getApps && s.getApps().length) ? s.getApp() : s.initializeApp(CFG.config);
      auth = s.getAuth(app);
      db = s.getDatabase(app);
      return withTimeout(s.signInAnonymously(auth), 20000, 'auth');
    }).then(function (cred) {
      me = cred.user.uid;
      watchConnection();
      return me;
    }).catch(function (e) {
      initPromise = null;
      throw e.netCode ? e : NetError('auth', String(e));
    });
    return initPromise;
  }

  var connUnsub = null;
  function watchConnection() {
    if (connUnsub) return;
    connUnsub = sdk.onValue(ref('.info/connected'), function (snap) {
      var c = !!snap.val();
      emit('conn', c);
      if (c && R) markPresent();          // つながり直したら在室を書き直す
    });
  }

  /* ---------- 部屋を作る(ホスト) ---------- */
  function createRoom(opt) {
    opt = opt || {};
    return init().then(function () {
      leaveQuietly();
      var cfgStr = JSON.stringify(opt.cfg || {});
      if (cfgStr.length > MAX_CFG) throw NetError('toobig');
      var tries = 0;
      function attempt() {
        if (++tries > 8) throw NetError('nocode');
        var code = genCode();
        var data = {
          meta: { host: me, status: 'lobby', upd: sdk.serverTimestamp(), cfg: cfgStr },
          members: {}, players: {}
        };
        data.members[me] = '0';
        data.players['0'] = { uid: me, name: safeName(opt.name), breed: safeBreed(opt.breed) };
        return withTimeout(sdk.set(sdk.ref(db, 'rooms/' + code), data), 15000).then(function () {
          return enter(code, 0, true);
        }, function (e) {
          if (isDenied(e)) return attempt();     // 使用中の番号 → 別の番号で
          throw e;
        });
      }
      return attempt();
    });
  }

  /* ---------- 部屋に入る(ゲスト)・入り直す ---------- */
  function joinRoom(code, opt) {
    opt = opt || {};
    code = String(code || '').replace(/\s/g, '');
    if (!CODE_RE.test(code)) return Promise.reject(NetError('badcode'));
    return init().then(function () {
      leaveQuietly();
      var base = 'rooms/' + code;
      return withTimeout(sdk.get(sdk.ref(db, base + '/meta')), 15000).then(function (snap) {
        var meta = cleanMeta(snap.exists() ? snap.val() : null);
        if (!meta) throw NetError('notfound');
        // すでにメンバーなら(リロードなど)その席に戻る
        return sdk.get(sdk.ref(db, base + '/members/' + me)).then(function (ms) {
          return ms.exists() ? ms.val() : null;
        }, function () { return null; }).then(function (seat) {
          if (seat != null && /^[0-3]$/.test(seat)) return enter(code, +seat, meta.host === me);
          if (meta.status === 'playing') throw NetError('started');
          if (meta.status !== 'lobby') throw NetError('ended');
          var name = safeName(opt.name), breed = safeBreed(opt.breed);
          var s = 1;
          function trySeat() {
            if (s >= (CFG.maxPlayers || 4)) throw NetError('full');
            var seatNo = String(s++), upd = {};
            upd[base + '/players/' + seatNo] = { uid: me, name: name, breed: breed };
            upd[base + '/members/' + me] = seatNo;
            return withTimeout(sdk.update(sdk.ref(db), upd), 15000).then(function () {
              return enter(code, +seatNo, false);
            }, function (e) { if (isDenied(e)) return trySeat(); throw e; });
          }
          return trySeat();
        });
      });
    });
  }

  /* ---------- 部屋の購読 ---------- */
  function enter(code, seat, isHost) {
    R = {
      code: code, seat: seat, host: isHost, unsubs: [],
      meta: null, players: {}, pres: {}, pubSeq: -1,
      actId: 0, lastSend: 0, sendChain: Promise.resolve(),
      seenAct: {}, hb: null, pubSeq0: 0
    };
    var r = R;
    function sub(p, fn) {
      r.unsubs.push(sdk.onValue(ref(p), function (snap) { if (R === r) fn(snap.exists() ? snap.val() : null); },
        function (err) {        // 読む権限がなくなった = キックされた/部屋が消えた
          if (R !== r) return;
          emit('error', { where: p, message: friendly(err) });
          closed(r.meta ? 'kicked' : 'denied');
        }));
    }
    sub(path('meta'), function (v) {
      var m = cleanMeta(v);
      if (!m) { closed('deleted'); return; }
      if (r.meta && m.host !== r.meta.host) { closed('taken'); return; }
      r.meta = m;
      emit('meta', m);
      if (m.status === 'ended' && !r.host) emit('ended', m);
    });
    sub(path('players'), function (v) {
      r.players = cleanPlayers(v);
      var mine = r.players[r.seat];
      emit('players', r.players);
      if (r.meta && (!mine || mine.uid !== me)) closed('kicked');   // 席が消えた/CPUに置き換えられた
    });
    sub(path('pres'), function (v) {
      var out = {};
      if (v && typeof v === 'object') Object.keys(v).forEach(function (k) { out[k] = v[k] === true; });
      r.pres = out;
      emit('pres', out);
    });
    sub(path('pub'), function (v) {
      if (!v || typeof v.seq !== 'number' || typeof v.s !== 'string' || v.s.length > MAX_PUB) return;
      if (v.seq <= r.pubSeq) return;
      var st, ev = null;
      try { st = JSON.parse(v.s); } catch (e) { return; }
      if (typeof v.ev === 'string' && v.ev.length <= MAX_EV) { try { ev = JSON.parse(v.ev); } catch (e) { ev = null; } }
      r.pubSeq = v.seq;
      emit('state', { seq: v.seq, state: st, ev: ev });
    });
    if (isHost) {
      for (var s = 0; s < (CFG.maxPlayers || 4); s++) (function (seat) {
        sub(path('act', seat), function (v) { onAct(r, seat, v); });
      })(s);
      r.hb = setInterval(function () { if (R === r) touch(); }, CFG.heartbeatMs || 120000);
    } else {
      // 進行記録(log)を1件ずつ受け取る
      if (sdk.onChildAdded) {
        r.unsubs.push(sdk.onChildAdded(ref(path('log')), function (snap) {
          if (R !== r) return;
          var e = parseLog(snap.key, snap.val());
          if (e) emit('log', e);
        }, function (err) {
          if (R !== r) return;
          emit('error', { where: 'log', message: friendly(err) });
          closed(r.meta ? 'kicked' : 'denied');
        }));
      }
      // 自分の前回の行動番号から続ける(ルールで番号は増える一方のため)
      r.sendChain = sdk.get(ref(path('act', seat))).then(function (snap) {
        var v = snap.exists() ? snap.val() : null;
        if (v && typeof v.id === 'number' && v.id > r.actId) r.actId = v.id;
      }, function () {});
    }
    markPresent();
    var info = { code: code, seat: seat, host: isHost, uid: me };
    emit('joined', info);
    return info;
  }

  function markPresent() {
    if (!R) return;
    var pr = ref(path('pres', me));
    try { sdk.onDisconnect(pr).set(false); } catch (e) {}
    sdk.set(pr, true).catch(function () {});
  }

  function onAct(r, seat, v) {
    if (!v || typeof v !== 'object') return;
    if (typeof v.id !== 'number' || !KIND_RE.test(v.k || '')) return;
    if (v.v != null && (typeof v.v !== 'string' || v.v.length > MAX_V)) return;
    if (r.seenAct[seat] != null && v.id <= r.seenAct[seat]) return;   // 同じ行動の二重処理を防ぐ
    r.seenAct[seat] = v.id;
    var p = r.players[seat];
    if (!p || p.cpu) return;
    emit('act', { seat: seat, kind: v.k, value: v.v == null ? null : v.v, id: v.id });
  }

  function closed(why) {
    var r = R;
    if (!r) return;
    cleanup(r);
    R = null;
    emit('closed', { reason: why });   // deleted / kicked / taken / left
  }
  function cleanup(r) {
    r.unsubs.forEach(function (u) { try { u(); } catch (e) {} });
    r.unsubs = [];
    if (r.hb) clearInterval(r.hb);
    try { sdk.onDisconnect(ref('rooms/' + r.code + '/pres/' + me)).cancel(); } catch (e) {}
  }
  function leaveQuietly() { if (R) { var r = R; cleanup(r); R = null; } }

  /* ---------- ゲスト: 行動を送る ---------- */
  function sendAct(kind, value) {
    if (!R) return Promise.reject(NetError('notroom'));
    if (!KIND_RE.test(kind || '')) return Promise.reject(NetError('denied'));
    if (value != null) { value = String(value); if (value.length > MAX_V) return Promise.reject(NetError('toobig')); }
    var r = R;
    r.sendChain = r.sendChain.then(function () {
      var wait = r.lastSend + SEND_GAP_MS - Date.now();
      return wait > 0 ? sleep(wait) : null;
    }).then(function () {
      if (R !== r) throw NetError('notroom');
      r.lastSend = Date.now();
      var a = { id: ++r.actId, k: kind, t: sdk.serverTimestamp() };
      if (value != null) a.v = value;
      return withTimeout(sdk.set(ref(path('act', r.seat)), a), 15000);
    });
    var p = r.sendChain;
    r.sendChain = p.catch(function () {});
    return p;
  }

  /* ---------- ホストだけの操作 ---------- */
  function needHost() { if (!R) throw NetError('notroom'); if (!R.host) throw NetError('nothost'); return R; }
  function touch() {
    var r = R; if (!r || !r.host) return Promise.resolve();
    return sdk.set(ref(path('meta', 'upd')), sdk.serverTimestamp()).catch(function () {});
  }
  function publish(state, ev) {
    try {
      var r = needHost();
      var s = JSON.stringify(state);
      if (s.length > MAX_PUB) throw NetError('toobig');
      var e = ev == null ? null : JSON.stringify(ev);
      if (e && e.length > MAX_EV) e = null;          // 演出情報は大きすぎたら省略
      r.pubSeq0 = Math.max(r.pubSeq0, r.pubSeq) + 1;
      var upd = { 'pub': { seq: r.pubSeq0, s: s }, 'meta/upd': sdk.serverTimestamp() };
      if (e) upd.pub.ev = e;
      r.pubSeq = r.pubSeq0;                          // 自分の配信は受信時に二重処理しない
      return withTimeout(sdk.update(ref(path()), upd), 15000);
    } catch (err) { return Promise.reject(err); }
  }
  function setStatus(status) {
    try {
      needHost();
      if (['lobby', 'playing', 'ended'].indexOf(status) < 0) throw NetError('denied');
      return sdk.update(ref(path('meta')), { status: status, upd: sdk.serverTimestamp() });
    } catch (e) { return Promise.reject(e); }
  }
  function setCfg(cfg) {            // ロビーでの設定(離島・周回など)を全員に見せる
    try {
      needHost();
      var str = JSON.stringify(cfg || {});
      if (str.length > MAX_CFG) throw NetError('toobig');
      return sdk.update(ref(path('meta')), { cfg: str, upd: sdk.serverTimestamp() });
    } catch (e) { return Promise.reject(e); }
  }
  function setCpu(seat, name, breed) {
    try {
      var r = needHost();
      if (!/^[0-3]$/.test(String(seat)) || +seat === r.seat) throw NetError('denied');
      var upd = {}, cur = r.players[seat];
      upd['players/' + seat] = { uid: 'cpu', name: safeName(name || 'CPUパグ'), breed: safeBreed(breed) };
      if (cur && !cur.cpu) upd['members/' + cur.uid] = null;   // 人がいた席をCPUに替える(切断時など)
      return sdk.update(ref(path()), upd);
    } catch (e) { return Promise.reject(e); }
  }
  function clearSeat(seat) {          // 席を空ける(キック/CPUを外す)
    try {
      var r = needHost();
      if (!/^[0-3]$/.test(String(seat)) || +seat === r.seat) throw NetError('denied');
      var upd = {}, cur = r.players[seat];
      upd['players/' + seat] = null;
      if (cur && !cur.cpu) upd['members/' + cur.uid] = null;
      return sdk.update(ref(path()), upd);
    } catch (e) { return Promise.reject(e); }
  }
  function closeRoom() {
    try {
      var r = needHost();
      var code = r.code;
      cleanup(r); R = null;
      emit('closed', { reason: 'left' });
      return sdk.remove(sdk.ref(db, 'rooms/' + code)).catch(function () {});
    } catch (e) { return Promise.reject(e); }
  }

  /* ---------- 進行記録(log) ---------- */
  var MAX_LOG = 120;
  function pad5(n) { return ('0000' + n).slice(-5); }
  function parseLog(key, val) {
    if (!/^[0-9]{5}$/.test(String(key)) || typeof val !== 'string' || val.length > MAX_LOG) return null;
    var e; try { e = JSON.parse(val); } catch (x) { return null; }
    if (!e || typeof e !== 'object' || typeof e.k !== 'string' || !KIND_RE.test(e.k)) return null;
    return { n: +key, e: e };
  }
  function appendLog(n, entry) {
    try {
      needHost();
      if (!(n >= 0 && n <= 99999)) throw NetError('toobig');
      var s = JSON.stringify(entry);
      if (s.length > MAX_LOG) throw NetError('toobig');
      return withTimeout(sdk.set(ref(path('log', pad5(n))), s), 15000);
    } catch (e) { return Promise.reject(e); }
  }
  function fetchLog() {               // 今までの記録をまとめて取得(途中参加・再読み込み用)
    if (!R) return Promise.reject(NetError('notroom'));
    return withTimeout(sdk.get(ref(path('log'))), 20000).then(function (snap) {
      var v = snap.exists() ? snap.val() : {}, out = [];
      Object.keys(v || {}).sort().forEach(function (k) { var e = parseLog(k, v[k]); if (e) out[e.n] = e.e; });
      for (var i = 0; i < out.length; i++) if (!out[i]) { out.length = i; break; }   // 抜けがあればそこまで
      return out;
    });
  }

  /* ---------- 退出 ---------- */
  function leave() {
    if (!R) return Promise.resolve();
    var r = R;
    if (r.host) return closeRoom();
    var presRef = ref(path('pres', me));
    var p;
    if (!r.meta || r.meta.status === 'lobby') {     // ロビー(か不明)なら席を返す。ゲーム中はルールが拒否→不在にするだけ
      var upd = {};
      upd['players/' + r.seat] = null;
      upd['members/' + me] = null;
      p = sdk.update(ref(path()), upd).catch(function () {
        return sdk.set(presRef, false).catch(function () {});
      });
    } else {
      p = sdk.set(presRef, false).catch(function () {});
    }
    cleanup(r); R = null;
    emit('closed', { reason: 'left' });
    return p;
  }

  /* ---------- 公開窓口 ---------- */
  window.PugNet = Object.freeze({
    available: available,
    init: init,
    createRoom: createRoom,
    joinRoom: joinRoom,
    leave: leave,
    sendAct: sendAct,
    publish: publish,
    appendLog: appendLog,
    fetchLog: fetchLog,
    setStatus: setStatus,
    setCfg: setCfg,
    setCpu: setCpu,
    clearSeat: clearSeat,
    closeRoom: closeRoom,
    on: on,
    off: off,
    room: function () {
      return R ? { code: R.code, seat: R.seat, host: R.host, meta: R.meta, players: R.players, pres: R.pres } : null;
    },
    uid: function () { return me; },
    isPresent: function (seat) {
      if (!R) return false; var p = R.players[seat];
      return !!(p && (p.cpu || R.pres[p.uid]));
    },
    message: friendly,
    safeName: safeName,
    escapeHtml: escapeHtml,
    trueRand: rnd
  });
})();
