パグ旅すごろく Webアプリ版

■ 公開のしかた
このフォルダの中身をまるごと、GitHub Pages / Netlify / Firebase Hosting などの
HTTPSのWebサーバーに置いてください（index.html が入口です）。
※ ホーム画面アプリ化・オフライン動作は https:// で開いたときに有効になります。

■ スマホのホーム画面に追加
・iPhone（Safari）：共有ボタン →「ホーム画面に追加」
・Android（Chrome）：メニュー →「ホーム画面に追加」または「アプリをインストール」

■ ファイル
index.html            ゲーム本体
manifest.webmanifest  アプリ名・アイコンの設定
sw.js                 オフライン用（一度開けば電波がなくても遊べます）
icons/                アイコン（32/180/192/512px・Android用マスカブル・SVG原画）

■ 更新したとき
sw.js の1行目 CACHE='pugtabi-v1-…' の文字を変えると、遊んでいる端末に新しい版が届きます。
