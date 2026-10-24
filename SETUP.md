# ふぁみぽぽの起動とSupabase設定

## 現在の反映状況

- `wishbridge-dev` に `20261025010000` までの全21マイグレーションを適用済みです。
- ローカルのサーバー用 `.env` にSupabase接続設定を保存済みです。値はGitや画面へ出していません。
- Googleプロバイダーの有効化は未完了です。
- 戻り先URLはローカルconfig.tomlに記述済みですが、現在ログインしているアカウントではAuth設定更新が403（権限不足）になり、リモートには未反映です。管理権限のあるアカウントで、Authentication → URL Configuration → Redirect URLsに `http://localhost:3000/api/auth/google/callback**` を追加してください。
- Googleログイン後の状態を使う自動テストは `src/server/app.test.ts` にあります。実行時のみ隔離DBにセッションを作ります。本番の認証迂回機能はありません。

## 構成

普段使う入口は、このリポジトリの `npm start` です。Node.jsが `frontend/` と `src/server/` のAPIを同じURLで配信します。

ブラウザー → 認証・権限確認付きBE → Supabase / 既存AI制御、という経路です。GeminiやSupabaseの管理キーをFEへ渡しません。既存の `src/ai` をBEから利用し、この構成ではSupabase Edge Functionsの別途デプロイは不要です。旧 `src/connection` の契約テストは残していますが、画面の稼働APIは `src/server/app.ts` です。

## 1. DBを更新する

対象は `wishbridge-dev`（project ref: `ackeurmraqtfgaekubib`）です。SQLは `supabase/migrations/` に時刻順で保存しています。

既存DBには初期スキーマが入っているように見えますが、画面の表示だけで適用履歴は断定できません。Supabase CLIで履歴を確認してから未適用分を反映します。DBパスワードやアクセストークンはCLIの入力画面に入力し、チャットやGitへ貼り付けないでください。

```sh
npx supabase login
npx supabase link --project-ref ackeurmraqtfgaekubib
npx supabase migration list
npx supabase db push --dry-run
```

ローカル・リモートの履歴が整合し、対象が未適用のSQLだけであることを確認してから実行します。

```sh
npx supabase db push
```

初期スキーマをSQL Editorで手動作成した場合など、実際のスキーマと履歴が違うときは、まず差分を照合してください。実行済みと未実行を推測して `migration repair` を行ったり、既存DBを `reset` したりしないでください。CLIを使わない場合は、SQL Editorで**未適用のファイルだけ**時刻順に実行します。

今回の追加分は `20261024090000` 〜 `20261024120000`。その前のマイグレーションも前提です。個別相談、提案の明示送信、購入時の引き落とし、AI処理の排他制御、累計ポイントなどを追加します。過去の学習関連テーブルはデータ保護のため残しますが、アプリから利用しません。

## 2. Googleログインを設定する

1. Google Cloud側でWebアプリのOAuthクライアントを作成し、承認済みリダイレクトURIに以下を設定します。
   `https://ackeurmraqtfgaekubib.supabase.co/auth/v1/callback`
2. Supabase AuthenticationのGoogleプロバイダーに、そのClient ID / Client Secretを設定して有効にします。
3. AuthenticationのURL Configurationで、Site URLをアプリのURLに設定します。ローカルなら `http://localhost:3000` です。
4. Redirect URLsに `http://localhost:3000/api/auth/google/callback**` を追加します。末尾のワイルドカードは、アプリが発行する一回のログイン処理用の `?flow=...` を許可するためです。公開時は実際のHTTPSドメインに置き換えた同じパスを追加します。
5. Google OAuthがテスト公開の状態なら、利用する保護者のGoogleアカウントをテストユーザーに追加します。

保護者だけがGoogleログインします。子どもは招待コードまたはQR→保護者による確認番号の照合→子ども側で接続完了、という流れです。

