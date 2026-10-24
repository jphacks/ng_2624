(function () {
  'use strict';

  const DATA = window.DATA;
  const state = {
    points: DATA.points,
    tasks: DATA.tasks.map((t) => ({ ...t })),
    messages: DATA.messages.slice(),
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
    body.append(el('span', 'msg-name', who.name), el('p', 'bubble' + (msg.typing ? ' typing' : ''), msg.text));
    row.append(avatar, body);
    return row;
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

    // 仮の返事。本番ではここでAIのAPIを呼ぶ
    const typing = messageEl({ from: 'ai', text: '…', typing: true });
    $('messages').append(typing);
    scrollToBottom();

    const submitBtn = e.currentTarget.querySelector('button');
    submitBtn.disabled = true;
    setTimeout(() => {
      const reply = DATA.mockReplies[state.replyIndex % DATA.mockReplies.length];
      state.replyIndex += 1;
      state.messages.push({ from: 'ai', text: reply });
      typing.replaceWith(messageEl({ from: 'ai', text: reply }));
      submitBtn.disabled = false;
      scrollToBottom();
    }, 900);
  });

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
