(function () {
  'use strict';

  const DATA = window.DATA;

  // 試作サーバー（dev-server.ts）から開いたときは、子どものトークだけ本物のAIを使う。
  // index.html を直接開いたときは、すべて仮の返事を使う。
  const USE_API = location.protocol === 'http:' || location.protocol === 'https:';

  // 画面の状態。バックエンドができたら、提案などはAPIから取得した値に置き換える。
  const state = {
    points: DATA.points,
    tasks: DATA.tasks.map((t) => ({ ...t })),
    childMessages: USE_API
      ? [{ from: 'ai', text: 'こんにちは！ほしいものや、すきなことを教えてね。' }]
      : DATA.messages.slice(),
    childReplyIndex: 0,
    draft: null, // 子どもが編集中の提案 { product, persuasionText, purchaseConditions }
    proposals: [], // 子どもが送った提案（新しい順）
    reviewId: null, // 親が見ている提案のID
  };

  const $ = (id) => document.getElementById(id);

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

  // ---- 提案の状態の表示 ----
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

  function proposalState(p) {
    return p.response ? p.response.decision : 'pending';
  }

  function findProposal(id) {
    return state.proposals.find((p) => p.id === id) || null;
  }

  // ---- 子どもホーム ----
  function renderHome() {
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
      const restLine = el('span');
      restLine.append(el('b', 'num-big', rest.toLocaleString('ja-JP')), el('span', 'unit', ' pt'));
      const weekLine = el('span');
      weekLine.append(el('b', 'num-mid', String(weeksNeeded(goal))), el('span', 'unit', ' 週間かかります'));
      info.replaceChildren(el('span', 'unit', 'あと'), restLine, el('span', 'unit', '必要です'), weekLine);
    }

    const subs = $('sub-goals');
    subs.replaceChildren();
    DATA.subGoals.forEach((sub) => {
      const btn = el('button', 'goal-sub');
      btn.type = 'button';
      btn.setAttribute('aria-label', sub.name + 'の詳細');
      btn.append(goalVisual(sub));
      btn.addEventListener('click', () => openSheet(sub));
      subs.append(btn);
    });

    renderMyProposals();
    renderTasks();
  }

  // 子どもが送った提案と、親の返事
  function renderMyProposals() {
    $('my-proposals').hidden = state.proposals.length === 0;
    $('my-proposal-list').replaceChildren(...state.proposals.map((p) => {
      const status = proposalState(p);
      const li = el('li', 'my-proposal is-' + status);
      const head = el('div', 'my-proposal-head');
      head.append(el('span', 'my-proposal-name', p.product.name), el('span', 'status-badge is-' + status, CHILD_STATUS[status]));
      li.append(head);
      if (status === 'approved') li.append(el('p', 'my-proposal-note', 'もくひょうになったよ！がんばろう！'));
      if (p.response && p.response.reason) li.append(el('p', 'my-proposal-note', 'おうちの人より：' + p.response.reason));
      return li;
    }));
  }

  function renderTasks() {
    const list = $('task-list');
    list.replaceChildren();
    state.tasks.forEach((task) => {
      const submitted = task.status === 'submitted';
      const btn = el('button', 'task' + (submitted ? ' is-submitted' : ''));
      btn.type = 'button';
      btn.setAttribute('aria-pressed', String(submitted));
      btn.append(
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
    $('sheet-close').focus();
  }

  function closeSheet() {
    $('sheet').hidden = true;
    if (lastFocus) lastFocus.focus();
  }

  $('sheet-close').addEventListener('click', closeSheet);
  $('sheet').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeSheet();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('sheet').hidden) closeSheet();
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
      visual.append(el('span', 'goal-emoji', '🎁'));
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
      choose.addEventListener('click', () => onChoose(product));
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
  // options.me: 自分の表示（名前・アイコン）
  // options.onChoose: 商品カードに「これにする」を付けるとき
  function messageEl(msg, options) {
    const who = msg.from === 'ai' ? DATA.ai : options.me;
    const row = el('div', 'msg ' + (msg.from === 'ai' ? 'msg-ai' : 'msg-me'));
    const avatar = el('span', 'avatar', who.avatar);
    avatar.setAttribute('aria-hidden', 'true');
    const body = el('div', 'msg-body');
    const bubbleClass = 'bubble' + (msg.typing ? ' typing' : '') + (msg.error ? ' is-error' : '');
    body.append(el('span', 'msg-name', who.name), el('p', bubbleClass, msg.text));
    if (msg.products && msg.products.length) {
      body.append(productListEl(msg.products, msg.sources || [], options.onChoose));
    }
    row.append(avatar, body);
    return row;
  }

  // getMessages: 表示するメッセージ配列を返す関数
  // reply: 送った文を受け取り、AIの返事（Promise）を返す関数
  function createChat({ listId, formId, getMessages, reply, options, typingText }) {
    const list = $(listId);
    const form = $(formId);
    const input = form.querySelector('input');
    const submitBtn = form.querySelector('button');

    function scrollToBottom() {
      list.scrollTop = list.scrollHeight;
    }

    function render() {
      list.replaceChildren(...getMessages().map((m) => messageEl(m, options)));
      scrollToBottom();
    }

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const text = input.value.trim();
      if (!text || submitBtn.disabled) return;

      const messages = getMessages();
      messages.push({ from: 'me', text });
      list.append(messageEl({ from: 'me', text }, options));
      input.value = '';

      const typing = messageEl({ from: 'ai', text: typingText(), typing: true }, options);
      list.append(typing);
      scrollToBottom();
      submitBtn.disabled = true;

      // 失敗しても自動で送り直さない（docs/frontend-design.md の方針）
      reply(text)
        .catch((err) => ({ from: 'ai', text: err.message, error: true }))
        .then((msg) => {
          if (!msg.error) messages.push(msg);
          typing.replaceWith(messageEl(msg, options));
          submitBtn.disabled = false;
          scrollToBottom();
        });
    });

    return { render };
  }

  // ---- 子どものトーク ----
  async function childReply(text) {
    if (USE_API) {
      const out = await askAI(text);
      return {
        from: 'ai',
        text: out.reply,
        products: out.action === 'PRODUCT' ? out.products : null,
        sources: out.search ? out.search.sources : [],
      };
    }
    await wait(900);
    const step = DATA.mockReplies[state.childReplyIndex % DATA.mockReplies.length];
    state.childReplyIndex += 1;
    if (step.product) {
      const out = DATA.mockProductReply;
      return { from: 'ai', text: out.reply, products: out.products, sources: out.search.sources };
    }
    return { from: 'ai', text: step.text };
  }

  async function askAI(message) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120000);
    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message }),
        signal: controller.signal,
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data) throw new Error((data && data.error) || 'AIの返事を受け取れませんでした');
      return data;
    } catch (err) {
      if (err.name === 'AbortError') throw new Error('時間がかかりすぎたので止めました。もう一度送ってみてね。');
      if (err instanceof TypeError) throw new Error('サーバーにつながりませんでした。dev-server が動いているか確認してね。');
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  // 画面を開き直したら、サーバー側の会話もリセットして表示とそろえる
  if (USE_API) fetch('/api/reset', { method: 'POST' }).catch(() => {});

  const childChat = createChat({
    listId: 'child-messages',
    formId: 'child-composer',
    getMessages: () => state.childMessages,
    reply: childReply,
    options: { me: DATA.user, onChoose: chooseProduct },
    typingText: () => (USE_API ? '考え中…（少し時間がかかるよ）' : '…'),
  });

  function renderTalk() {
    $('talk-points').textContent = state.points.toLocaleString('ja-JP');
    childChat.render();
  }

  // ---- T2 提案の確認・送信（子ども） ----
  const MAX_CONDITIONS = 12;

  // 「これにする」→ 提案の下書きを作る（本番ではAIが作る）
  function chooseProduct(product) {
    const due = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
    const deadline = (due.getMonth() + 1) + '月' + due.getDate() + '日';
    const fill = (s) => s.replace('{name}', product.name).replace('{deadline}', deadline);
    state.draft = {
      product,
      persuasionText: fill(DATA.draftTemplate.persuasionText),
      purchaseConditions: DATA.draftTemplate.purchaseConditions.map(fill),
    };
    location.hash = 'edit';
  }

  function renderEdit() {
    const draft = state.draft;
    $('edit-product').replaceChildren(productCardEl(draft.product));
    $('edit-text').value = draft.persuasionText;
    $('edit-error').hidden = true;
    renderConditions();
  }

  function renderConditions() {
    const conditions = state.draft.purchaseConditions;
    $('edit-conditions').replaceChildren(...conditions.map((text, i) => {
      const li = el('li', 'condition-item');
      const input = el('textarea');
      input.rows = 2;
      input.value = text;
      input.maxLength = 500;
      input.setAttribute('aria-label', 'やくそく' + (i + 1));
      input.addEventListener('input', () => { conditions[i] = input.value; });
      const remove = el('button', 'condition-remove', '×');
      remove.type = 'button';
      remove.setAttribute('aria-label', 'やくそく' + (i + 1) + 'を消す');
      remove.addEventListener('click', () => {
        conditions.splice(i, 1);
        renderConditions();
      });
      li.append(input, remove);
      return li;
    }));
    $('edit-add-condition').hidden = conditions.length >= MAX_CONDITIONS;
  }

  $('edit-text').addEventListener('input', (e) => {
    if (state.draft) state.draft.persuasionText = e.target.value;
  });

  $('edit-add-condition').addEventListener('click', () => {
    state.draft.purchaseConditions.push('');
    renderConditions();
    const inputs = $('edit-conditions').querySelectorAll('textarea');
    inputs[inputs.length - 1].focus();
  });

  function showError(id, text) {
    const box = $(id);
    box.textContent = text;
    box.hidden = false;
  }

  $('edit-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const draft = state.draft;
    const text = draft.persuasionText.trim();
    const conditions = draft.purchaseConditions.map((c) => c.trim()).filter(Boolean);
    if (!text) return showError('edit-error', 'おねがいを書いてね。');
    if (!conditions.length) return showError('edit-error', 'やくそくを1つ以上書いてね。');

    // 本番では proposal.edit → proposal.send でバックエンドに保存する
    state.proposals.unshift({
      id: 'proposal-' + Date.now(),
      version: 1,
      negotiationId: null,
      productId: draft.product.id,
      product: draft.product,
      persuasionText: text,
      purchaseConditions: conditions,
      status: 'pending',
      from: DATA.user.name,
      sentAt: new Date(),
      response: null,
      parentMessages: [],
      parentReplyIndex: 0,
    });
    state.childMessages.push({ from: 'ai', text: 'おうちの人に「' + draft.product.name + '」の提案を送ったよ。返事を待とうね。' });
    state.draft = null;
    location.hash = 'sent';
  });

  // ---- P8 親ホーム ----
  function formatTime(date) {
    return (date.getMonth() + 1) + '/' + date.getDate() + ' '
      + String(date.getHours()).padStart(2, '0') + ':' + String(date.getMinutes()).padStart(2, '0');
  }

  function renderParent() {
    $('parent-empty').hidden = state.proposals.length > 0;
    $('parent-proposals').replaceChildren(...state.proposals.map((p) => {
      const status = proposalState(p);
      const btn = el('button', 'proposal-item');
      btn.type = 'button';
      const main = el('span', 'proposal-item-main');
      main.append(
        el('span', 'proposal-item-name', p.product.name),
        el('span', 'proposal-item-meta', p.from + 'から ・ ' + formatTime(p.sentAt)),
      );
      btn.append(main, el('span', 'status-badge is-' + status, PARENT_STATUS[status]));
      btn.addEventListener('click', () => {
        state.reviewId = p.id;
        location.hash = 'review';
      });
      const li = el('li');
      li.append(btn);
      return li;
    }));
  }

  // ---- T3 提案への回答（親） ----
  function renderReview() {
    const p = findProposal(state.reviewId);
    $('review-child').textContent = p.from;
    $('review-product').replaceChildren(productCardEl(p.product));
    $('review-text').textContent = p.persuasionText;
    $('review-conditions').replaceChildren(...p.purchaseConditions.map((c) => el('li', null, c)));

    const answered = Boolean(p.response);
    $('answer-form').hidden = answered;
    $('answer-result').hidden = !answered;
    if (answered) {
      renderAnswerResult(p);
    } else {
      $('answer-form').reset();
      $('answer-reason-wrap').hidden = true;
      $('answer-error').hidden = true;
    }
  }

  function renderAnswerResult(p) {
    const { decision, reason } = p.response;
    const box = $('answer-result');
    box.className = 'answer-result is-' + decision;
    const title = {
      approved: 'OKしました',
      revision_requested: '修正をお願いしました',
      rejected: '見送りました',
    }[decision];
    const note = decision === 'approved'
      ? '「' + p.product.name + '」が目標になります。（試作版：目標の登録はバックエンドができてから）'
      : '理由は' + p.from + 'に伝わります。';
    box.replaceChildren(el('h2', null, title), el('p', null, note));
    if (reason) box.append(el('blockquote', null, reason));
  }

  $('answer-form').addEventListener('change', (e) => {
    if (e.target.name !== 'decision') return;
    // 「見送る」「修正をお願い」は理由が必須
    $('answer-reason-wrap').hidden = e.target.value === 'approved';
    $('answer-error').hidden = true;
  });

  $('answer-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const p = findProposal(state.reviewId);
    const checked = e.currentTarget.querySelector('input[name="decision"]:checked');
    if (!checked) return showError('answer-error', 'OK・修正をお願い・見送る のどれかを選んでください。');
    const decision = checked.value;
    const reason = $('answer-reason').value.trim();
    if (decision !== 'approved' && !reason) {
      showError('answer-error', '理由を書いてください。子どもが次の提案を考える手がかりになります。');
      $('answer-reason').focus();
      return;
    }
    // 本番では proposal.respond でバックエンドに保存する
    p.response = { decision, reason: decision === 'approved' ? null : reason, at: new Date() };
    p.status = decision === 'approved' ? 'agreed' : 'rejected';
    renderReview();
    $('answer-result').focus();
  });

  // ---- 親のAIトーク（提案についての個別相談） ----
  // 試作サーバーは子ども用なので、親のトークは常に仮の返事を使う
  async function parentReply() {
    const p = findProposal(state.reviewId);
    await wait(900);
    const text = DATA.parentMockReplies[p.parentReplyIndex % DATA.parentMockReplies.length];
    p.parentReplyIndex += 1;
    return { from: 'ai', text };
  }

  const parentChat = createChat({
    listId: 'parent-messages',
    formId: 'parent-composer',
    getMessages: () => findProposal(state.reviewId).parentMessages,
    reply: parentReply,
    options: { me: DATA.parent },
    typingText: () => '…',
  });

  function renderParentTalk() {
    const p = findProposal(state.reviewId);
    const pinned = $('ptalk-pinned');
    pinned.replaceChildren(
      el('span', 'pinned-label', '相談中の提案'),
      el('span', 'pinned-name', p.product.name
        + (typeof p.product.priceJpy === 'number' ? '（' + yen(p.product.priceJpy) + '）' : '')),
      el('span', 'pinned-meta', p.from + 'から ・ ' + PARENT_STATUS[proposalState(p)]),
    );
    if (!p.parentMessages.length) {
      p.parentMessages.push({
        from: 'ai',
        text: p.from + 'から「' + p.product.name + '」の提案が届いています。条件や金額について、気になることを聞いてください。',
      });
    }
    parentChat.render();
  }

  // ---- 画面の切り替え（URLの # で管理） ----
  const RENDER = {
    start: () => {},
    home: renderHome,
    talk: renderTalk,
    edit: renderEdit,
    sent: () => {},
    parent: renderParent,
    review: renderReview,
    ptalk: renderParentTalk,
  };

  // 必要なデータがない画面を開こうとしたときの戻り先
  function resolve(name) {
    if (!RENDER[name]) return 'start';
    if (name === 'edit' && !state.draft) return 'talk';
    if ((name === 'review' || name === 'ptalk') && !findProposal(state.reviewId)) return 'parent';
    return name;
  }

  function show(requested) {
    const name = resolve(requested);
    if (name !== requested) history.replaceState(null, '', '#' + name);
    document.querySelectorAll('[data-screen]').forEach((s) => {
      s.hidden = s.dataset.screen !== name;
    });
    RENDER[name]();
    window.scrollTo(0, 0);
  }

  document.addEventListener('click', (e) => {
    const go = e.target.closest('[data-go]');
    if (go) location.hash = go.dataset.go;
    const role = e.target.closest('[data-role]');
    if (role) location.hash = role.dataset.role === 'parent' ? 'parent' : 'home';
  });
  window.addEventListener('hashchange', () => show(location.hash.slice(1)));

  show(location.hash.slice(1));
})();
