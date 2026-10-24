(function () {
  'use strict';

  const DATA = window.DATA;

  // 試作サーバー（dev-server.ts）から開いたときは本物のAIを使う。
  // index.html を直接開いたときは仮の返事を使う。
  const USE_API = location.protocol === 'http:' || location.protocol === 'https:';

  const state = {
    points: DATA.points,
    tasks: DATA.tasks.map((t) => ({ ...t })),
    messages: USE_API
      ? [{ from: 'ai', text: 'こんにちは！ほしいものや、すきなことを教えてね。' }]
      : DATA.messages.slice(),
    replyIndex: 0,
  };

  const $ = (id) => document.getElementById(id);

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
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

  // ---- ホーム画面 ----
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

    renderTasks();
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

  // ---- トーク画面 ----
  function messageEl(msg) {
    const who = msg.from === 'ai' ? DATA.ai : DATA.user;
    const row = el('div', 'msg ' + (msg.from === 'ai' ? 'msg-ai' : 'msg-me'));
    const avatar = el('span', 'avatar', who.avatar);
    avatar.setAttribute('aria-hidden', 'true');
    const body = el('div', 'msg-body');
    const bubbleClass = 'bubble' + (msg.typing ? ' typing' : '') + (msg.error ? ' is-error' : '');
    body.append(el('span', 'msg-name', who.name), el('p', bubbleClass, msg.text));
    if (msg.products && msg.products.length) body.append(productListEl(msg.products, msg.sources || []));
    row.append(avatar, body);
    return row;
  }

  // ---- AIが提案した商品カード ----
  const SIZE_LABEL = { small: '小', medium: '中', large: '大' };
  const SIZE_ORDER = ['small', 'medium', 'large'];

  // https のURLだけを使う（javascript: などのおかしなリンクを防ぐ）
  function safeUrl(value) {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' ? url.href : null;
    } catch {
      return null;
    }
  }

  function productCardEl(product) {
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
    info.append(
      el('span', 'product-size', SIZE_LABEL[product.size] || ''),
      el('h4', 'product-name', product.name),
    );
    if (typeof product.priceJpy === 'number') {
      info.append(el('p', 'product-price', '参考価格 ¥' + product.priceJpy.toLocaleString('ja-JP')));
    }
    if (product.recommendationReason) info.append(el('p', 'product-reason', product.recommendationReason));

    const href = safeUrl(product.productUrl);
    if (href) {
      const link = el('a', 'product-link', '詳細（リンク）');
      link.href = href;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      info.append(link);
    }

    card.append(visual, info);
    return card;
  }

  function productListEl(products, sources) {
    const wrap = el('div', 'product-list');
    products
      .slice()
      .sort((a, b) => SIZE_ORDER.indexOf(a.size) - SIZE_ORDER.indexOf(b.size))
      .forEach((p) => wrap.append(productCardEl(p)));

    const links = sources.map((s) => safeUrl(s.url)).filter(Boolean).slice(0, 5);
    if (links.length) {
      const note = el('p', 'product-sources', '参考にしたサイト：');
      links.forEach((href, i) => {
        if (i > 0) note.append(' / ');
        const a = el('a', null, new URL(href).hostname.replace(/^www\./, ''));
        a.href = href;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        note.append(a);
      });
      wrap.append(note);
    }
    return wrap;
  }

  function renderTalk() {
    $('talk-points').textContent = state.points.toLocaleString('ja-JP');
    $('messages').replaceChildren(...state.messages.map(messageEl));
    scrollToBottom();
  }

  function scrollToBottom() {
    const box = $('messages');
    box.scrollTop = box.scrollHeight;
  }

  $('composer').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $('composer-input');
    const text = input.value.trim();
    if (!text) return;

    state.messages.push({ from: 'me', text });
    $('messages').append(messageEl({ from: 'me', text }));
    input.value = '';

    const typing = messageEl({ from: 'ai', text: USE_API ? '考え中…（少し時間がかかるよ）' : '…', typing: true });
    $('messages').append(typing);
    scrollToBottom();

    const submitBtn = e.currentTarget.querySelector('button');
    submitBtn.disabled = true;

    const finish = (msg) => {
      if (!msg.error) state.messages.push(msg);
      typing.replaceWith(messageEl(msg));
      submitBtn.disabled = false;
      scrollToBottom();
    };

    if (!USE_API) {
      setTimeout(() => {
        const reply = DATA.mockReplies[state.replyIndex % DATA.mockReplies.length];
        state.replyIndex += 1;
        finish({ from: 'ai', text: reply });
      }, 900);
      return;
    }

    // 失敗しても自動で送り直さない（docs/frontend-design.md の方針）
    askAI(text)
      .then((out) => finish({
        from: 'ai',
        text: out.reply,
        products: out.action === 'PRODUCT' ? out.products : null,
        sources: out.search ? out.search.sources : [],
      }))
      .catch((err) => finish({ from: 'ai', text: err.message, error: true }));
  });

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

  // ---- 画面の切り替え（URLの #login / #home / #talk で管理） ----
  const SCREENS = ['login', 'home', 'talk'];

  function show(name) {
    if (!SCREENS.includes(name)) name = 'login';
    document.querySelectorAll('[data-screen]').forEach((s) => {
      s.hidden = s.dataset.screen !== name;
    });
    if (name === 'home') renderHome();
    if (name === 'talk') renderTalk();
    window.scrollTo(0, 0);
  }

  document.addEventListener('click', (e) => {
    const target = e.target.closest('[data-go]');
    if (target) location.hash = target.dataset.go;
  });
  window.addEventListener('hashchange', () => show(location.hash.slice(1)));

  show(location.hash.slice(1));
})();
