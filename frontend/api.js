// フロントエンドとバックエンドをつなぐ窓口。
//
// 画面（app.js）は、データの取得・保存をすべてここを通して行う。
// 送り先のURL・送る形・返ってくる形は、チームで決めたAPI仕様に合わせている：
//   - URLとメソッド ........ src/connection/http.ts（FE_HTTP_DEFINITIONS）
//   - 送る項目 .............. Sample_db/fe-be.ts（FERequestMap）
//   - 返ってくる形・エラー .. Sample_db/api.ts（FEResponseMap / API_ERRORS）
// 仕様が変わったら、このファイルの ROUTES と、仮バックエンドの返す形を合わせて直す。
//
// モードは2つ：
//   mock（仮モード） … ブラウザの中の仮バックエンドが、仕様と同じ形で返す。今はこちら。
//   http（本番モード） … 本物のバックエンド（同じアドレスの /api/...）に送る。
//                        URLの末尾に ?api=real を付けて開くと本番モードになる。
(function () {
  'use strict';

  // ---------------------------------------------------------------
  // 共通：エラー
  // ---------------------------------------------------------------

  // バックエンドのエラー（Sample_db/api.ts の APIErrorBody）と同じ項目を持つ
  class ApiError extends Error {
    constructor(status, detail) {
      super(detail.message);
      this.name = 'ApiError';
      this.status = status;
      this.code = detail.code;
      this.field = detail.field ?? null;
      this.requestId = detail.requestId ?? null;
      // true のときは、保存されたか分からない。取得し直して確認する（自動で送り直さない）
      this.stateMayHaveChanged = Boolean(detail.stateMayHaveChanged);
      this.retryAfterSeconds = detail.retryAfterSeconds ?? null;
    }
  }

  // 画面に出すときの一言（エラーの種類ごと。docs/frontend-design.md の「6. エラーのときの表示」）
  const ERROR_HINT = {
    INVALID_INPUT: '入力内容を確認してください。',
    UNAUTHENTICATED: 'ログインし直してください。',
    FORBIDDEN: 'この操作はできません。',
    CSRF_INVALID: 'ページを開き直してください。',
    REAUTH_REQUIRED: 'もう一度Googleでログインしてください。',
    NOT_FOUND: '見つかりませんでした。',
    VERSION_CONFLICT: '内容が更新されています。最新の状態を確認してください。',
    INVALID_STATE: '状態が変わっています。最新の状態を確認してください。',
    RATE_LIMITED: '少し時間をおいてから、もう一度おしてください。',
    AI_UNAVAILABLE: 'AIが返事できませんでした。少しあとで試してください。',
    INTERNAL_ERROR: 'うまくいきませんでした。少しあとで試してください。',
    NETWORK_ERROR: '通信できませんでした。つながっているか確認してください。',
    INVALID_RESPONSE: 'サーバーの返事が読み取れませんでした。',
    NOT_AVAILABLE: 'この機能はまだバックエンドにありません。',
  };

  function errorMessage(err) {
    if (err instanceof ApiError) return err.message || ERROR_HINT[err.code] || ERROR_HINT.INTERNAL_ERROR;
    return ERROR_HINT.INTERNAL_ERROR;
  }

  // ---------------------------------------------------------------
  // 送り先の一覧（src/connection/http.ts の FE_HTTP_DEFINITIONS と同じ）
  // ---------------------------------------------------------------
  const ROUTES = {
    'profile.get': ['GET', '/api/profile', 200],
    'profile.update': ['PATCH', '/api/profile', 200],
    'child.create': ['POST', '/api/children', 201],
    'child.rename': ['PATCH', '/api/children/{childId}', 200],
    'child.settings.get': ['GET', '/api/children/{childId}/settings', 200],
    'child.settings.update': ['PATCH', '/api/children/{childId}/settings', 200],
    'children.list': ['GET', '/api/children', 200],
    'conversations.list': ['GET', '/api/conversations', 200],
    'negotiations.list': ['GET', '/api/negotiations', 200],
    'conversation.create': ['POST', '/api/conversations', 201],
    'conversation.get': ['GET', '/api/conversations/{conversationId}', 200],
    'conversation.message': ['POST', '/api/conversations/{conversationId}/messages', 200],
    'conversation.select_product': ['PATCH', '/api/conversations/{conversationId}/selected-product', 200],
    'conversation.generate_proposal': ['POST', '/api/conversations/{conversationId}/proposal-drafts', 200],
    'negotiation.get': ['GET', '/api/negotiations/{negotiationId}', 200],
    'negotiation.message': ['POST', '/api/negotiations/{negotiationId}/messages', 200],
    'negotiation.select_product': ['PATCH', '/api/negotiations/{negotiationId}/selected-product', 200],
    'negotiation.generate_proposal': ['POST', '/api/negotiations/{negotiationId}/proposal-drafts', 200],
    'proposal.get': ['GET', '/api/proposals/{proposalId}', 200],
    'proposal.edit': ['PATCH', '/api/proposals/{proposalId}', 200],
    'proposal.send': ['POST', '/api/proposals/{proposalId}/send', 200],
    'proposal.respond': ['POST', '/api/proposals/{proposalId}/responses', 200],
    'sharing.publish': ['POST', '/api/negotiations/{negotiationId}/shared-conditions', 201],
    'sharing.revoke': ['DELETE', '/api/shared-conditions/{sharedConditionId}', 200],
    'auth.session': ['GET', '/api/auth/session', 200],
    'auth.google.reauthenticate': ['POST', '/api/auth/google/reauthenticate', 200],
    'auth.logout': ['POST', '/api/auth/logout', 200],
    'devices.list': ['GET', '/api/devices', 200],
    'invitation.create': ['POST', '/api/children/{childId}/invitations', 201],
    'pairing.bootstrap': ['POST', '/api/pairing/session', 201],
    'pairing.request': ['POST', '/api/pairing/requests', 201],
    'pairing.requests.list': ['GET', '/api/pairing/requests', 200],
    'pairing.status': ['GET', '/api/pairing/requests/{pairingRequestId}', 200],
    'pairing.respond': ['POST', '/api/pairing/requests/{pairingRequestId}/responses', 200],
    'pairing.complete': ['POST', '/api/pairing/requests/{pairingRequestId}/complete', 200],
    'device.revoke': ['DELETE', '/api/devices/{deviceSessionId}', 200],
  };
  const GOOGLE_LOGIN_PATH = '/api/auth/google/start';

  // 仕様にまだない操作（画面には必要）。本番モードでは NOT_AVAILABLE を返す。
  // バックエンド担当と相談して、仕様に足してもらう候補。
  const NOT_IN_CONTRACT = {
    'proposals.received': '親が、子どもから届いた提案を一覧で見る（商品の名前・価格・URLも必要）',
  };

  // ---------------------------------------------------------------
  // 本番モード：本物のバックエンドへ送る
  // ---------------------------------------------------------------
  function createHttpTransport() {
    // CSRFトークンはメモリだけに持つ（localStorage に保存しない）
    let csrfToken = null;

    // 送信前にCSRFトークンが必要な操作（読み取りと、ログイン前の操作以外）
    const needsCsrf = (operation, method) => method !== 'GET' && operation !== 'pairing.bootstrap';

    function buildRequest(operation, input) {
      const route = ROUTES[operation];
      if (!route) throw new ApiError(400, { code: 'INVALID_INPUT', message: '不明な操作です：' + operation, field: 'operation' });
      const [method, template] = route;
      const body = { ...(input || {}) };

      // URLの中の {id} を埋める。IDに / や . が入るとちがう宛先になるので形を確認する
      const path = template.replace(/\{(\w+)\}/g, (_, key) => {
        const value = body[key];
        if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
          throw new ApiError(400, { code: 'INVALID_INPUT', message: 'IDの形式が正しくありません。', field: key });
        }
        delete body[key];
        return encodeURIComponent(value);
      });

      const headers = { Accept: 'application/json' };
      if (needsCsrf(operation, method)) {
        if (!csrfToken) throw new ApiError(401, { code: 'UNAUTHENTICATED', message: 'ログインしてください。' });
        headers['X-CSRF-Token'] = csrfToken;
      }
      // Cookie は同じアドレスにだけ送る。通信先がリダイレクトしたら失敗にする
      const init = { method, headers, credentials: 'same-origin', cache: 'no-store', redirect: 'error' };
      if (Object.keys(body).length) {
        if (method === 'GET' || method === 'DELETE') {
          throw new ApiError(400, { code: 'INVALID_INPUT', message: 'この操作には本文を付けられません。', field: 'body' });
        }
        headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify(body);
      }
      return { path, init, method };
    }

    // ログイン状態の取得などで返ってきたCSRFトークンを覚えておく
    function rememberCsrf(operation, data) {
      if (operation === 'auth.session') csrfToken = data.csrfToken || null;
      if (operation === 'pairing.bootstrap' || operation === 'pairing.complete') csrfToken = data.csrfToken || csrfToken;
      if (operation === 'auth.logout') csrfToken = null;
    }

    async function request(operation, input, signal) {
      if (NOT_IN_CONTRACT[operation]) {
        throw new ApiError(501, { code: 'NOT_AVAILABLE', message: ERROR_HINT.NOT_AVAILABLE + '（' + NOT_IN_CONTRACT[operation] + '）' });
      }
      const { path, init, method } = buildRequest(operation, input);
      // GET以外は、通信が切れると「保存されたか分からない」状態になる
      const uncertain = method !== 'GET';

      let response;
      try {
        response = await fetch(new URL(path, location.origin), { ...init, signal });
      } catch (err) {
        if (err && err.name === 'AbortError') throw err;
        throw new ApiError(0, { code: 'NETWORK_ERROR', message: ERROR_HINT.NETWORK_ERROR, stateMayHaveChanged: uncertain });
      }

      const type = (response.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
      let payload = null;
      if (type === 'application/json') payload = await response.json().catch(() => null);

      if (!response.ok) {
        const detail = payload && payload.error;
        if (!detail || typeof detail.code !== 'string' || typeof detail.message !== 'string') {
          throw new ApiError(response.status, { code: 'INVALID_RESPONSE', message: ERROR_HINT.INVALID_RESPONSE, stateMayHaveChanged: uncertain });
        }
        throw new ApiError(response.status, detail);
      }
      if (!payload || typeof payload !== 'object' || !('data' in payload)) {
        throw new ApiError(response.status, { code: 'INVALID_RESPONSE', message: ERROR_HINT.INVALID_RESPONSE, stateMayHaveChanged: uncertain });
      }
      rememberCsrf(operation, payload.data);
      return payload.data;
    }

    return {
      mode: 'http',
      request,
      // Googleログインは fetch ではなく、画面ごと移動して始める
      googleLoginUrl: () => new URL(GOOGLE_LOGIN_PATH, location.origin).href,
    };
  }

  // ---------------------------------------------------------------
  // 仮モード：ブラウザの中の仮バックエンド
  // 返す形は本番と同じ。バックエンドができたら使わなくなる。
  // ---------------------------------------------------------------
  function createMockTransport(DATA) {
    const db = {
      session: null, // { role, displayName, childId }
      child: { childId: 'child-1', displayName: DATA.user.name },
      conversations: new Map(),
      proposals: new Map(), // proposalId -> { proposal, negotiationResult, product, conversationId, sentAt }
      seq: 0,
    };

    const newId = (prefix) => prefix + '-' + (++db.seq) + '-' + Date.now().toString(36);
    const now = () => new Date().toISOString();
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const copy = (value) => JSON.parse(JSON.stringify(value)); // 画面側から仮DBを書き換えられないように

    function fail(status, code, message, field) {
      throw new ApiError(status, { code, message: message || ERROR_HINT[code], field: field || null, requestId: newId('req') });
    }

    function requireSession(role) {
      if (!db.session) fail(401, 'UNAUTHENTICATED');
      if (role && db.session.role !== role) fail(403, 'FORBIDDEN');
      return db.session;
    }

    function text(value, field, max) {
      if (typeof value !== 'string' || !value.trim() || value.length > (max || 4000)) fail(400, 'INVALID_INPUT', '入力内容を確認してください。', field);
      return value.trim();
    }

    // ---- 会話 ----
    function conversationView(c) {
      return copy({
        conversationId: c.conversationId,
        childId: c.childId,
        messages: c.messages,
        products: c.products,
        selectedProductId: c.selectedProductId,
        currentProposal: c.currentProposalId ? db.proposals.get(c.currentProposalId).proposal : null,
        latestAIOutput: c.latestAIOutput,
      });
    }

    function ownConversation(conversationId) {
      const session = requireSession();
      const c = db.conversations.get(conversationId);
      if (!c || c.ownerRole !== session.role) fail(404, 'NOT_FOUND');
      return c;
    }

    function pushMessage(c, sender, content) {
      c.messages.push({ id: newId('msg'), sender, content, createdAt: now() });
    }

    // 仮の返事。AIは使わず、data.js の決まった文を順番に返すだけ（形は AIOutput と同じ）
    async function fixedReply(c) {
      if (c.ownerRole === 'parent') {
        await wait(700);
        const reply = DATA.parentMockReplies[c.replyIndex++ % DATA.parentMockReplies.length];
        return { requestId: newId('ai'), action: 'HEARING', reply, search: null };
      }
      await wait(900);
      const step = DATA.mockReplies[c.replyIndex++ % DATA.mockReplies.length];
      if (step.product) return { requestId: newId('ai'), ...copy(DATA.mockProductReply) };
      return { requestId: newId('ai'), action: 'HEARING', reply: step.text, search: null };
    }

    // ---- 提案 ----
    function proposalView(entry) {
      return copy({ proposal: entry.proposal, negotiationResult: entry.negotiationResult });
    }

    function ownProposal(proposalId, version) {
      const session = requireSession();
      const entry = db.proposals.get(proposalId);
      if (!entry) fail(404, 'NOT_FOUND');
      // 親は送られてきた提案だけ見られる。子どもは自分の提案だけ
      const c = db.conversations.get(entry.conversationId);
      const visible = session.role === 'child' ? c.ownerRole === 'child' : entry.proposal.status !== 'draft';
      if (!visible) fail(404, 'NOT_FOUND');
      if (version !== undefined && entry.proposal.version !== version) fail(409, 'VERSION_CONFLICT');
      return entry;
    }

    function draftFromTemplate(product) {
      const due = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
      const deadline = (due.getMonth() + 1) + '月' + due.getDate() + '日';
      const fill = (s) => s.replace('{name}', product.name).replace('{deadline}', deadline);
      return {
        persuasionText: fill(DATA.draftTemplate.persuasionText),
        purchaseConditions: DATA.draftTemplate.purchaseConditions.map(fill),
      };
    }

    // ---- 操作ごとの処理（仕様の操作名と同じ） ----
    const handlers = {
      'auth.session'() {
        const s = db.session;
        if (!s) return { authenticated: false, user: null, csrfToken: null, idleExpiresAt: null, absoluteExpiresAt: null };
        const day = 24 * 60 * 60 * 1000;
        return {
          authenticated: true,
          user: { role: s.role, displayName: s.displayName, childId: s.role === 'child' ? db.child.childId : null },
          csrfToken: 'mock-csrf',
          idleExpiresAt: new Date(Date.now() + day).toISOString(),
          absoluteExpiresAt: new Date(Date.now() + 7 * day).toISOString(),
        };
      },

      'auth.logout'() {
        db.session = null;
        return { loggedOut: true };
      },

      'children.list'() {
        requireSession('parent');
        return { children: [copy(db.child)] };
      },

      'conversations.list'() {
        const session = requireSession();
        const list = [...db.conversations.values()]
          .filter((c) => c.ownerRole === session.role)
          .map((c) => ({ conversationId: c.conversationId, childId: c.childId, createdAt: c.createdAt, updatedAt: c.updatedAt }));
        return { conversations: list };
      },

      async 'conversation.create'(input) {
        const session = requireSession();
        const childId = session.role === 'child' ? db.child.childId : input.childId;
        if (session.role === 'parent' && childId !== db.child.childId) fail(400, 'INVALID_INPUT', '子どもを選んでください。', 'childId');
        const c = {
          conversationId: newId('conv'), ownerRole: session.role, childId,
          messages: [], products: [], selectedProductId: null, currentProposalId: null, latestAIOutput: null,
          replyIndex: 0, createdAt: now(), updatedAt: now(),
        };
        db.conversations.set(c.conversationId, c);
        if (input.message) return handlers['conversation.message']({ conversationId: c.conversationId, message: input.message });
        return conversationView(c);
      },

      'conversation.get'(input) {
        return conversationView(ownConversation(input.conversationId));
      },

      async 'conversation.message'(input) {
        const c = ownConversation(input.conversationId);
        const message = text(input.message, 'message');
        const out = await fixedReply(c);
        // 本人の発言とAIの返事を保存する（AIが失敗したら、どちらも保存しない）
        pushMessage(c, 'user', message);
        pushMessage(c, 'assistant', out.reply);
        if (out.action === 'PRODUCT') {
          c.products = out.products;
          c.selectedProductId = null;
        }
        c.latestAIOutput = out;
        c.updatedAt = now();
        return conversationView(c);
      },

      'conversation.select_product'(input) {
        const c = ownConversation(input.conversationId);
        if (!c.products.some((p) => p.id === input.selectedProductId)) fail(400, 'INVALID_INPUT', 'その商品は選べません。', 'selectedProductId');
        c.selectedProductId = input.selectedProductId;
        c.updatedAt = now();
        return conversationView(c);
      },

      async 'conversation.generate_proposal'(input) {
        const c = ownConversation(input.conversationId);
        const product = c.products.find((p) => p.id === c.selectedProductId);
        if (!product) fail(409, 'INVALID_STATE', '先に商品を1つ選んでください。');
        await wait(700);
        const draft = draftFromTemplate(product);
        const proposal = {
          id: newId('proposal'), negotiationId: null, productId: product.id, version: 1,
          persuasionText: draft.persuasionText, purchaseConditions: draft.purchaseConditions, status: 'draft',
        };
        db.proposals.set(proposal.id, { proposal, negotiationResult: null, product: copy(product), conversationId: c.conversationId, sentAt: null });
        c.currentProposalId = proposal.id;
        const reply = 'おうちの人への提案を下書きしたよ。自分のことばに直してから送ってね。';
        pushMessage(c, 'assistant', reply);
        c.latestAIOutput = {
          requestId: newId('ai'), action: 'PROPOSAL', reply, search: null,
          proposalDraft: { productId: product.id, target: 'parent', persuasionText: draft.persuasionText, purchaseConditions: draft.purchaseConditions, basedOn: null },
        };
        c.updatedAt = now();
        return conversationView(c);
      },

      'proposal.get'(input) {
        return proposalView(ownProposal(input.proposalId));
      },

      'proposal.edit'(input) {
        requireSession('child');
        const entry = ownProposal(input.proposalId, input.version);
        if (entry.proposal.status !== 'draft') fail(409, 'INVALID_STATE', '送ったあとの提案は直せません。');
        if (input.persuasionText === undefined && input.purchaseConditions === undefined) fail(400, 'INVALID_INPUT', '直す内容がありません。');
        // 直すたびに新しい版として保存する
        const next = { ...entry.proposal, version: entry.proposal.version + 1 };
        if (input.persuasionText !== undefined) next.persuasionText = text(input.persuasionText, 'persuasionText');
        if (input.purchaseConditions !== undefined) {
          if (!Array.isArray(input.purchaseConditions) || input.purchaseConditions.length > 12) fail(400, 'INVALID_INPUT', null, 'purchaseConditions');
          next.purchaseConditions = input.purchaseConditions.map((v, i) => text(v, 'purchaseConditions[' + i + ']', 500));
        }
        entry.proposal = next;
        return proposalView(entry);
      },

      'proposal.send'(input) {
        requireSession('child');
        const entry = ownProposal(input.proposalId, input.version);
        if (entry.proposal.status !== 'draft') fail(409, 'INVALID_STATE', 'この提案はもう送ってあります。');
        if (!entry.proposal.purchaseConditions.length) fail(400, 'INVALID_INPUT', 'やくそくを1つ以上書いてね。', 'purchaseConditions');
        entry.proposal = { ...entry.proposal, status: 'pending' };
        entry.sentAt = now();
        return proposalView(entry);
      },

      'proposal.respond'(input) {
        requireSession('parent');
        const entry = ownProposal(input.proposalId, input.version);
        if (entry.proposal.status !== 'pending') fail(409, 'INVALID_STATE', 'この提案にはもう答えてあります。');
        if (!['approved', 'rejected', 'revision_requested'].includes(input.decision)) fail(400, 'INVALID_INPUT', null, 'decision');
        const reason = input.reason == null || input.reason === '' ? null : text(input.reason, 'reason');
        if (input.decision !== 'approved' && !reason) fail(400, 'INVALID_INPUT', '理由を書いてください。', 'reason');
        entry.proposal = { ...entry.proposal, status: input.decision === 'approved' ? 'agreed' : 'rejected' };
        entry.negotiationResult = { proposalId: entry.proposal.id, version: entry.proposal.version, decision: input.decision, reason };
        return proposalView(entry);
      },

      // ↓ 仕様にまだない操作（NOT_IN_CONTRACT）
      'proposals.received'() {
        requireSession('parent');
        const items = [...db.proposals.values()]
          .filter((e) => e.proposal.status !== 'draft')
          .sort((a, b) => b.sentAt.localeCompare(a.sentAt))
          .map((e) => ({
            proposal: e.proposal,
            negotiationResult: e.negotiationResult,
            product: e.product,
            childId: db.child.childId,
            childDisplayName: db.child.displayName,
            sentAt: e.sentAt,
          }));
        return { proposals: copy(items) };
      },
    };

    async function request(operation, input) {
      const handler = handlers[operation];
      if (!handler) fail(501, 'NOT_AVAILABLE', '仮モードではまだ使えない操作です：' + operation);
      await wait(150); // 通信しているように少し待つ
      return copy(await handler(input || {}));
    }

    return {
      mode: 'mock',
      request,
      googleLoginUrl: () => null,
      // 仮モードだけの操作：ログインのかわりに、役割を選んで始める
      signInAs(role) {
        db.session = role === 'parent'
          ? { role: 'parent', displayName: DATA.parent.name }
          : { role: 'child', displayName: DATA.user.name };
      },
    };
  }

  // ---------------------------------------------------------------
  // 画面から使う関数
  // ---------------------------------------------------------------
  const useHttp = location.protocol.startsWith('http') && new URLSearchParams(location.search).get('api') === 'real';
  const transport = useHttp ? createHttpTransport() : createMockTransport(window.DATA);
  const call = (operation, input, signal) => transport.request(operation, input, signal);

  window.API = {
    mode: transport.mode,
    ApiError,
    errorMessage,
    NOT_IN_CONTRACT,
    request: call,
    googleLoginUrl: transport.googleLoginUrl,
    signInAs: transport.signInAs || null,

    auth: {
      session: () => call('auth.session'),
      logout: () => call('auth.logout'),
    },
    children: {
      list: () => call('children.list'),
    },
    conversations: {
      list: () => call('conversations.list'),
      create: (input) => call('conversation.create', input),
      get: (conversationId) => call('conversation.get', { conversationId }),
      message: (conversationId, message) => call('conversation.message', { conversationId, message }),
      selectProduct: (conversationId, selectedProductId) => call('conversation.select_product', { conversationId, selectedProductId }),
      generateProposal: (conversationId) => call('conversation.generate_proposal', { conversationId }),
    },
    proposals: {
      get: (proposalId) => call('proposal.get', { proposalId }),
      edit: (input) => call('proposal.edit', input),
      send: (proposalId, version) => call('proposal.send', { proposalId, version }),
      respond: (input) => call('proposal.respond', input),
      received: () => call('proposals.received'), // 仕様にまだない
    },
  };
})();
