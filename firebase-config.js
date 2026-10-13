/* ============================================================
   firebase-config.js  ― オンライン対戦の接続設定（2つ目のファイル）

   ■ このファイルでやること
   Firebaseコンソールに出てくる「設定文」を、下の firebaseConfig の
   "ここに貼る" と書いてある場所に、1つずつ書き写します。
   （コピーしたものを丸ごと貼り替えるより、値だけ入れ替える方が安全です）

   ■ 設定文の場所（パソコンで）
   1. https://console.firebase.google.com を開く
   2. ゲーム用のプロジェクトを開く
   3. 左上の歯車 → 「プロジェクトの設定」
   4. 下へスクロール →「マイアプリ」→ ウェブアプリ（</> マーク）を追加
      （ニックネームは「pug-sugoroku」などでOK。「Firebase Hostingも設定」は
        チェックしない）
   5. 表示される firebaseConfig の中身を、下へ書き写す

   ■ このファイルの値は公開されても大丈夫？
   はい。FirebaseのapiKeyなどは「合言葉」ではなく「住所」のようなもので、
   ウェブアプリでは誰でも見える作りです。守っているのは
   database.rules.json（セキュリティルール）です。
   ただし、悪用を減らすため、次の2つは必ず行ってください。
     ・Google Cloudコンソールで、このAPIキーを自分のサイト
       （例: https://ユーザー名.github.io/*）だけに制限する
     ・プランは「Spark」のまま、Blazeにアップグレードしない
   詳しい手順は、あとの「設定ガイド」で案内します。

   ■ 空欄のままだと？
   オンライン対戦のボタンは出ません（今までどおり1台で遊べます）。
   ============================================================ */

(function () {
  'use strict';

  var firebaseConfig = {
    apiKey:            'AIzaSyDAlFPAbcYZo9nSBhfS_psKlGuO_1IT5Y8',
    authDomain:        'pug-sugoroku-online.firebaseapp.com',
    databaseURL:       'https://pug-sugoroku-online-default-rtdb.asia-southeast1.firebasedatabase.app',   // https://〜firebasedatabase.app の形
    projectId:         'pug-sugoroku-online',
    storageBucket:     'pug-sugoroku-online.firebasestorage.app',   // 使いませんが、そのまま書き写してOK
    messagingSenderId: '987926404188',
    appId:             '1:987926404188:web:3628e5135c6a66a3c3da99'
  };

  /* 値が全部入っているか(まだ「ここに貼る」が残っていないか)をチェック。
     OKなら enabled が true になり、オンライン対戦ボタンが表示されます。 */
  function filled(v) {
    return typeof v === 'string' && v.length > 5 && v.indexOf('ここに貼る') < 0;
  }
  var needed = ['apiKey', 'authDomain', 'databaseURL', 'projectId', 'appId'];
  var ok = needed.every(function (k) { return filled(firebaseConfig[k]); });

  /* databaseURL は https で始まり、firebasedatabase.app か firebaseio.com で
     終わる形だけ許可(貼り間違いで知らないサーバーに接続しないための確認) */
  if (ok) {
    ok = /^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)*\.(firebasedatabase\.app|firebaseio\.com)\/?$/
      .test(firebaseConfig.databaseURL);
  }

  window.PUG_ONLINE = Object.freeze({
    enabled: ok,
    config: Object.freeze(firebaseConfig),
    sdkVersion: '10.14.1',       // 読み込むFirebase SDKのバージョン(固定)
    roomCodeLength: 6,           // database.rules.json の部屋番号(6桁)と合わせる
    maxPlayers: 4,               // 席の数(rules側も0〜3の4席)
    heartbeatMs: 120000          // ホストが生存確認を書く間隔(2分)。ルールの6時間より十分短い
  });
})();
