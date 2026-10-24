// 画面に表示する仮データ。バックエンドができたら、ここをAPIから取得した値に置き換える。
// image にファイルパス（例: 'images/game.png'）を入れると、絵文字の代わりに画像が表示される。
window.DATA = {
  user: { name: 'たけし', avatar: '👦' },
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

  messages: [
    { from: 'ai', text: 'たけしくん、3日つづけて宿題を出せたね！その調子だよ。' },
    { from: 'me', text: 'ゲーム機がほしいんだけど、まだまだかな？' },
    { from: 'ai', text: 'あと3766ptだよ。今のペースだと10週間くらいかな。とちゅうでクッキーを目標にしてみない？' },
    { from: 'me', text: 'いいね、そうする！' },
  ],

  // トーク画面で送信したときの仮の返事（順番に使う）
  mockReplies: [
    'なるほど！おうちの人にも伝えてみるね。',
    'いいね！どの宿題からやってみる？',
    '1日できなくても大丈夫。また明日から続けよう！',
  ],
};
