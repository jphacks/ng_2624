// 画面に表示する仮データ。
// ポイント・目標・課題は、まだ取得するAPIがないので、ここの値をそのまま表示している。
// 子どもからの「お手伝いの提案」もAPIがないので、app.js の中だけで持っている（再読み込みで消える）。
// image にファイルパス（例: 'images/game.png'）を入れると、絵文字の代わりに画像が表示される。
window.DATA = {
  user: { name: 'たけし', avatar: '👦' },
  parent: { name: 'おうちの人', avatar: '🧑' },
  ai: { name: 'ふぁみぽぽAI', avatar: '🕊️' },

  points: 1234,
  weeklyPace: 400,

  mainGoal: {
    name: 'ゲーム機',
    emoji: '🎮',
    image: '',
    requiredPoints: 5000,
    url: 'https://example.com/products/game',
  },

  subGoals: [
    { name: 'サッカーボール', emoji: '⚽', image: '', requiredPoints: 1500, url: 'https://example.com/products/ball' },
    { name: 'クッキー', emoji: '🍪', image: '', requiredPoints: 300, url: '' },
  ],

  tasks: [
    { id: 't1', title: 'さんすうしゅくだい', due: '10/31', reward: 10, status: 'todo' },
    { id: 't2', title: 'おへやのそうじ', due: '11/1', reward: 8, status: 'todo' },
    { id: 't3', title: 'かんじドリル', due: '11/2', reward: 10, status: 'todo' },
    { id: 't4', title: 'こくごのおんどく', due: '11/3', reward: 5, status: 'todo' },
    { id: 't5', title: 'しょっきのかたづけ', due: '11/4', reward: 5, status: 'todo' },
  ],

  // トーク画面を開いたときのあいさつ（画面にだけ出す。会話の記録には残さない）
  childGreeting: 'こんにちは！ほしいものや、すきなことを教えてね。',

  // ↓ ここから下は仮バックエンド（api.js の仮モード）が使うデータ

  // 子どものトークで送信したときの仮の返事（順番に使う）
  // product: true の番では、AIが商品を探した想定で mockProductReply を返す。
  mockReplies: [
    { text: 'いいね！それは練習でつかうもの？それとも見て楽しむもの？' },
    { product: true },
    { text: '気になる商品があったら「これにする」をおしてね。おうちの人への提案を下書きするよ。' },
    { text: '1日できなくても大丈夫。また明日から続けよう！' },
  ],

  // AIが商品を探したときの仮の返事（AIの返事 AIOutput と同じ形）
  // URLは見本のページ。本物のAIにつなぐと実際の商品ページになる。
  mockProductReply: {
    action: 'PRODUCT',
    reply: '大中小それぞれ1件の候補が見つかりました。気になるものを1つ選んでください。 表示価格は検索時の参考価格です。',
    products: [
      {
        id: 'mock-1', size: 'small', name: 'サッカー練習用 マーカーコーン 10枚セット', priceJpy: 980,
        productUrl: 'https://example.com/products/marker', imageUrl: null,
        description: 'ドリブル練習に使えるコーン。', recommendationReason: 'ひとりでもドリブル練習ができるよ。',
        sourceUrls: [],
      },
      {
        id: 'mock-2', size: 'medium', name: 'サッカーボール 4号球（小学生用）', priceJpy: 3180,
        productUrl: 'https://example.com/products/ball', imageUrl: null,
        description: '小学生の公式サイズ。', recommendationReason: '練習でも試合でも使える大きさだよ。',
        sourceUrls: [],
      },
      {
        id: 'mock-3', size: 'large', name: 'ジュニア用 サッカースパイク', priceJpy: 9800,
        productUrl: 'https://example.com/products/spike', imageUrl: null,
        description: '芝・土の両方で使えるスパイク。', recommendationReason: '走りやすくなって、練習がもっと楽しくなるよ。',
        sourceUrls: [],
      },
    ],
    search: {
      queries: [],
      sources: [{ id: 'source-1', title: '見本ショップ', url: 'https://example.com/' }],
      searchSuggestionsHtml: null,
    },
  },

  // 「これにする」を押したときの提案の下書き（本番ではAIが作る）
  // {name} は商品名、{deadline} は2週間後の日付に置き換わる。
  draftTemplate: {
    persuasionText: '「{name}」がほしいです。そのかわり、下のやくそくをがんばります。',
    purchaseConditions: [
      '今週の平日5日のうち4日、宿題を提出する',
      '1日できなくても、つづけた記録はリセットしない',
      '{deadline}まで',
    ],
  },

  // 親のAIトークの仮の返事（順番に使う）
  parentMockReplies: [
    '条件は「平日5日のうち4日」で、1日休んでも続けられるようになっています。無理のない内容だと思います。',
    '金額が気になる場合は、「修正をお願い」で期限を延ばしたり、条件を足したりできます。理由は子どもに伝わるので、やさしい言葉で書くのがおすすめです。',
    '見送る場合も、理由を添えると子どもが次の提案を考えやすくなります。',
  ],
};
