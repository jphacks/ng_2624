# 会話AIモジュール

`src/ai/index.ts`の`createReply(input)`が、共通型v0.4（`src/shared/types.ts`）の`AIInput`を受け取り、`AIOutput`を返す。
個別相談、Amazonの商品検索、提案下書き、再交渉を扱う。BEが認証・共有許可・保存・送信・承認・合意成立判定・目標登録を担当する。

## ファイル構成

| ファイル | 役割 |
| --- | --- |
| `index.ts` | BE向け公開入口・型のexport |
| `conversation.ts` | モード分離、検索・提案の制御、予算・価格・状態の検証 |
| `validation.ts` | 入力検証、交渉結果の参照整合性、未知の属性の除外 |
| `prompt.ts` | 個別相談と共有情報だけの交渉コンテキストの構築 |
| `protocol.ts` | 生成JSONのSchemaと検証 |
| `search.ts` | 大中小の並列検索・候補選定・価格根拠の検証 |
| `amazon.ts` | Amazonの検索結果から同じ商品カード内の商品名・ASIN・表示価格を取得 |
| `gemini.ts` | Geminiへの接続。モデル名、タイムアウト、再試行設定を管理する |
| `errors.ts` | 内部のエラー区分と、利用者へ返せるエラー文を作る |
| `demo.ts` / `smoke.ts` | デモ入力／明示実行する実API確認 |
| `conversation.test.ts` | APIを呼ばずに情報分離・交渉結果・既存機能を検証する |

## 単体実行

Node.js 24で、プロジェクトルートから従来と同じコマンドを使う。

```sh
node --env-file=.env src/ai/conversation.ts
```

.envのキーでGeminiを呼び出し、検索時はAmazonの大中小の価格帯を並列に取得する。`.env`に`GEMINI_API_KEY`を設定する。
通常会話・商品選定の既定モデルは`gemini-3.8-flash`。商品選定は短い思考設定を使い、希望の全条件一致を要求せず妥協点を明記する。Amazon以外の商品は候補に含めない。
検索と商品選定の共通上限は30秒。Amazon取得は各8秒、商品選定のSDK設定は10秒。SDKの自動再試行は無効。
この時間は処理を無期限に待たせないための技術上の初期設定であり、会話や課題の期限とは別のもの。
エラー時はエラー区分と説明を表示し、終了コード1で終了する。

## 他の処理から使う

```ts
import { createReply } from './src/ai/index.ts';

const output = await createReply(input);
```

`input`は`AIInput`。通常の呼び出しで第2引数は不要。
import時にはAPI通信もデモ実行も行わず、APIキーは実際の生成時に使う。
テストでは第2引数へ`{ generate }`を渡し、実APIを呼ばずに動作を確認する。

## 入力と情報の境界

`mode`はBEが明示する。発言やモデルの判断から共有許可を確定しない。

| フィールド | 用途・BEの保証 |
| --- | --- |
| `requestId` / `now` / `role` | 追跡ID、タイムゾーン付き現在時刻、認証済みの相談者 |
| `mode` | `consultation`（本人の個別相談）または`negotiation`（共有情報での検索・提案・再交渉） |
| `message` | 今回の本人の非公開発言。交渉モードではモデルへ渡さない |
| `history` | 本人だけの`ChatMessage[]`。今回の発言を含めない。交渉では渡さない |
| `profile` | 本人の`AIUserProfile`または`null`。交渉では渡さない |
| `sharedConditions` | 有効な共有許可のある`SharedCondition[]`。空なら`[]` |
| `constraints` | 共有範囲を検証済みの予算上限・必須条件・除外条件 |
| `products` / `selectedProductId` | 今回の共有先に公開できる商品候補と選択ID。未選択は`null` |
| `currentProposal` | 今回の共有先に公開できる正式な提案、または`null` |
| `negotiationResult` | BEが確定し共有範囲を検証済みの交渉結果、または`null` |

