(function () {
  'use strict';

  const DATA = window.DATA;
  const API = window.API; // バックエンドとのやりとりは、すべて api.js を通す

  // 画面の状態。会話や提案の中身はバックエンド（仮モードでは仮バックエンド）が持ち、
  // ここには「どれを見ているか」と、取得した結果の控えだけを持つ。
  const state = {
    rewardProducts: [],
    rewardSources: [],
    tasksExpanded: false,
    role: null, // 'child' | 'parent'
    points: DATA.points,
    tasks: DATA.tasks.map((t) => ({ ...t })),
    taskProposals: [], // 子どもが提案したお手伝い（課題一覧と同じく、APIがまだないので画面の中だけで持つ）
    taskReviewId: null, // 親が見ているお手伝いの提案のID
    childConversationId: null,
    parentConversationId: null,
    editing: null, // 子どもが編集中の提案 { proposal, product }
    received: [], // 親に届いた提案（proposals.received の結果）
    reviewId: null, // 親が見ている提案のID
  };

  const $ = (id) => document.getElementById(id);

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function yen(n) {
    return '¥' + n.toLocaleString('ja-JP');
  }

  // https のURLだけを使う（javascript: などのおかしなリンクを防ぐ）
  function safeUrl(value) {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' ? url.href : null;
    } catch {
      return null;
    }
  }

  function externalLink(className, text, href) {
    const a = el('a', className, text);
    a.href = href;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    return a;
  }

  function showError(id, text) {
    const box = $(id);
    box.textContent = text;
    box.hidden = false;
  }

  function hideError(id) {
    $(id).hidden = true;
  }

  // ---- 目標までの計算 ----
  function remainingPoints(goal) {
    return Math.max(0, goal.requiredPoints - state.points);
  }

  function weeksNeeded(goal) {
    const rest = remainingPoints(goal);
    return rest === 0 ? 0 : Math.ceil(rest / DATA.weeklyPace);
  }

  // 画像があれば画像、なければ絵文字を出す
  function goalVisual(goal) {
    if (goal.image) {
      const img = el('img', 'goal-img');
      img.src = goal.image;
      img.alt = goal.name;
      return img;
    }
    const span = el('span', 'goal-emoji', goal.emoji);
    span.setAttribute('role', 'img');
    span.setAttribute('aria-label', goal.name);
    return span;
  }

  // ---- 提案の状態 ----
  // 提案の status と、親の回答（negotiationResult）から表示用の状態を決める
  function statusKey(proposal, result) {
    if (proposal.status === 'pending') return 'pending';
    if (proposal.status === 'agreed') return 'approved';
    if (result && result.decision) return result.decision;
    return proposal.status === 'rejected' ? 'rejected' : 'pending';
  }

  const CHILD_STATUS = {
    pending: '返事待ち',
    approved: 'OK！',
    revision_requested: '修正のおねがい',
    rejected: '今回は見送り',
  };
  const PARENT_STATUS = {
    pending: '未回答',
    approved: 'OK済み',
    revision_requested: '修正をお願い済み',
    rejected: '見送り済み',
  };

  // ---- 初期画面 ----
  function renderStart() {
    hideError('start-error');
    let hint = API.mode === 'mock'
      ? '試作版（仮のバックエンドで動作中）：同じブラウザで切り替えると、子どもが送った提案が親の画面に届きます'
      : 'おうちの人はGoogleアカウントでログインできます。';
    if (API.mode === 'mock' && API.aiMode === 'supabase') hint += '（子どものトークのAIの返事だけ、本物のバックエンドにつないでいます）';
    $('start-hint').textContent = hint;
  }

  async function startAs(role) {
    hideError('start-error');
    if (API.mode === 'mock') {
      API.signInAs(role);
      state.role = role;
      location.hash = role === 'parent' ? 'parent' : 'home';
      return;
    }
    // 本番モード：ログイン状態をバックエンドに確認する
    try {
      const session = await API.auth.session();
      if (session.authenticated && session.user.role === role) {
        state.role = role;
        location.hash = role === 'parent' ? 'parent' : 'home';
      } else if (role === 'parent') {
        location.assign(API.googleLoginUrl()); // Googleログインは画面ごと移動する
      } else {
        showError('start-error', '子どもの端末は、おうちの人のQRコードから接続してください。（接続画面は準備中です）');
      }
    } catch (err) {
      showError('start-error', API.errorMessage(err));
    }
  }

  // ---- 子どもホーム ----
  function renderHome(isCurrent) {
    $('home-points').textContent = state.points.toLocaleString('ja-JP');
    $('home-pace').textContent = DATA.weeklyPace;

    const goal = DATA.mainGoal;
    $('main-goal-visual').replaceChildren(goalVisual(goal));
    $('main-goal-name').textContent = goal.name;
    $('main-goal-link').hidden = !goal.url;
    $('main-goal-link').href = goal.url || '#';

    const info = $('main-goal-info');
    const rest = remainingPoints(goal);
    if (rest === 0) {
      info.replaceChildren(el('span', 'goal-ready', 'こうかんできるよ！'));
    } else {
      const line = el('span', 'goal-remaining', 'あと ');
      line.append(el('b', 'num-big', rest.toLocaleString('ja-JP')), ' pt');
      info.replaceChildren(line);
    }
    $('goal-progress').value = Math.min(100, state.points / goal.requiredPoints * 100);
    $('goal-estimate').textContent = rest === 0 ? 'もくひょうたっせい！' : '目標まで ' + weeksNeeded(goal) + ' 週間くらい';

    const subs = $('sub-goals');
    subs.replaceChildren();
    DATA.subGoals.forEach((sub) => {
      const btn = el('button', 'goal-sub');
      btn.type = 'button';
      btn.setAttribute('aria-label', sub.name + 'の詳細');
      btn.append(goalVisual(sub), el('span', 'goal-sub-label', sub.name));
      btn.addEventListener('click', () => openSheet(sub));
      subs.append(btn);
    });

    renderTasks();
    renderTaskProposals();
    loadMyProposal(isCurrent);
  }

  // 子どもが送った提案と、親の返事（会話の currentProposal から取得）
  async function loadMyProposal(isCurrent) {
    const box = $('my-proposals');
    if (!state.childConversationId) {
      box.hidden = true;
      return;
    }
    try {
      const view = await API.conversations.get(state.childConversationId);
      const p = view.currentProposal;
      if (!isCurrent()) return;
      if (!p || p.status === 'draft') {
        box.hidden = true;
        return;
      }
      const { negotiationResult } = await API.proposals.get(p.id);
      if (!isCurrent()) return;
      const product = view.products.find((x) => x.id === p.productId);
      const status = statusKey(p, negotiationResult);

      const li = el('li', 'my-proposal is-' + status);
      const head = el('div', 'my-proposal-head');
      head.append(
        el('span', 'my-proposal-name', product ? product.name : '提案した商品'),
        el('span', 'status-badge is-' + status, CHILD_STATUS[status]),
      );
      li.append(head);
      if (status === 'approved') li.append(el('p', 'my-proposal-note', 'もくひょうになったよ！がんばろう！'));
      if (negotiationResult && negotiationResult.reason) {
        li.append(el('p', 'my-proposal-note', 'おうちの人より：' + negotiationResult.reason));
      }
      $('my-proposal-list').replaceChildren(li);
      box.hidden = false;
    } catch {
      box.hidden = true; // ホームの表示は止めない
    }
  }

  function renderTasks() {
    const list = $('task-list');
    list.replaceChildren();
    (state.tasksExpanded ? state.tasks : state.tasks.slice(0, 2)).forEach((task) => {
      const submitted = task.status === 'submitted';
      const btn = el('button', 'task' + (submitted ? ' is-submitted' : ''));
      btn.type = 'button';
      btn.setAttribute('aria-pressed', String(submitted));
      const icon = /そうじ/.test(task.title) ? '🧹' : /しょっき/.test(task.title) ? '🍽️' : /おんどく/.test(task.title) ? '📖' : '✏️';
      const taskIcon = el('span', 'task-icon', icon);
      taskIcon.setAttribute('aria-hidden', 'true');
      btn.append(
        taskIcon,
        el('span', 'task-title', task.title),
        submitted ? el('span', 'badge', '承認待ち') : el('span', 'task-due', '期限 ' + task.due),
        el('span', 'task-reward', '¥' + task.reward),
      );
      // タップで「提出済み（承認待ち）」と「未提出」を切り替える
      btn.addEventListener('click', () => {
        task.status = submitted ? 'todo' : 'submitted';
        renderTasks();
      });
      const li = el('li');
      li.append(btn);
      list.append(li);
    });
  }

  $('goal-details').addEventListener('click', () => openSheet(DATA.mainGoal));
  $('task-toggle').addEventListener('click', () => {
    state.tasksExpanded = !state.tasksExpanded;
    $('task-toggle').setAttribute('aria-expanded', String(state.tasksExpanded));
    $('task-toggle').textContent = state.tasksExpanded ? 'とじる ⌃' : 'ぜんぶみる ›';
    renderTasks();
  });

  // ---- お手伝いの提案（子ども → 親） ----
  // 子どもは「やること」だけを提案し、ごほうびと期限は親が承認するときに決める。
  // まだAPIがないので、課題一覧と同じく画面の中だけの仮データで動かす（docs/frontend-design.md の 3-2）。
  // 1件の形：{ id, title, note, status: 'pending' | 'approved' | 'rejected', modified, reason, proposedAt, task }
  //   modified … 親が内容を直して承認したら true
  //   task ...... 承認したときに親が決めた内容 { title, reward, due }
  const TASK_CHILD_STATUS = { pending: '返事待ち', approved: 'OK！', rejected: '今回は見送り' };
  const TASK_PARENT_STATUS = { pending: '未回答', approved: '承認済み', rejected: '見送り済み' };
  let taskProposalSeq = 0;

  function findTaskProposal(id) {
    return state.taskProposals.find((p) => p.id === id) || null;
  }

  function todayString() {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  // '2026-10-31' → '10/31'（課題一覧の期限の表示に合わせる）
  function formatDue(date) {
    const [, month, day] = date.split('-');
    return Number(month) + '/' + Number(day);
  }

  // 子どもホーム：提案したお手伝いと、親の返事
  function renderTaskProposals() {
    const items = state.taskProposals.slice().reverse(); // 新しい順
    $('task-proposals').hidden = items.length === 0;
    $('task-proposal-list').replaceChildren(...items.map((p) => {
      const li = el('li', 'my-proposal is-' + p.status);
      const head = el('div', 'my-proposal-head');
      head.append(
        el('span', 'my-proposal-name', p.title),
        el('span', 'status-badge is-' + p.status, TASK_CHILD_STATUS[p.status]),
      );
      li.append(head);
      if (p.status === 'approved') {
        li.append(el('p', 'my-proposal-note', p.modified
          ? 'おうちの人が「' + p.task.title + '」に直して、課題に入れたよ！'
          : '課題に入ったよ！がんばろう！'));
      }
      if (p.reason) li.append(el('p', 'my-proposal-note', 'おうちの人より：' + p.reason));
      return li;
    }));
  }

  // C3 お手伝いの提案（子ども）
  function renderTaskPropose() {
    $('task-propose-form').reset();
    hideError('task-propose-error');
  }

  $('task-propose-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const title = $('task-propose-title').value.trim();
    const note = $('task-propose-note').value.trim();
    if (!title) {
      showError('task-propose-error', 'やることを書いてね。');
      $('task-propose-title').focus();
      return;
    }
    state.taskProposals.push({
      id: 'task-proposal-' + (++taskProposalSeq),
      title,
      note: note || null,
      status: 'pending',
      modified: false,
      reason: null,
      proposedAt: new Date().toISOString(),
      task: null,
    });
    location.hash = 'sent';
  });

  // ---- 小目標の詳細シート ----
  let lastFocus = null;

  function openSheet(goal) {
    lastFocus = document.activeElement;
    $('sheet-visual').replaceChildren(goalVisual(goal));
    $('sheet-name').textContent = goal.name;
    const rest = remainingPoints(goal);
    $('sheet-text').textContent = rest === 0
      ? 'もうこうかんできるよ！おうちの人に伝えてみよう。'
      : 'あと ' + rest.toLocaleString('ja-JP') + ' pt（' + weeksNeeded(goal) + '週間くらい）';
    const link = $('sheet-link');
    link.hidden = !goal.url;
    link.href = goal.url || '#';
    $('sheet').hidden = false;
    document.querySelector('.app').inert = true;
    $('sheet-close').focus();
  }

  function closeSheet() {
    $('sheet').hidden = true;
    document.querySelector('.app').inert = false;
    if (lastFocus) lastFocus.focus();
  }

  $('sheet-close').addEventListener('click', closeSheet);
  $('sheet').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeSheet();
  });
  document.addEventListener('keydown', (e) => {
    if ($('sheet').hidden) return;
    if (e.key === 'Escape') closeSheet();
    if (e.key === 'Tab') {
      const nodes = [...$('sheet').querySelectorAll('a[href], button')].filter((node) => !node.hidden);
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  });

  // ---- 商品カード ----
  const SIZE_LABEL = { small: '小', medium: '中', large: '大' };
  const SIZE_ORDER = ['small', 'medium', 'large'];

  // onChoose を渡すと「これにする」ボタンが付く
  function productCardEl(product, onChoose) {
    const card = el('article', 'product-card');

    const visual = el('div', 'product-visual');
    const image = safeUrl(product.imageUrl);
    if (image) {
      const img = el('img');
      img.src = image;
      img.alt = '';
      visual.append(img);
    } else {
      const emoji = /ボール/.test(product.name) ? '⚽' : /スパイク|シューズ/.test(product.name) ? '👟' : /コーン/.test(product.name) ? '🔺' : '🎁';
      visual.append(el('span', 'goal-emoji', emoji));
    }

    const info = el('div', 'product-info');
    if (SIZE_LABEL[product.size]) info.append(el('span', 'product-size', SIZE_LABEL[product.size]));
    info.append(el('h4', 'product-name', product.name));
    if (typeof product.priceJpy === 'number') {
      info.append(el('p', 'product-price', '参考価格 ' + yen(product.priceJpy)));
    }
    if (product.recommendationReason) info.append(el('p', 'product-reason', product.recommendationReason));

    const actions = el('div', 'product-actions');
    const href = safeUrl(product.productUrl);
    if (href) actions.append(externalLink('product-link', '詳細（リンク）', href));
    if (onChoose) {
      const choose = el('button', 'product-choose', 'これにする');
      choose.type = 'button';
      choose.addEventListener('click', () => onChoose(product, choose));
      actions.append(choose);
    }
    if (actions.childElementCount) info.append(actions);

    card.append(visual, info);
    return card;
  }

  function productListEl(products, sources, onChoose) {
    const wrap = el('div', 'product-list');
    products
      .slice()
      .sort((a, b) => SIZE_ORDER.indexOf(a.size) - SIZE_ORDER.indexOf(b.size))
      .forEach((p) => wrap.append(productCardEl(p, onChoose)));

    const links = sources.map((s) => safeUrl(s.url)).filter(Boolean).slice(0, 5);
    if (links.length) {
      const note = el('p', 'product-sources', '参考にしたサイト：');
      links.forEach((href, i) => {
        if (i > 0) note.append(' / ');
        note.append(externalLink(null, new URL(href).hostname.replace(/^www\./, ''), href));
      });
      wrap.append(note);
    }
    return wrap;
  }

  // ---- チャット（子ども・親で共通） ----
  function messageEl(msg, me, onChoose) {
    const who = msg.from === 'ai' ? DATA.ai : me;
    const row = el('div', 'msg ' + (msg.from === 'ai' ? 'msg-ai' : 'msg-me'));
    const avatar = el('span', 'avatar' + (msg.from === 'ai' ? ' dove' : ''), msg.from === 'ai' ? '' : who.avatar);
    avatar.setAttribute('aria-hidden', 'true');
    const body = el('div', 'msg-body');
    const bubbleClass = 'bubble' + (msg.typing ? ' typing' : '') + (msg.error ? ' is-error' : '');
    body.append(el('span', 'msg-name', who.name), el('p', bubbleClass, msg.text));
    if (msg.products && msg.products.length) {
      if (onChoose) {
        const link = el('button', 'product-choose reward-chat-link', 'ごほうびの候補をみる →');
        link.type = 'button';
        link.dataset.go = 'rewards';
        body.append(link);
      } else body.append(productListEl(msg.products, msg.sources || [], onChoose));
    }
    row.append(avatar, body);
    return row;
  }

  // 会話（ConversationView）を表示し、送信を受け付けるチャット欄
  //   getId: 表示中の会話ID
  //   greeting: 先頭に出すあいさつ（画面にだけ出す）
  //   send: 送信して、描き直す会話を受け取る（省略時は conversations.message）
  //   needsId: 会話IDがないと送れないか（ai-reply は最初の送信で会話ができるので false）
  //   recheck: 保存されたか分からないときに、会話を取り直して確かめるか
  function createChat({
    listId, formId, me, getId, greeting, onChoose, typingText,
    send = (conversationId, text) => API.conversations.message(conversationId, text),
    needsId = true,
    recheck = true,
  }) {
    const list = $(listId);
    const form = $(formId);
    const input = form.querySelector('input');
    const submitBtn = form.querySelector('button');
    let productAnchorId = null; // 商品カードを付けるAIの発言のID

    function scrollToBottom() {
      list.scrollTop = list.scrollHeight;
    }

    function append(msg) {
      const node = messageEl(msg, me, onChoose);
      list.append(node);
      scrollToBottom();
      return node;
    }

    // バックエンドから受け取った会話を、そのまま描き直す
    function render(view) {
      const output = view.latestAIOutput;
      if (listId === 'child-messages') {
        state.rewardProducts = view.products;
        state.rewardSources = output && output.search ? output.search.sources : [];
        $('show-rewards').hidden = !view.products.length;
      }
      const assistants = view.messages.filter((m) => m.sender === 'assistant');
      if (output && output.action === 'PRODUCT' && assistants.length) {
        productAnchorId = assistants[assistants.length - 1].id;
      }
      const sources = output && output.search ? output.search.sources : [];

      const items = [];
      if (greeting()) items.push({ from: 'ai', text: greeting() });
      view.messages.forEach((m) => {
        const msg = { from: m.sender === 'user' ? 'me' : 'ai', text: m.content };
        if (m.id === productAnchorId && view.products.length) {
          msg.products = view.products;
          msg.sources = sources;
        }
        items.push(msg);
      });
      list.replaceChildren(...items.map((m) => messageEl(m, me, onChoose)));
      scrollToBottom();
    }

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const text = input.value.trim();
      const conversationId = getId();
      if (!text || submitBtn.disabled || (needsId && !conversationId)) return;

      input.value = '';
      append({ from: 'me', text });
      const typing = append({ from: 'ai', text: typingText(), typing: true });
      submitBtn.disabled = true;

      try {
        render(await send(conversationId, text));
      } catch (err) {
        const errorMsg = { from: 'ai', text: API.errorMessage(err), error: true };
        typing.replaceWith(messageEl(errorMsg, me));
        let saved = false;
        // 保存されたか分からないときは、取得し直して確かめる（自動で送り直さない）
        if (recheck && (err.stateMayHaveChanged || err.code === 'AI_UNAVAILABLE')) {
          try {
            const view = await API.conversations.get(conversationId);
            const mine = view.messages.filter((m) => m.sender === 'user');
            saved = mine.length > 0 && mine[mine.length - 1].content === text;
            render(view);
            append(errorMsg); // 描き直しで消えないように、エラーをもう一度出す
          } catch {
            // 取り直せなくても、出ているエラー表示はそのまま
          }
        }
        // 保存されなかった文は入力欄に戻す（送り直すかは本人が決める）
        if (!saved && !input.value) input.value = text;
      } finally {
        submitBtn.disabled = false;
        scrollToBottom();
      }
    });

    return { render, append };
  }

  // ---- 子どものトーク ----
  // 送信は BE の ai-reply（API.ai.reply）を通し、返ってきたAIの返事だけを表示する。
  // 会話の履歴を取り直す窓口はまだないので、やりとりは画面の中で覚えておく（再読み込みで消える）。
  const childTalk = { messages: [], products: [], latestAIOutput: null };
  let localMessageSeq = 0;

  // 画面の控えを、チャット欄が描ける会話の形（ConversationView と同じ項目）にする
  function childTalkView() {
    return {
      conversationId: state.childConversationId,
      messages: childTalk.messages,
      products: childTalk.products,
      latestAIOutput: childTalk.latestAIOutput,
    };
  }

  async function sendChildMessage(conversationId, text) {
    const { conversationId: nextId, ...output } = await API.ai.reply(text, conversationId);
    state.childConversationId = nextId; // 2回目からはこの会話IDで送る
    const at = new Date().toISOString();
    childTalk.messages.push(
      { id: 'local-' + (++localMessageSeq), sender: 'user', content: text, createdAt: at },
      { id: 'local-' + (++localMessageSeq), sender: 'assistant', content: output.reply, createdAt: at },
    );
    if (output.action === 'PRODUCT') childTalk.products = output.products;
    childTalk.latestAIOutput = output;
    return childTalkView();
  }

  const childChat = createChat({
    listId: 'child-messages',
    formId: 'child-composer',
    me: DATA.user,
    getId: () => state.childConversationId,
    greeting: () => DATA.childGreeting,
    onChoose: chooseProduct,
    typingText: () => '考え中…',
    send: sendChildMessage,
    needsId: false, // 最初の送信で、BEが会話を作る
    recheck: false, // 履歴を取り直す窓口がまだない
  });

  function renderTalk() {
    $('talk-points').textContent = state.points.toLocaleString('ja-JP');
    childChat.render(childTalkView());
  }

  // 「これにする」→ 商品を選ぶ → AIが提案の下書きを作る → 編集画面へ
  let choosingProduct = false;
  async function chooseProduct(product, button) {
    if (choosingProduct) return;
    choosingProduct = true;
    const buttons = document.querySelectorAll('#reward-products .product-choose');
    buttons.forEach((b) => { b.disabled = true; });
    button.textContent = '下書き中…';
    hideError('reward-error');
    const id = state.childConversationId;
    try {
      await API.conversations.selectProduct(id, product.id);
      const view = await API.conversations.generateProposal(id);
      if (!view.currentProposal) throw new Error('提案の下書きを受け取れませんでした。');
      if (state.role !== 'child' || state.childConversationId !== id) return;
      state.editing = { proposal: view.currentProposal, product };
      if (location.hash === '#rewards') location.hash = 'edit';
    } catch (err) {
      showError('reward-error', API.errorMessage(err));
    } finally {
      choosingProduct = false;
      buttons.forEach((b) => { b.disabled = false; });
      button.textContent = 'これにする';
    }
  }

  function renderRewards() {
    hideError('reward-error');
    const box = $('reward-products');
    if (!state.rewardProducts.length) {
      box.replaceChildren(el('p', 'empty-note', 'まずはぽぽに、ほしいものを教えてね。そうだんすると、ここに候補が届くよ。'));
      return;
    }
    box.replaceChildren(productListEl(state.rewardProducts, state.rewardSources, chooseProduct));
  }

  // ---- T2 提案の確認・送信（子ども） ----
  const MAX_CONDITIONS = 12;
  let editConditions = []; // 編集中のやくそく

  function renderEdit() {
    const { proposal, product } = state.editing;
    $('edit-product').replaceChildren(productCardEl(product));
    $('edit-text').value = proposal.persuasionText;
    editConditions = proposal.purchaseConditions.slice();
    hideError('edit-error');
    renderConditions();
  }

  function renderConditions() {
    $('edit-conditions').replaceChildren(...editConditions.map((text, i) => {
      const li = el('li', 'condition-item');
      const input = el('textarea');
      input.rows = 2;
      input.value = text;
      input.maxLength = 500;
      input.setAttribute('aria-label', 'やくそく' + (i + 1));
      input.addEventListener('input', () => { editConditions[i] = input.value; });
      const remove = el('button', 'condition-remove', '×');
      remove.type = 'button';
      remove.setAttribute('aria-label', 'やくそく' + (i + 1) + 'を消す');
      remove.addEventListener('click', () => {
        editConditions.splice(i, 1);
        renderConditions();
      });
      li.append(input, remove);
      return li;
    }));
    $('edit-add-condition').hidden = editConditions.length >= MAX_CONDITIONS;
  }

  $('edit-add-condition').addEventListener('click', () => {
    editConditions.push('');
    renderConditions();
    const inputs = $('edit-conditions').querySelectorAll('textarea');
    inputs[inputs.length - 1].focus();
  });

  $('edit-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const submitBtn = e.currentTarget.querySelector('button[type="submit"]');
    if (submitBtn.disabled) return;
    const text = $('edit-text').value.trim();
    const conditions = editConditions.map((c) => c.trim()).filter(Boolean);
    if (!text) return showError('edit-error', 'おねがいを書いてね。');
    if (!conditions.length) return showError('edit-error', 'やくそくを1つ以上書いてね。');
    hideError('edit-error');

    submitBtn.disabled = true;
    try {
      let proposal = state.editing.proposal;
      const changed = text !== proposal.persuasionText
        || JSON.stringify(conditions) !== JSON.stringify(proposal.purchaseConditions);
      // 直したところがあれば、先に保存する（新しい版になる）
      if (changed) {
        proposal = (await API.proposals.edit({
          proposalId: proposal.id, version: proposal.version, persuasionText: text, purchaseConditions: conditions,
        })).proposal;
        state.editing.proposal = proposal;
      }
      // 画面で見ている版を送る
      await API.proposals.send(proposal.id, proposal.version);
      state.editing = null;
      location.hash = 'sent';
    } catch (err) {
      showError('edit-error', API.errorMessage(err));
      // 内容が更新されていたら、最新を取り直して見せる
      if (err.code === 'VERSION_CONFLICT' || err.code === 'INVALID_STATE') {
        API.proposals.get(state.editing.proposal.id).then(({ proposal }) => {
          state.editing.proposal = proposal;
          renderEdit();
          showError('edit-error', API.errorMessage(err));
        }).catch(() => {});
      }
    } finally {
      submitBtn.disabled = false;
    }
  });

  // ---- P8 親ホーム ----
  function formatTime(iso) {
    const date = new Date(iso);
    return (date.getMonth() + 1) + '/' + date.getDate() + ' '
      + String(date.getHours()).padStart(2, '0') + ':' + String(date.getMinutes()).padStart(2, '0');
  }

  function findReceived(id) {
    return state.received.find((item) => item.proposal.id === id) || null;
  }

  async function renderParent(isCurrent) {
    renderParentTaskProposals();
    const empty = $('parent-empty');
    try {
      const { proposals } = await API.proposals.received();
      if (!isCurrent()) return;
      state.received = proposals;
      empty.textContent = 'まだ提案は届いていません。';
      empty.hidden = proposals.length > 0;
      $('parent-proposals').replaceChildren(...proposals.map((item) => {
        const status = statusKey(item.proposal, item.negotiationResult);
        const btn = el('button', 'proposal-item');
        btn.type = 'button';
        const main = el('span', 'proposal-item-main');
        main.append(
          el('span', 'proposal-item-name', item.product.name),
          el('span', 'proposal-item-meta', item.childDisplayName + 'から ・ ' + formatTime(item.sentAt)),
        );
        btn.append(main, el('span', 'status-badge is-' + status, PARENT_STATUS[status]));
        btn.addEventListener('click', () => {
          state.reviewId = item.proposal.id;
          location.hash = 'review';
        });
        const li = el('li');
        li.append(btn);
        return li;
      }));
    } catch (err) {
      if (!isCurrent()) return;
      $('parent-proposals').replaceChildren();
      empty.textContent = API.errorMessage(err);
      empty.hidden = false;
    }
  }

  // 親ホーム：届いたお手伝いの提案
  function renderParentTaskProposals() {
    const items = state.taskProposals.slice().reverse(); // 新しい順
    $('parent-task-empty').hidden = items.length > 0;
    $('parent-task-proposals').replaceChildren(...items.map((p) => {
      const btn = el('button', 'proposal-item');
      btn.type = 'button';
      const main = el('span', 'proposal-item-main');
      main.append(
        el('span', 'proposal-item-name', p.title),
        el('span', 'proposal-item-meta', DATA.user.name + 'から ・ ' + formatTime(p.proposedAt)),
      );
      btn.append(main, el('span', 'status-badge is-' + p.status, TASK_PARENT_STATUS[p.status]));
      btn.addEventListener('click', () => {
        state.taskReviewId = p.id;
        location.hash = 'task-review';
      });
      const li = el('li');
      li.append(btn);
      return li;
    }));
  }

  // ---- P9 お手伝いの提案への回答（親） ----
  function renderTaskReview() {
    const p = findTaskProposal(state.taskReviewId);
    $('task-review-child').textContent = DATA.user.name;
    $('task-review-title').textContent = p.title;
    $('task-review-note-wrap').hidden = !p.note;
    $('task-review-note').textContent = p.note || '';

    const answered = p.status !== 'pending';
    $('task-answer-form').hidden = answered;
    $('task-answer-result').hidden = !answered;
    if (answered) {
      drawTaskAnswerResult(p);
      return;
    }
    $('task-answer-form').reset();
    $('task-edit-title').value = p.title;
    $('task-due').min = todayString();
    updateTaskAnswerFields(null);
    hideError('task-answer-error');
  }

  // 選んだ答えに合わせて、入力欄を出し分ける
  //   このまま承認 … ごほうび・期限
  //   直して承認 … やること（直す）・ごほうび・期限・直した理由（任意）
  //   見送る ...... 理由（必須）
  function updateTaskAnswerFields(decision) {
    $('task-terms').hidden = decision !== 'approved' && decision !== 'modified';
    $('task-edit-wrap').hidden = decision !== 'modified';
    $('task-reason-wrap').hidden = decision !== 'modified' && decision !== 'rejected';
    const rejecting = decision === 'rejected';
    $('task-reason-label').textContent = rejecting
      ? '理由（子どもに伝わります）'
      : '直した理由（なくてもOK・子どもに伝わります）';
    $('task-reason').placeholder = rejecting
      ? '例：おふろそうじはまだすべって危ないので、ほかのお手伝いにしようね'
      : '例：毎日だと大変なので、週末だけにしたよ';
  }

  function drawTaskAnswerResult(p) {
    const box = $('task-answer-result');
    box.className = 'answer-result is-' + p.status;
    if (p.status === 'approved') {
      box.replaceChildren(
        el('h2', null, p.modified ? '直して承認しました' : '承認しました'),
        el('p', null, '「' + p.task.title + '」（ごほうび ' + yen(p.task.reward) + '・期限 ' + formatDue(p.task.due) + '）が'
          + DATA.user.name + 'の課題に入りました。'),
      );
    } else {
      box.replaceChildren(el('h2', null, '見送りました'), el('p', null, '理由は' + DATA.user.name + 'に伝わります。'));
    }
    if (p.reason) box.append(el('blockquote', null, p.reason));
  }

  $('task-answer-form').addEventListener('change', (e) => {
    if (e.target.name !== 'task-decision') return;
    updateTaskAnswerFields(e.target.value);
    hideError('task-answer-error');
  });

  $('task-answer-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const p = findTaskProposal(state.taskReviewId);
    if (!p || p.status !== 'pending') return renderTaskReview();
    const checked = e.currentTarget.querySelector('input[name="task-decision"]:checked');
    if (!checked) return showError('task-answer-error', 'このまま承認・直して承認・見送る のどれかを選んでください。');
    const decision = checked.value;
    const reason = $('task-reason').value.trim();

    const invalid = (id, message) => {
      showError('task-answer-error', message);
      $(id).focus();
    };

    if (decision === 'rejected') {
      if (!reason) return invalid('task-reason', '理由を書いてください。子どもが次の提案を考える手がかりになります。');
      Object.assign(p, { status: 'rejected', reason });
    } else {
      const modified = decision === 'modified';
      const title = modified ? $('task-edit-title').value.trim() : p.title;
      const rewardText = $('task-reward').value.trim();
      const reward = Number(rewardText);
      const due = $('task-due').value;
      if (!title) return invalid('task-edit-title', 'やることを書いてください。');
      if (modified && title === p.title) {
        return invalid('task-edit-title', 'やることを直してください。直さない場合は「このまま承認」を選んでください。');
      }
      if (!rewardText || !Number.isSafeInteger(reward) || reward < 0) {
        return invalid('task-reward', 'ごほうびは0以上の整数（円）で入れてください。');
      }
      if (!due || due < todayString()) return invalid('task-due', '期限は今日以降の日付を選んでください。');

      Object.assign(p, { status: 'approved', modified, reason: modified && reason ? reason : null, task: { title, reward, due } });
      // 承認したお手伝いは、子どもの課題一覧に入る
      state.tasks.push({ id: 'task-' + p.id, title, due: formatDue(due), reward, status: 'todo' });
    }
    renderTaskReview();
    $('task-answer-result').focus();
  });

  // ---- T3 提案への回答（親） ----
  function renderReview(isCurrent) {
    const item = findReceived(state.reviewId);
    drawReview(item);
    // 最新の状態を取り直す（ほかの端末で答えた場合など）
    API.proposals.get(item.proposal.id).then((view) => {
      if (!isCurrent()) return;
      item.proposal = view.proposal;
      item.negotiationResult = view.negotiationResult;
      drawReview(item);
    }).catch(() => {});
  }

  function drawReview(item) {
    const p = item.proposal;
    $('review-child').textContent = item.childDisplayName;
    $('review-product').replaceChildren(productCardEl(item.product));
    $('review-text').textContent = p.persuasionText;
    $('review-conditions').replaceChildren(...p.purchaseConditions.map((c) => el('li', null, c)));

    const answered = p.status !== 'pending';
    $('answer-form').hidden = answered;
    $('answer-result').hidden = !answered;
    if (answered) {
      drawAnswerResult(item);
    } else if (!$('answer-form').contains(document.activeElement)) {
      $('answer-form').reset();
      $('answer-reason-wrap').hidden = true;
      hideError('answer-error');
    }
  }

  function drawAnswerResult(item) {
    const result = item.negotiationResult;
    const decision = statusKey(item.proposal, result);
    const box = $('answer-result');
    box.className = 'answer-result is-' + decision;
    const title = {
      approved: 'OKしました',
      revision_requested: '修正をお願いしました',
      rejected: '見送りました',
    }[decision] || '回答済みです';
    const note = decision === 'approved'
      ? '「' + item.product.name + '」が目標になります。'
      : '理由は' + item.childDisplayName + 'に伝わります。';
    box.replaceChildren(el('h2', null, title), el('p', null, note));
    if (result && result.reason) box.append(el('blockquote', null, result.reason));
  }

  $('answer-form').addEventListener('change', (e) => {
    if (e.target.name !== 'decision') return;
    // 「見送る」「修正をお願い」は理由が必須
    $('answer-reason-wrap').hidden = e.target.value === 'approved';
    hideError('answer-error');
  });

  $('answer-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const submitBtn = e.currentTarget.querySelector('button[type="submit"]');
    if (submitBtn.disabled) return;
    const item = findReceived(state.reviewId);
    const checked = e.currentTarget.querySelector('input[name="decision"]:checked');
    if (!checked) return showError('answer-error', 'OK・修正をお願い・見送る のどれかを選んでください。');
    const decision = checked.value;
    const reason = $('answer-reason').value.trim();
    if (decision !== 'approved' && !reason) {
      showError('answer-error', '理由を書いてください。子どもが次の提案を考える手がかりになります。');
      $('answer-reason').focus();
      return;
    }

    submitBtn.disabled = true;
    try {
      // 画面で見ている版に対して答える
      const view = await API.proposals.respond({
        proposalId: item.proposal.id,
        version: item.proposal.version,
        decision,
        reason: decision === 'approved' ? null : reason,
      });
      item.proposal = view.proposal;
      item.negotiationResult = view.negotiationResult;
      drawReview(item);
      $('answer-result').focus();
    } catch (err) {
      showError('answer-error', API.errorMessage(err));
      if (err.code === 'VERSION_CONFLICT' || err.code === 'INVALID_STATE' || err.stateMayHaveChanged) {
        API.proposals.get(item.proposal.id).then((view) => {
          item.proposal = view.proposal;
          item.negotiationResult = view.negotiationResult;
          drawReview(item);
        }).catch(() => {});
      }
    } finally {
      submitBtn.disabled = false;
    }
  });

  // ---- 親のAIトーク（個別相談） ----
  const parentChat = createChat({
    listId: 'parent-messages',
    formId: 'parent-composer',
    me: DATA.parent,
    getId: () => state.parentConversationId,
    greeting: () => {
      const item = findReceived(state.reviewId);
      return item
        ? item.childDisplayName + 'から「' + item.product.name + '」の提案が届いています。条件や金額について、気になることを聞いてください。'
        : '';
    },
    typingText: () => '考え中…',
  });

  async function renderParentTalk(isCurrent) {
    const item = findReceived(state.reviewId);
    $('ptalk-pinned').replaceChildren(
      el('span', 'pinned-label', '相談中の提案'),
      el('span', 'pinned-name', item.product.name
        + (typeof item.product.priceJpy === 'number' ? '（' + yen(item.product.priceJpy) + '）' : '')),
      el('span', 'pinned-meta', item.childDisplayName + 'から ・ '
        + PARENT_STATUS[statusKey(item.proposal, item.negotiationResult)]),
    );
    try {
      const view = state.parentConversationId
        ? await API.conversations.get(state.parentConversationId)
        : await API.conversations.create({ childId: item.childId });
      if (!isCurrent()) return;
      state.parentConversationId = view.conversationId;
      parentChat.render(view);
    } catch (err) {
      if (!isCurrent()) return;
      $('parent-messages').replaceChildren();
      parentChat.append({ from: 'ai', text: API.errorMessage(err), error: true });
    }
  }

  // ---- 画面の切り替え（URLの # で管理） ----
  const SCREENS = {
    start: { role: null, render: renderStart },
    home: { role: 'child', render: renderHome },
    talk: { role: 'child', render: renderTalk },
    rewards: { role: 'child', render: renderRewards },
    edit: { role: 'child', render: renderEdit },
    sent: { role: 'child', render: () => {} },
    'task-propose': { role: 'child', render: renderTaskPropose },
    parent: { role: 'parent', render: renderParent },
    review: { role: 'parent', render: renderReview },
    'task-review': { role: 'parent', render: renderTaskReview },
    ptalk: { role: 'parent', render: renderParentTalk },
  };

  // 開けない画面を開こうとしたときの行き先
  function resolve(name) {
    const screen = SCREENS[name];
    if (!screen || !state.role) return 'start'; // 役割を選ぶ前（再読み込み直後など）
    if (screen.role && screen.role !== state.role) return state.role === 'parent' ? 'parent' : 'home';
    if (name === 'edit' && !state.editing) return 'talk';
    if ((name === 'review' || name === 'ptalk') && !findReceived(state.reviewId)) return 'parent';
    if (name === 'task-review' && !findTaskProposal(state.taskReviewId)) return 'parent';
    return name;
  }

  // 非同期で読み込んでいる間に別の画面へ移ったら、古い結果を描かない
  let screenSeq = 0;

  function show(requested) {
    const name = resolve(requested);
    if (name !== requested) history.replaceState(null, '', '#' + name);
    const seq = ++screenSeq;
    const isCurrent = () => seq === screenSeq;
    document.querySelectorAll('[data-screen]').forEach((s) => {
      s.hidden = s.dataset.screen !== name;
    });
    SCREENS[name].render(isCurrent);
    window.scrollTo(0, 0);
    const heading = document.querySelector('[data-screen="' + name + '"] h1');
    if (heading) { heading.tabIndex = -1; heading.focus({ preventScroll: true }); }
  }

  document.addEventListener('click', (e) => {
    const go = e.target.closest('[data-go]');
    if (go) location.hash = go.dataset.go;
    const role = e.target.closest('[data-role]');
    if (role) startAs(role.dataset.role);
  });
  window.addEventListener('hashchange', () => show(location.hash.slice(1)));

  show(location.hash.slice(1));
})();
