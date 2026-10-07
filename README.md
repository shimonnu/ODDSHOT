# ODDSHOT Decisions API 対応プロトタイプ

日常で見つけた不思議な写真を集める、Next.js のプロトタイプです。写真の条件判断と採点には OpenAI Decisions API を使う構成に変更しました。API キーなしで試せるデモと、実画像を採点する接続モードを用意しています。

## 試せること

1. TOP でニックネームを登録するか、「キミはもしかして」から名前を選びます。
2. ヘッダーの「写真を追加」から、どの画面でも撮影・写真選択のモーダルを開けます。未参加の場合はモーダル内で名前を選びます。写真追加ページとサンプル写真も利用できます。写真を選ぶと採点と保存が自動で始まります。
3. S・A・B・C・F のランク、100点満点のスコア、説明と4項目の点数を確認できます。タイトルを空欄にすると3つのタイトル案を取得し、最初の案で保存します。結果画面で自分の写真の候補を選び直したり、自由に編集して保存したりできます。結果ごとにデモ採点／AI採点を区別します。
4. コレクションで全員／自分の写真を切り替え、ランクで絞り込めます。
5. TOP では S と A の合計獲得枚数を集計します。同数は同順位。画面表示中は5秒ごとに更新します。

ヘッダーの「DEMO / AI MODE」またはフッターの「DECISIONS EDITION」から同期失敗のデモを有効にすると、追加した写真で失敗表示と再試行を試せます。撮影ボタンは対応するスマートフォンでカメラを開き、PC ではブラウザに応じてファイル選択になります。

## Decisions API の採点

サーバーが写真と DB 内の採点基準を `POST https://api.openai.com/v1/decisions` に送ります。モデルは `gpt-6-luna` を使います。画像は base64 の data URL として送り、4項目の `score` と、事前に定義した特徴の `predicate` を1回のリクエストにまとめます。

各項目には弱い順に5段階の基準を与えます。返された0〜4の値を各25点に換算し、合計を丸めて100点満点にします。その総合点からサーバー側でランクを決定します。`confidence` を点数や正解率として使いません。拒否応答、必要な項目の欠落、不正な数値は成功結果として保存しません。接続失敗をデモ採点に置き換えることもありません。

説明は採点項目と特徴に応じた日本語の定型文です。Decisions API に自由文の生成は依頼していません。採点結果にはモデル、元の値・確率・confidence、使用量、基準バージョンも保存します。