v0.3から入力契約を変更した。`history: { parent, child }`は廃止し、本人の配列にする。`profiles`は本人の`profile`に置き換える。`mode`・`sharedConditions`・`negotiationResult`は必須。旧形式やmode未指定の入力はAPI通信前に拒否する。`createReply(input, dependencies?)`と出力の形は維持する。

### 個別相談

`consultation`は本人の`message`・`history`・`profile`と共有済み情報を参照し、本人へ`HEARING`を返す。相手の個別履歴を渡してはいけない。モデルが検索や下書きを返しても、コード側で検索・提案へ進ませず、共有操作の案内へ戻す。

### 交渉・検索・提案

`negotiation`は`sharedConditions`・購入制約・商品・選択ID・現在の提案・交渉結果だけを参照する。今回の`message`、個別履歴、非公開プロフィール、個別相談のモデル出力は判断・検索・提案のいずれにも渡さない。非公開情報が混在していても明示的な項目選別で除く。

希望・年齢・変更要求・購入条件を交渉で使う場合、本人が共有する対象を選び、BEが有効な共有情報として再構築する。単に`message`に検索や修正を頼んでも交渉には反映しない。共有操作の画面はFE・BEとの調整事項。

BEは全フィールドの由来と共有範囲を確認する。商品説明・選定理由・現在の提案・交渉結果の理由・制約に未共有情報を混ぜてはならない。プロフィール由来の年齢や興味も、共有許可がある内容だけを`sharedConditions`へ載せる。

### 共有許可の管理

`SharedCondition`は`id`・`sourceUserId`（許可した本人）・`targetUserId`（共有先）・`content`・`approvedAt`を持つ。AIは形式を検証するが、同意の実在、本人・家族関係、共有先、有効期限や取り消しを認証できない。BEはクライアントが送った許可メタデータを信用せず、保存した同意記録を参照する。

取り消し後は、共有条件だけでなく、対象情報を含む商品・提案・交渉結果・本人の相談履歴等から今回の共有先へ渡せなくなった情報をBEが選別し直す。既に相手へ送信済みの情報は取り消しだけで回収できない。AIは呼び出しをまたぐ履歴・許可を保存せず、Geminiには`store: false`で各回独立に送る。

## 交渉結果と次回の呼び出し

`negotiationResult`の例：

```ts
{
  proposalId: 'proposal-1',
  version: 2,
  decision: 'revision_requested', // 'approved' | 'rejected' も可
  reason: '宿題4日では負担が大きいので3日に変更してほしい。',
}
```

拒否・修正希望は共有可能な理由が必須。承認の理由は`null`でもよい。結果の提案ID・versionは`currentProposal`と一致しなければ通信前に拒否する。過去versionの結果を新しい提案に付け替えず、該当する現在の結果がなければ`null`にする。

BEは本人の操作結果を保存し、許可範囲を再選別して次回の`createReply`を開始する。AIは共有された理由に沿った相談や修正下書きを返す。修正下書きの`basedOn`は現在の提案ID/version。AIは承認結果や提案状態を書き換えず、承認を合意成立と判定しない。

## 処理と出力

通常はGeminiを1回呼ぶ。交渉で検索が必要なら判断→Google Search→出典からの商品整形の最大3回。検索クエリは共有情報から生成し、名前や家族の事情を入れないよう指示する。

- `HEARING`：本人への相談・質問。
- `PRODUCT`：最大3件の商品候補と検索出典。URLは検索出典から採用し、裏付けのない価格は`null`。
- `PROPOSAL`：選択商品の提案文・購入条件・相手宛ての下書き。
- `NEGOTIATION`：修正下書き、または相談だけなら`proposalDraft: null`。

予算超過、価格不明・古い価格、未選択、必須条件の適合不明では下書きを止める。`agreed`・`superseded`の提案は改訂しない。検索が候補0件でも`search`の出典表示データは保持する。表示価格は参考価格で購入時価格の保証ではない。

## 検証

```sh
npm test
npm run typecheck
```

どちらもAPI通信は行わない。生成文の自然さやプロンプトの遵守は、実APIで別途確認する。