公式資料：[Googleログイン](https://supabase.com/docs/guides/auth/social-login/auth-google)、[Redirect URLs](https://supabase.com/docs/guides/auth/redirect-urls)、[PKCE](https://supabase.com/docs/guides/auth/sessions/pkce-flow)。

## 3. サーバーの環境変数

Node.js 24以上を使用します。既存の `.env` がある場合は上書きせず、不足する項目を追加してください。新規の場合は `.env.example` を `.env` にコピーします。

| 変数 | 設定内容 |
| --- | --- |
| APP_ORIGIN | ブラウザーで開くURL。ローカルは `http://localhost:3000`、公開時はHTTPS。末尾のパスなし |
| HOST / PORT | ローカルは `127.0.0.1` / `3000`。公開ホストの要件に合わせてHOSTを `0.0.0.0` に変更 |
| SUPABASE_URL | `https://ackeurmraqtfgaekubib.supabase.co` |
| SUPABASE_PUBLISHABLE_KEY | SupabaseのAPI Keysで取得。旧キーは代わりに `SUPABASE_ANON_KEY` でも可 |
| SUPABASE_SERVICE_ROLE_KEY | サーバー専用の旧service_roleキー。新しいsecretキーは代わりに `SUPABASE_SECRET_KEY` でも可 |
| SESSION_SECRET | 32文字以上のランダムな秘密文字列 |
| GEMINI_API_KEY | Gemini APIキー。商品検索でGoogle Search groundingを利用できる設定が必要 |

SESSION_SECRETの生成例：

```sh
node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))"
```

値は `.env` または公開先のサーバー用環境変数へ保存します。`VITE_` などブラウザーへ埋め込む変数にしないでください。

```sh
npm install
npm start
```

`http://localhost:3000` を開きます。`127.0.0.1` との混用はOrigin検証で拒否されるため、APP_ORIGINと同じURLを使ってください。

## 4. 公開環境とは

家族の別の端末からもアクセスできるよう、Node.jsサーバーをHTTPSで動かす場所です。SupabaseはDB・認証のサービスで、このNode.jsアプリのホスティングとは別です。静的ファイルだけの公開ではBEが動きません。

公開先では `npm start` を実行し、APP_ORIGINを公開URLに変更して、同じ環境変数とGoogleログイン設定を登録します。QRもこのURLを参照します。localhostのQRは別のスマートフォンから利用できません。公開前の端末接続確認には、同じPCの別ブラウザープロファイルを使用できます。

現状のリクエスト制限と画像キャッシュはプロセス内です。複数台で運用する場合は共有のレート制限が必要です。報酬・購入・提案・AI処理の整合性はDB側のトランザクションで守ります。

## 5. 実接続で確認する流れ

1. 保護者がGoogleログインし、自分のプロフィールを入力する。
2. 子どもを登録し、誕生日・学年・目標金額の目安・お手伝いの希望を設定する。
3. 招待を発行し、別ブラウザーで接続申請→保護者が番号を照合して承認→子どもが接続を完了する。招待は5分で期限切れ。必要なら保護者がGoogleで再認証する。
4. 子どもが好きなことを入力し、ぽぽに相談する。親子の会話履歴は互いに表示されないことを確認する。
5. 商品を選び、提案を確認・編集・保存してから相手に送る。相手の賛成で目標になる。
6. 親からのお手伝い依頼、子からのお手伝い提案を試す。報酬は開始前に10ポイント単位で決める。
7. 子の完了報告を親が承認すると一度だけ加算される。購入済みにすると商品価格分だけ引かれ、累計獲得ポイントは減らない。
8. 3商品の小さいカードを押すと、そのカードと大きいカードの位置が交換されることを確認する。

商品画像は商品ページのOG/TwitterメタデータからBEが取得し、認証付きURLで配信します。販売サイトの制限やメタデータの欠落で画像を取得できない場合は代替表示になります。商品価格は取得時点の目安で、購入前に保護者が販売元で確認します。子ども側には外部販売リンクを表示しません。

## 検証の範囲

型検査、既存AI・接続契約テスト、ローカルPostgreSQL互換環境のマイグレーション/APIテスト、画像取得の安全性テスト、ブラウザーの操作確認を行っています。Google/Supabase/Geminiの実接続と実商品サイトの画像取得は、上記の設定後に確認が必要です。`/api/health` の `configured` は設定値の有無を示し、DBへの接続成功を保証しません。

必要な範囲だけ検証する場合：

```sh
npm run typecheck
node --test src/server/app.test.ts
node --test src/server/preview.test.ts
```

`npm test` は全テストです。同じ条件で通ったテストを毎回繰り返す必要はありません。


## 個別相談と共有交渉のフェーズ

`20261025010000_chat_phases.sql` は通常DBにも適用済みです。会話を作成しただけでは入力できず、「個別相談を開始する」で送信を許可します。提案送信後は返事待ちになり、個別相談の送信を閉じます。No・修正依頼で共有交渉が開始し、同じ版への双方の賛成で目標を登録して終了します。開始前・返事待ち・終了後の送信は画面とAPI・DBで拒否します。

個別相談と共有交渉の履歴は別に保存します。個別履歴は交渉へコピーしません。修正提案の下書きは作成者だけに見え、確認・編集して明示送信した内容を相手へ公開します。お手伝いの依頼・報告・承認はホームで行います。

既存の個別履歴は保持します。未送信の古い会話は開始前として表示し、明示的に開始した後に続けられます。送信済みの会話は提案の状態に従って閲覧または共有交渉へ進みます。

## 手元専用デモ

```sh
npm run demo
```

`http://localhost:3001/demo` から入ります。保護者・子ども各1人、0ポイント、会話・目標・お手伝いなしで始まります。デモ操作画面で初期化できます。親子接続は同じPCの別ブラウザーで確認してください。

通常版とは起動入口・DB・Cookieが別です。データはメモリ内だけに保存され、通常のSupabaseへ接続しません。AIは既存の `GEMINI_API_KEY` を使います。詳細は [demo/README.md](demo/README.md) を参照してください。

通常の `npm start` にデモ認証や初期化APIは追加されません。公開時も通常のログインが必要です。デモはループバックに限定し、公開用として起動できない構成です。