[OpenAI Decisions API 公式ガイド](https://developers.openai.com/api/docs/guides/decisions) / [リクエストと出力仕様](https://developers.openai.com/api/reference/resources/decisions/methods/create)

## 写真からのタイトル提案

実接続モードでは同じ `OPENAI_API_KEY` を使い、画像を `POST https://api.openai.com/v1/responses` の `gpt-6-luna` に送って日本語のタイトルを3案生成します。写真に見える特徴を手がかりに、短く少し神秘的なタイトルを作ります。採点は引き続き Decisions API が担当します。

空欄のタイトルで投稿したときは採点と提案を並列に実行し、候補と採用したタイトルを DB に保存します。手入力のタイトルは優先し、投稿時のタイトル生成は省きます。既存の写真にも結果画面から候補を取得できます。候補の再取得は追加の API 利用を伴います。

タイトルの提案だけに失敗した場合は、写真と評価を保存し、手入力または再取得で続けられます。タイトル変更は採点・ランキングの集計を増やしません。現在の参加者IDと写真の投稿者IDが一致するときだけ編集・候補取得を表示し、保存時にも一致を確認します。ニックネームを選ぶ方式なので、本人確認としての認証ではありません。

デモモードの候補はサンプル別の定型文です。アップロード画像には一般的なデモ候補を表示し、画像の内容を AI が読み取ったとは表示しません。失敗した実接続の提案をデモ候補に置き換えることもありません。

[画像入力の公式ガイド](https://developers.openai.com/api/docs/guides/images-vision) / [構造化された出力](https://developers.openai.com/api/docs/guides/structured-outputs)

## 接続モード

配布用 `.env.example` の初期値は `demo` です。外部 AI へ送信せず、デモ結果で画面と保存を試せます。

実画像を採点する場合は、`.env.example` を `.env.local` にコピーし、次を設定して開発サーバーを再起動してください。

```dotenv
ODDSHOT_SCORING_MODE=decisions
OPENAI_API_KEY=自分のAPIキー
```

キーはサーバー側だけで使います。`NEXT_PUBLIC_` を付けず、チャットや公開ファイルに貼り付けないでください。Decisions API はベータ提供中のため、利用する OpenAI プロジェクトでのアクセスを確認する必要があります。実接続モードで新しく追加する写真はサンプルも含めて AI に送られ、API 利用料が発生します。以前のデモ結果はそのまま残ります。

この作業環境では2026年10月8日に、DBの有効基準 `decisions-v1` とサンプル画像を使い、Decisions API の採点と Responses API のタイトル3案生成が両方成功することを確認しました。既存写真を追加・更新せず接続を確認した後、`.env.local` を `decisions` に切り替えて再起動しています。既存15枚の写真・評価と Google Drive の接続は保持しています。

## 保存と実装範囲

- ユーザー、写真の実体、評価、評価基準は DB に保存します。`ODDSHOT_STORAGE_MODE=sqlite` は `work/oddshot.sqlite`、`d1` は Cloudflare D1 を使います。写真は DB の BLOB です。
- ブラウザの `sessionStorage` に記憶するのは選択中のユーザーIDだけです。通常はタブを閉じると選択が消えます。DB の名前・写真・成績は残ります。
- 名前を選ぶだけで参加できます。本人確認・参加者ログインは実装していません。
- SQLite の初回起動時に5人・10枚のサンプルを用意します。D1 は事前にテーブルと採点基準を準備し、実行時にサンプルを投入しません。
- デモモードのサンプル写真は固定の評価、アップロード写真はファイルに応じたデモ結果です。実接続モードでは、写真を Decisions API が基準に照らして採点します。
- Google Drive の自動保存は実装済みです。`ODDSHOT_DRIVE_MODE=google` で管理者が Google に保存許可を与えると動きます。`demo` の同期表示は Google Drive には送信しません。Vercel 公開は別途行います。
- 写真は長辺最大1,400pxの JPEG に変換して保存します。JPEG・PNG・WebP の入力上限20MB、DB保存上限1.5MiBです。原寸保存・HEIC・点数の画像への合成は未実装です。
- 採点基準は各25点の4項目、S90–100／A75–89／B60–74／C40–59／F0–39の仮案です。新しい基準 `decisions-v1` を DB に保存し、旧版と過去の評価も保持します。
- Google Drive の管理者設定とバックグラウンド保存・再試行を実装しています。削除と再採点は未実装です。

## 起動

Node.js 22.16 以上を使い、展開したフォルダで実行します。

```sh
npm ci
npm run dev
```

同じパソコンで [モックを開く](http://127.0.0.1:3000/) と操作できます。終了しても DB は保存されます。

この作業環境では [更新したプレビュー](http://127.0.0.1:3001/) を3001番で起動しています。3000番が使用中の場合は `npm run dev -- --port 3001` で起動できます。

```sh
npm run build
npm start
```

確認用のコマンドです。テストは模擬した API 応答と一時 DB を使い、OpenAI への通信・課金は行いません。

```sh
npm run typecheck
npm test
```

SQLite はローカル用です。Vercel では永続保存に D1 モードを使い、環境変数をプロジェクト側にも設定してください。[要件定義案](https://chatgpt.com/space/page_ba4404ff41388191916a771b8701ec48)

## Cloudflare D1 の接続と移行

アプリは認証付きの専用 Worker (`cloudflare/worker.mjs`) を通して D1 を読み書きします。接続には `ODDSHOT_D1_WORKER_URL` と `ODDSHOT_D1_WORKER_TOKEN` を使い、ブラウザには渡しません。Worker の `DB` binding に D1 を設定し、同じトークンを `ODDSHOT_D1_WORKER_TOKEN` secret として登録します。構成は `cloudflare/wrangler.jsonc` にあります。アプリ実行時に Cloudflare の管理用 API トークンは不要です。

初期テーブル定義は `cloudflare/migrations/0001_initial.sql` です。ユーザー、写真の BLOB、評価、採点基準、タイトル候補、重複防止情報を保持します。D1 モードでの自動テーブル作成・基準投入・SQLite への代替保存は行いません。写真と評価は同じ原子バッチで保存します。

接続確認と既存データの移行に使うコマンドです。

```sh
npm run check:cloudflare
# 最終コピー前に、現在の SQLite アプリからの投稿・編集を止めてください。
npm run migrate:cloudflare -- --copy
npm run migrate:cloudflare
```

接続確認はデータを変更しません。コピーは `work/backups` に SQLite のバックアップを作り、画像をバイナリのパラメータとして転送します。同じ ID は内容を照合し、差異があれば上書きせず中止します。途中で接続が切れても同じコマンドで再開できます。移行先に移行元にはないデータがある場合は中止します。最後に全件数・画像 SHA-256・評価 JSON・基準・タイトル候補を照合します。

コピー後、投稿・編集を止めた状態で元 DB との確認が成功したら `ODDSHOT_STORAGE_MODE=d1` にして再起動します。元の SQLite は残ります。D1 の制限は SQL 1文100 KB、BLOB または行2,000,000バイトです。[D1 の制限](https://developers.cloudflare.com/d1/platform/limits/)

この作業環境では D1 `oddshot` と専用 Worker `oddshot-storage` を作成し、ユーザー5人・写真15枚・評価15件・採点基準2種類を移行しました。画像ハッシュと全データの一致を確認したうえで、`.env.local` の保存先を `d1` に切り替えています。元の SQLite と移行前バックアップは `work/` に残しています。新しい環境へコピーする場合は `.env.example` の接続情報を設定してください。

## Google Drive の自動保存

写真・ユーザー・採点データは引き続き DB に保存します。Google Drive には写真ファイルと評価 JSON をペアで保存し、ニックネーム、タイトル候補、採点基準のバージョンと内容も残します。タイトルを変更したときは同じファイルを更新します。Drive に予約したファイル ID を DB に固定してからアップロードするため、途中失敗後の再試行でも重複を防ぎます。写真と JSON の両方を確認してから「Drive 保存済み」にします。

管理者の接続手順です。

1. 同じ Google Cloud プロジェクトで Google Drive API と Google Picker API を有効化します。OAuth のデータアクセスには `https://www.googleapis.com/auth/drive.file` を設定します。
2. 作成済みのウェブアプリ用 OAuth クライアントに、`GOOGLE_REDIRECT_URI` と完全に一致する承認済みリダイレクト URI を登録します。ローカルは `http://127.0.0.1:3001/api/admin/drive/callback`、Vercel 本番は `https://公開ドメイン/api/admin/drive/callback` です。両方登録できます。
3. D1 の場合は `cloudflare/migrations/0002_google_drive.sql` を Cloudflare の管理接続から適用します。既存の写真・評価を変更せず、管理設定と永続的な保存待ち行列を追加します。アプリから自動 DDL は実行しません。
4. `.env.example` の Google クライアント情報、保存先フォルダ ID、戻り先 URL、管理用パスワード・暗号化キー・再試行用シークレットを設定し、`ODDSHOT_DRIVE_MODE=google` にしてサーバーを再起動します。既存の暗号化キーは保持してください。
5. [管理者の連携画面](http://127.0.0.1:3001/admin/drive) で管理用パスワードを入力し、「Google で許可して、保存先を選ぶ」から管理者本人が許可を与えます。指定したフォルダ以外は受け付けません。最初の連携で DB 内の既存の写真も順に自動保存します。参加者の Google ログインは不要です。

Picker は Google が提供するリダイレクト型の OAuth フローを使います。既存の OAuth クライアントで接続でき、Picker 用 API キーやプロジェクト番号を追加する必要はありません。継続保存用の refresh token はサーバーが取得し、AES-256-GCM で暗号化して DB に保存します。ブラウザや公開環境変数には渡しません。管理画面を閉じても保存許可は維持されます。[Google Picker の公式手順](https://developers.google.com/workspace/drive/picker/guides/desktop-mobile-picker)

OAuth の公開ステータスが「テスト中」で Drive 権限を使う場合、refresh token は通常7日で期限切れになります。継続運用では「本番環境」に変更してから改めて連携してください。期限切れ・権限不足は保存失敗として表示し、管理者の再連携で再開します。[Google OAuth の有効期限](https://developers.google.com/identity/protocols/oauth2)

投稿への応答後、Next.js の `after` で保存処理を始めます。待ち行列・ファイル ID・試行回数・ロックは DB に残るため、タブを閉じても処理を続けられます。一時的な失敗は待ち時間を増やしながら最大8回まで試行し、その後も記録を保持して手動再試行できます。

自動再試行は投稿と独立した定期呼び出しも必要です。ローカルではアプリと別に次を起動すると、30秒ごとに保存待ちを処理します。

```sh
npm run sync:drive
```

Vercel 公開時は専用 Cloudflare Worker に `ODDSHOT_SYNC_CALLBACK_URL=https://公開ドメイン/api/admin/drive/process` と `ODDSHOT_SYNC_SECRET` を設定し、Cron Trigger を1分間隔 (`* * * * *`) で登録します。Worker の `scheduled` ハンドラーが認証付きでアプリを呼び出します。定期呼び出しを設定するまでは投稿直後の処理は動きますが、失敗後の自動再試行・大量の既存写真の処理には次の呼び出しが必要です。Vercel Hobby の Cron は1日1回のため、ここには使いません。[Cloudflare Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/) / [Vercel Hobby Cron の制限](https://vercel.com/docs/cron-jobs/usage-and-pricing)

この作業環境の管理用パスワードは `work/drive-admin.txt` に保存し、認証情報は `.env.local` に設定しています。どちらも公開用 ZIP や Git に含めません。2026年10月8日に D1 の追加テーブルとインデックスを確認し、Drive モードを `google` に切り替えました。管理者の Google 保存許可も完了し、「スピ旅行」フォルダへ既存の写真15枚と評価 JSON 15件を保存しました。全画像の SHA-256 と、評価・採点基準・タイトル・投稿者データが DB と一致することを確認しています。待ち行列は全15件が最新の版で保存済みです。ユーザー5人・写真15枚・評価15件を保持し、ローカルの30秒間隔の自動再試行処理も起動しています。

## Vercel 公開時の設定

次の13個を、ODDSHOT の Vercel プロジェクトの Environment Variables に Production 用として登録します。秘密値は現在の `.env.local` から引き継ぎます。環境変数を変更した場合は、新しいデプロイに反映されます。`.env.local` は公開ファイルや Git に含めません。[Vercel の環境変数](https://vercel.com/docs/environment-variables)

| 環境変数 | 本番の値 |
| --- | --- |
| `ODDSHOT_STORAGE_MODE` | `d1` |
| `ODDSHOT_D1_WORKER_URL` | 現在と同じ Worker URL |
| `ODDSHOT_D1_WORKER_TOKEN` | 現在と同じ接続トークン |
| `ODDSHOT_SCORING_MODE` | `decisions` |
| `OPENAI_API_KEY` | 接続確認済みの既存キー |
| `ODDSHOT_DRIVE_MODE` | `google` |
| `GOOGLE_CLIENT_ID` | 現在と同じ OAuth クライアント ID |
| `GOOGLE_CLIENT_SECRET` | 現在と同じクライアントシークレット |
| `GOOGLE_DRIVE_FOLDER_ID` | 現在と同じ保存先フォルダ ID |
| `GOOGLE_REDIRECT_URI` | `https://公開ドメイン/api/admin/drive/callback` |
| `ODDSHOT_ADMIN_SECRET` | 現在の管理用パスワード |
| `ODDSHOT_GOOGLE_CREDENTIALS_KEY` | **現在と同じ暗号化キー** |
| `ODDSHOT_SYNC_SECRET` | 現在の再試行用シークレット |

公開ドメインが決まったら、同じ Google OAuth クライアントの承認済みリダイレクト URI に `https://公開ドメイン/api/admin/drive/callback` を追加します。ローカルの URI は残せます。同じ DB・クライアント・保存先・暗号化キーと有効な refresh token を使う場合、URL 変更だけで既存の Drive 保存許可を取り直す必要はありません。「テスト中」の場合は上記の有効期限への対応が必要です。

Cloudflare 側は専用 Worker を現行ソースへ更新し、`ODDSHOT_SYNC_CALLBACK_URL=https://公開ドメイン/api/admin/drive/process` と Vercel と同じ `ODDSHOT_SYNC_SECRET` を登録して、1分間隔の Cron Trigger を設定します。既存の D1 binding と接続トークンは保持します。この定期処理はまだ本番に設定していません。公開後、写真投稿 → AI採点とタイトル提案 → D1保存 → Drive保存、および再試行の動作を確認します。

Cloudflare のアカウント ID・DB ID・管理用 API トークンは、Vercel アプリの実行時には不要です。Google の refresh token も DB に暗号化保存済みなので、環境変数として追加する必要はありません。

## 画面とデザイン

指定の `~/.agents/skills/ui-ux-pro-max` を読み、写真中心のギャラリーと編集的な構成を採用しました。生成したデザイン指針とアプリ用の調整内容は `design-system/oddshot/` にあります。

配色は宇宙を思わせる濃紺・深い紫のグラデーションに、金色のアクセントを合わせています。背景の星とヒーローの星座がゆっくりきらめき、ボタンに触れると光が流れます。写真・ランキング・参加者登録などの画面構成は維持しています。

PC・タブレット・スマートフォンに対応し、フォーカス表示、ダイアログのキーボード操作、動きを抑える設定、読み上げ向けの状態通知を用意しています。

写真サンプルは [Unsplash](https://unsplash.com/license) の公開画像です。使用画像ID：`photo-1511497584788-876760111969`、`photo-1462331940025-496dfbfc7564`、`photo-1478436127897-769e1b3f0f36`、`photo-1600210492486-724fe5c67fb0`、`photo-1540959733332-eab4deabeeaf`、`photo-1497215842964-222b430dc094`。
