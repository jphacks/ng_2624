// フロントエンドとバックエンドをつなぐ窓口。
//
// 画面（app.js）は、データの取得・保存をすべてここを通して行う。
// 送り先のURL・送る形・返ってくる形は、チームで決めたAPI仕様に合わせている：
//   - URLとメソッド ........ src/connection/http.ts（FE_HTTP_DEFINITIONS）
//   - 送る項目 .............. Sample_db/fe-be.ts（FERequestMap）
//   - 返ってくる形・エラー .. Sample_db/api.ts（FEResponseMap / API_ERRORS）
// FE-BE接続.pdf の全操作を window.API から呼べる（下の「画面から使う関数」）。
//   - 送る前：REQUEST_RULES で形を確かめる。定義にない項目は送らない。前後の空白は除く
//   - 受け取った後（本番モード）：RESPONSE_MODELS で data の全項目がそろっているか確かめる
// 仕様が変わったら、このファイルの ROUTES・REQUEST_RULES・RESPONSE_MODELS と、仮バックエンドの返す形を合わせて直す。
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
    INVITATION_INVALID: 'このQRコードは使えません。新しいQRコードを出してもらってください。',
    PAIRING_EXPIRED: '時間切れです。接続をはじめからやり直してください。',
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
  //   [メソッド, URL, 成功時のステータス, 返ってくる data の型（下の RESPONSE_MODELS）]
  // ---------------------------------------------------------------
  const ROUTES = {
    'profile.get': ['GET', '/api/profile', 200, 'ProfileView'],
    'profile.update': ['PATCH', '/api/profile', 200, 'ProfileView'],
    'child.create': ['POST', '/api/children', 201, 'ChildView'],
    'child.rename': ['PATCH', '/api/children/{childId}', 200, 'ChildView'],
    'child.settings.get': ['GET', '/api/children/{childId}/settings', 200, 'ChildSettingsView'],
    'child.settings.update': ['PATCH', '/api/children/{childId}/settings', 200, 'ChildSettingsView'],
    'children.list': ['GET', '/api/children', 200, 'ChildList'],
    'conversations.list': ['GET', '/api/conversations', 200, 'ConversationList'],
    'negotiations.list': ['GET', '/api/negotiations', 200, 'NegotiationList'],
    'conversation.create': ['POST', '/api/conversations', 201, 'ConversationView'],
    'conversation.get': ['GET', '/api/conversations/{conversationId}', 200, 'ConversationView'],
    'conversation.message': ['POST', '/api/conversations/{conversationId}/messages', 200, 'ConversationView'],
    'conversation.select_product': ['PATCH', '/api/conversations/{conversationId}/selected-product', 200, 'ConversationView'],
    'conversation.generate_proposal': ['POST', '/api/conversations/{conversationId}/proposal-drafts', 200, 'ConversationView'],
    'negotiation.get': ['GET', '/api/negotiations/{negotiationId}', 200, 'NegotiationView'],
    'negotiation.message': ['POST', '/api/negotiations/{negotiationId}/messages', 200, 'NegotiationView'],
    'negotiation.select_product': ['PATCH', '/api/negotiations/{negotiationId}/selected-product', 200, 'NegotiationView'],
    'negotiation.generate_proposal': ['POST', '/api/negotiations/{negotiationId}/proposal-drafts', 200, 'NegotiationView'],
    'proposal.get': ['GET', '/api/proposals/{proposalId}', 200, 'ProposalView'],
    'proposal.edit': ['PATCH', '/api/proposals/{proposalId}', 200, 'ProposalView'],
    'proposal.send': ['POST', '/api/proposals/{proposalId}/send', 200, 'ProposalView'],
    'proposal.respond': ['POST', '/api/proposals/{proposalId}/responses', 200, 'ProposalView'],
    'sharing.publish': ['POST', '/api/negotiations/{negotiationId}/shared-conditions', 201, 'SharedConditionResult'],
    'sharing.revoke': ['DELETE', '/api/shared-conditions/{sharedConditionId}', 200, 'SharedConditionRevocation'],
    'auth.session': ['GET', '/api/auth/session', 200, 'SessionView'],
    'auth.google.reauthenticate': ['POST', '/api/auth/google/reauthenticate', 200, 'AuthorizationRedirect'],
    'auth.logout': ['POST', '/api/auth/logout', 200, 'LogoutResult'],
    'devices.list': ['GET', '/api/devices', 200, 'DeviceList'],
    'invitation.create': ['POST', '/api/children/{childId}/invitations', 201, 'InvitationResult'],
    'pairing.bootstrap': ['POST', '/api/pairing/session', 201, 'PairingSession'],
    'pairing.request': ['POST', '/api/pairing/requests', 201, 'PairingView'],
    'pairing.requests.list': ['GET', '/api/pairing/requests', 200, 'PairingList'],
    'pairing.status': ['GET', '/api/pairing/requests/{pairingRequestId}', 200, 'PairingView'],
    'pairing.respond': ['POST', '/api/pairing/requests/{pairingRequestId}/responses', 200, 'PairingView'],
    'pairing.complete': ['POST', '/api/pairing/requests/{pairingRequestId}/complete', 200, 'SignedInSession'],
    'device.revoke': ['DELETE', '/api/devices/{deviceSessionId}', 200, 'DeviceRevocation'],
  };
  // Googleログインは fetch ではなく、画面ごとこのURLへ移動して始める（成功で / 、失敗で /?authError=login_failed に戻る）
  const GOOGLE_LOGIN_PATH = '/api/auth/google/start';
  // 親が子どもの端末に見せるQRのURL。後ろに招待トークンを付ける
  const PAIRING_URL_PREFIX = '/pairing#invitationToken=';

  // 仕様のエラーコードと、そのときのHTTPステータス（Sample_db/api.ts の API_ERRORS と同じ）
  const ERROR_STATUS = {
    INVALID_INPUT: 400, UNAUTHENTICATED: 401, FORBIDDEN: 403, CSRF_INVALID: 403, REAUTH_REQUIRED: 403,
    NOT_FOUND: 404, VERSION_CONFLICT: 409, INVALID_STATE: 409, INVITATION_INVALID: 410, PAIRING_EXPIRED: 410,
    RATE_LIMITED: 429, AI_UNAVAILABLE: 502, INTERNAL_ERROR: 500,
  };

  // ---------------------------------------------------------------
  // 送る項目のきまり（src/connection/requests.ts の FE_REQUEST_DEFINITIONS と同じ）
  // 送る前に形を確かめ、文字列の前後の空白を除く。定義にない項目・空の更新は送らない。
  // URL に入るID（childId など）もここに含める。どこに置くかは ROUTES で決まる。
  // ---------------------------------------------------------------
  const rule = {
    str: (max = 4000) => ({ kind: 'string', max }),
    int: (min, max = Number.MAX_SAFE_INTEGER) => ({ kind: 'integer', min, max }),
    nullable: (value) => ({ kind: 'nullable', value }),
    oneOf: (...values) => ({ kind: 'enum', values }),
    list: (item, max = 12) => ({ kind: 'array', item, max }),
    // required: 必須の項目、min: 最低いくつ項目を送るか（「1項目以上更新」など）
    obj: (fields, required = Object.keys(fields), min = required.length) => ({ kind: 'object', fields, required, min }),
  };
  const idRule = rule.str(128);
  const stringsRule = (max = 300) => rule.list(rule.str(max));
  const noBody = rule.obj({});
  const proposalRef = { proposalId: idRule, version: rule.int(1) };

  const REQUEST_RULES = {
    'profile.get': noBody,
    'profile.update': rule.obj({
      displayName: rule.str(100),
      profile: rule.obj({
        age: rule.nullable(rule.int(0, 120)),
        gender: rule.nullable(rule.oneOf('male', 'female', 'other')),
        preferences: rule.obj({ interests: stringsRule(), wishes: stringsRule(), expectations: stringsRule() }, [], 1),
      }, [], 1),
    }, [], 1),
    'child.create': rule.obj({ displayName: rule.str(100) }),
    'child.rename': rule.obj({ childId: idRule, displayName: rule.str(100) }),
    'child.settings.get': rule.obj({ childId: idRule }),
    'child.settings.update': rule.obj({
      childId: idRule,
      rewardGuidelines: rule.obj({
        smallJpy: rule.nullable(rule.int(0)), mediumJpy: rule.nullable(rule.int(0)), largeJpy: rule.nullable(rule.int(0)),
      }, [], 1),
      constraints: rule.obj({ mustHave: stringsRule(), mustAvoid: stringsRule() }, [], 1),
    }, ['childId'], 2),
    'children.list': noBody,
    'conversations.list': noBody,
    'negotiations.list': noBody,
    'conversation.create': rule.obj({ childId: idRule, message: rule.nullable(rule.str()) }, []),
    'conversation.get': rule.obj({ conversationId: idRule }),
    'conversation.message': rule.obj({ conversationId: idRule, message: rule.str() }),
    'conversation.select_product': rule.obj({ conversationId: idRule, selectedProductId: idRule }),
    'conversation.generate_proposal': rule.obj({ conversationId: idRule }),
    'negotiation.get': rule.obj({ negotiationId: idRule }),
    'negotiation.message': rule.obj({ negotiationId: idRule, message: rule.str() }),
    'negotiation.select_product': rule.obj({ negotiationId: idRule, selectedProductId: idRule }),
    'negotiation.generate_proposal': rule.obj({ negotiationId: idRule }),
    'proposal.get': rule.obj({ proposalId: idRule }),
    'proposal.edit': rule.obj({ ...proposalRef, persuasionText: rule.str(), purchaseConditions: stringsRule(500) },
      ['proposalId', 'version'], 3),
    'proposal.send': rule.obj(proposalRef),
    'proposal.respond': rule.obj({
      ...proposalRef,
      decision: rule.oneOf('approved', 'rejected', 'revision_requested'),
      reason: rule.nullable(rule.str()),
    }),
    'sharing.publish': rule.obj({ conversationId: idRule, negotiationId: idRule, content: rule.str() }),
    'sharing.revoke': rule.obj({ sharedConditionId: idRule }),
    'auth.session': noBody,
    'auth.google.reauthenticate': noBody,
    'auth.logout': noBody,
    'devices.list': noBody,
    'invitation.create': rule.obj({ childId: idRule }),
    'pairing.bootstrap': noBody,
    'pairing.request': rule.obj({ invitationToken: rule.str(1024) }),
    'pairing.requests.list': noBody,
    'pairing.status': rule.obj({ pairingRequestId: idRule }),
    'pairing.respond': rule.obj({ pairingRequestId: idRule, decision: rule.oneOf('approved', 'rejected') }),
    'pairing.complete': rule.obj({ pairingRequestId: idRule }),
    'device.revoke': rule.obj({ deviceSessionId: idRule }),
  };

  function invalidInput(field) {
    throw new ApiError(400, { code: 'INVALID_INPUT', message: ERROR_HINT.INVALID_INPUT, field });
  }

  function checkRule(r, value, field) {
    if (r.kind === 'nullable') return value === null ? null : checkRule(r.value, value, field);
    if (r.kind === 'string') {
      if (typeof value !== 'string' || !value.trim() || value.length > r.max) invalidInput(field);
      return value.trim();
    }
    if (r.kind === 'integer') {
      if (!Number.isSafeInteger(value) || value < r.min || value > r.max) invalidInput(field);
      return value;
    }
    if (r.kind === 'enum') {
      if (!r.values.includes(value)) invalidInput(field);
      return value;
    }
    if (r.kind === 'array') {
      if (!Array.isArray(value) || value.length > r.max) invalidInput(field);
      return value.map((item, i) => checkRule(r.item, item, field + '[' + i + ']'));
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) invalidInput(field);
    // undefined の項目は「送らない」扱いにする
    const keys = Object.keys(value).filter((key) => value[key] !== undefined);
    const path = (key) => (field ? field + '.' + key : key);
    if (keys.length < r.min) invalidInput(field || 'body');
    keys.forEach((key) => { if (!Object.hasOwn(r.fields, key)) invalidInput(path(key)); });
    r.required.forEach((key) => { if (!keys.includes(key)) invalidInput(path(key)); });
    return Object.fromEntries(keys.map((key) => [key, checkRule(r.fields[key], value[key], path(key))]));
  }

  // 送る直前に、仕様どおりの形にそろえる（形がちがえば INVALID_INPUT。BEには送らない）
  function prepareInput(operation, input) {
    const r = REQUEST_RULES[operation];
    if (!r) invalidInput('operation');
    const parsed = checkRule(r, input === undefined ? {} : input, '');
    // 見送り・修正希望には理由が必要
    if (operation === 'proposal.respond' && parsed.decision !== 'approved' && parsed.reason === null) invalidInput('reason');
    return parsed;
  }

  // ---------------------------------------------------------------
  // 返ってくる data の型（src/connection/responses.ts の RESPONSE_MODELS と同じ）
  // 本番モードでは、全ての項目がそろっているかを確かめてから画面に渡す。
  // ---------------------------------------------------------------
  const s = {
    ref: (name) => ({ $ref: name }),
    str: (maxLength = 4000, minLength = 1) => ({ type: 'string', minLength, maxLength }),
    int: (minimum = 0, maximum = Number.MAX_SAFE_INTEGER) => ({ type: 'integer', minimum, maximum }),
    nil: { type: 'null' },
    bool: { type: 'boolean' },
    nullable: (schema) => ({ anyOf: [schema, { type: 'null' }] }),
    array: (items) => ({ type: 'array', items }),
    oneOf: (...values) => ({ enum: values }),
    // optional に書いた項目は省略してよい。それ以外は必須。定義にない項目があれば不正
    obj: (properties, optional = []) => ({
      type: 'object', properties, required: Object.keys(properties).filter((key) => !optional.includes(key)),
    }),
  };
  const sId = s.str(128);
  const sName = s.str(100);
  const sStrings = s.array(s.str(300));
  const sTime = { ...s.str(40), format: 'date-time' };
  const sUrl = { ...s.str(4096), format: 'https-url' };
  const sRole = s.oneOf('parent', 'child');
  const aiBase = { requestId: sId, reply: s.str(), search: s.nullable(s.ref('SearchMetadata')) };
  const chatBase = {
    products: s.array(s.ref('ProductCandidate')),
    selectedProductId: s.nullable(sId),
    currentProposal: s.nullable(s.ref('Proposal')),
    latestAIOutput: s.nullable(s.ref('AIOutput')),
  };

  const RESPONSE_MODELS = {
    // 設定とログイン状態
    ProfileView: s.obj({ displayName: sName, profile: s.ref('AIUserProfile') }),
    AIUserProfile: s.obj({
      age: s.nullable(s.int(0, 120)),
      gender: s.nullable(s.oneOf('male', 'female', 'other')),
      preferences: s.obj({ interests: sStrings, wishes: sStrings, expectations: sStrings }),
    }),
    ChildView: s.obj({ childId: sId, displayName: sName }),
    ChildList: s.obj({ children: s.array(s.ref('ChildView')) }),
    ChildSettingsView: s.obj({ childId: sId, rewardGuidelines: s.ref('RewardGuidelines'), constraints: s.ref('PurchaseConstraints') }),
    RewardGuidelines: s.obj({ smallJpy: s.nullable(s.int()), mediumJpy: s.nullable(s.int()), largeJpy: s.nullable(s.int()) }),
    PurchaseConstraints: s.obj({ mustHave: sStrings, mustAvoid: sStrings }),
    SessionView: { anyOf: [s.ref('SignedInSession'), s.ref('SignedOutSession')] },
    SignedInSession: s.obj({
      authenticated: s.oneOf(true),
      user: { anyOf: [
        s.obj({ role: s.oneOf('parent'), displayName: sName, childId: s.nil }),
        s.obj({ role: s.oneOf('child'), displayName: sName, childId: sId }),
      ] },
      csrfToken: s.str(4096), idleExpiresAt: sTime, absoluteExpiresAt: sTime,
    }),
    SignedOutSession: s.obj({
      authenticated: s.oneOf(false), user: s.nil, csrfToken: s.nil, idleExpiresAt: s.nil, absoluteExpiresAt: s.nil,
    }),

    // 会話と提案
    ConversationSummary: s.obj({ conversationId: sId, childId: s.nullable(sId), createdAt: sTime, updatedAt: sTime }),
    ConversationList: s.obj({ conversations: s.array(s.ref('ConversationSummary')) }),
    NegotiationSummary: s.obj({
      negotiationId: sId, childId: sId, status: s.oneOf('open', 'agreed', 'closed'), createdAt: sTime, updatedAt: sTime,
    }),
    NegotiationList: s.obj({ negotiations: s.array(s.ref('NegotiationSummary')) }),
    ConversationView: s.obj({ conversationId: sId, childId: s.nullable(sId), messages: s.array(s.ref('ChatMessage')), ...chatBase }),
    NegotiationView: s.obj({
      negotiationId: sId, childId: sId, status: s.oneOf('open', 'agreed', 'closed'),
      messages: s.array(s.ref('NegotiationMessage')), ...chatBase,
      sharedConditions: s.array(s.ref('SharedCondition')),
      negotiationResult: s.nullable(s.ref('NegotiationResult')),
    }),
    ChatMessage: s.obj({ id: sId, sender: s.oneOf('user', 'assistant'), content: s.str(), createdAt: sTime }),
    NegotiationMessage: s.obj({ id: sId, sender: s.oneOf('parent', 'child', 'assistant'), content: s.str(), createdAt: sTime }),
    ProposalView: s.obj({ proposal: s.ref('Proposal'), negotiationResult: s.nullable(s.ref('NegotiationResult')) }),
    Proposal: s.obj({
      id: sId, negotiationId: s.nullable(sId), productId: sId, version: s.int(1), persuasionText: s.str(),
      purchaseConditions: s.array(s.str(500)),
      status: s.oneOf('draft', 'pending', 'rejected', 'agreed', 'superseded'),
    }),
    NegotiationResult: { anyOf: [
      s.obj({ proposalId: sId, version: s.int(1), decision: s.oneOf('approved'), reason: s.nullable(s.str()) }),
      s.obj({ proposalId: sId, version: s.int(1), decision: s.oneOf('rejected', 'revision_requested'), reason: s.str() }),
    ] },
    SharedCondition: s.obj({ id: sId, sourceUserId: sId, targetUserId: sId, content: s.str(), approvedAt: sTime }),
    SharedConditionResult: s.obj({ sharedCondition: s.ref('SharedCondition') }),
    SharedConditionRevocation: s.obj({ sharedConditionId: sId, revoked: s.oneOf(true) }),

    // 商品とAIの表示情報
    ProductCandidate: s.obj({
      id: sId, name: s.str(300), priceJpy: s.nullable(s.int()), productUrl: sUrl,
      imageUrl: s.nullable(sUrl), priceCheckedAt: s.nullable(sTime),
      size: s.oneOf('small', 'medium', 'large'), description: s.str(1000),
      recommendationReason: s.str(1000), sourceUrls: s.array(sUrl),
    }, ['imageUrl', 'priceCheckedAt']),
    AIOutput: { anyOf: [
      s.obj({ ...aiBase, action: s.oneOf('HEARING') }),
      s.obj({ ...aiBase, action: s.oneOf('PRODUCT'), products: s.array(s.ref('ProductCandidate')) }),
      s.obj({ ...aiBase, action: s.oneOf('PROPOSAL'), proposalDraft: s.ref('ProposalDraft') }),
      s.obj({ ...aiBase, action: s.oneOf('NEGOTIATION'), proposalDraft: s.nullable(s.ref('ProposalDraft')) }),
    ] },
    ProposalDraft: s.obj({
      productId: sId, target: sRole, persuasionText: s.str(), purchaseConditions: s.array(s.str(500)),
      basedOn: s.nullable(s.obj({ proposalId: sId, version: s.int(1) })),
    }),
    SearchMetadata: s.obj({
      queries: s.array(s.str()), sources: s.array(s.ref('SearchSource')), searchSuggestionsHtml: s.nullable(s.str(100000, 0)),
    }),
    SearchSource: s.obj({ id: sId, title: s.str(), url: sUrl }),

    // QR接続と端末
    AuthorizationRedirect: s.obj({ authorizationUrl: sUrl }),
    LogoutResult: s.obj({ loggedOut: s.oneOf(true) }),
    DeviceView: s.obj({
      deviceSessionId: sId, role: sRole, childId: s.nullable(sId), deviceLabel: s.str(300),
      createdAt: sTime, lastActiveAt: sTime, isCurrent: s.bool,
    }),
    DeviceList: s.obj({ devices: s.array(s.ref('DeviceView')) }),
    DeviceRevocation: s.obj({ deviceSessionId: sId, currentDeviceRevoked: s.bool }),
    InvitationResult: s.obj({ invitationToken: s.str(1024), childId: sId, expiresAt: sTime }),
    PairingSession: s.obj({ csrfToken: s.str(4096), expiresAt: sTime }),
    PairingView: s.obj({
      pairingRequestId: sId, childId: sId, childDisplayName: sName, confirmationCode: s.str(32), deviceLabel: s.str(300),
      status: s.oneOf('pending', 'approved', 'rejected', 'expired', 'cancelled'), requestedAt: sTime, expiresAt: sTime,
    }),
    PairingList: s.obj({ requests: s.array(s.ref('PairingView')) }),
  };

  // 日時はタイムゾーン付きの ISO 8601。URLは https だけ（ユーザー名・パスワード付きは不可）
  function validFormat(format, value) {
    if (format === 'date-time') {
      return /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value)
        && Number.isFinite(Date.parse(value))
        && new Date(value.slice(0, 10) + 'T00:00:00Z').toISOString().slice(0, 10) === value.slice(0, 10);
    }
    if (format === 'https-url') {
      try {
        const url = new URL(value);
        return url.protocol === 'https:' && !url.username && !url.password;
      } catch {
        return false;
      }
    }
    return true;
  }

  function matches(schema, value) {
    if (schema.$ref) return Object.hasOwn(RESPONSE_MODELS, schema.$ref) && matches(RESPONSE_MODELS[schema.$ref], value);
    if (schema.anyOf) return schema.anyOf.some((candidate) => matches(candidate, value));
    if (schema.enum) return schema.enum.includes(value);
    switch (schema.type) {
      case 'null': return value === null;
      case 'boolean': return typeof value === 'boolean';
      case 'integer': return Number.isSafeInteger(value) && value >= schema.minimum && value <= schema.maximum;
      case 'string':
        return typeof value === 'string' && value.length >= schema.minLength && value.length <= schema.maxLength
          && validFormat(schema.format, value);
      case 'array': return Array.isArray(value) && value.every((item) => matches(schema.items, item));
      case 'object': {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
        return schema.required.every((key) => Object.hasOwn(value, key))
          && Object.keys(value).every((key) => Object.hasOwn(schema.properties, key) && matches(schema.properties[key], value[key]));
      }
      default: return false;
    }
  }

  // 成功時の本体 { data, requestId } が仕様どおりか
  function validSuccess(model, payload) {
    return matches(s.obj({ data: s.ref(model), requestId: sId }), payload);
  }

  // 失敗時の本体 { error: {...} } が仕様どおりか（コードとHTTPステータスの組み合わせも確かめる）
  function validErrorBody(payload, status) {
    const e = payload && typeof payload === 'object' ? payload.error : null;
    return Boolean(e && typeof e === 'object')
      && ERROR_STATUS[e.code] === status
      && typeof e.message === 'string' && e.message.length > 0
      && typeof e.requestId === 'string' && e.requestId.length > 0
      && (e.field === null || typeof e.field === 'string')
      && typeof e.stateMayHaveChanged === 'boolean'
      && (e.retryAfterSeconds === null || (Number.isSafeInteger(e.retryAfterSeconds) && e.retryAfterSeconds >= 0))
      && (e.code === 'RATE_LIMITED') === (e.retryAfterSeconds !== null);
  }

  // 仕様にまだない操作（画面には必要）。本番モードでは NOT_AVAILABLE を返す。
  // バックエンド担当と相談して、仕様に足してもらう候補。
  const NOT_IN_CONTRACT = {
    'proposals.received': '親が、子どもから届いた提案を一覧で見る（商品の名前・価格・URLも必要）',
  };

  // ---------------------------------------------------------------
  // 本番モード：本物のバックエンドへ送る
  // ---------------------------------------------------------------
  function createHttpTransport() {
    // CSRFトークンはメモリだけに持つ（localStorage に保存しない）。
    // 通常のログイン用と、子ども端末の接続準備用（仮セッション）を取り違えないように分けて持つ。
    let sessionCsrf = null;
    let pairingCsrf = null;
    const PAIRING_OPERATIONS = ['pairing.request', 'pairing.complete'];

    // 送信前にCSRFトークンが必要な操作（読み取りと、接続準備の開始以外）
    const needsCsrf = (operation, method) => method !== 'GET' && operation !== 'pairing.bootstrap';

    function csrfFor(operation) {
      const pairing = PAIRING_OPERATIONS.includes(operation);
      const token = pairing ? pairingCsrf : sessionCsrf;
      if (!token || token.length > 4096 || /[\x00-\x20\x7f]/.test(token)) {
        if (pairing) throw new ApiError(410, { code: 'PAIRING_EXPIRED', message: ERROR_HINT.PAIRING_EXPIRED });
        throw new ApiError(401, { code: 'UNAUTHENTICATED', message: ERROR_HINT.UNAUTHENTICATED });
      }
      return token;
    }

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
      if (needsCsrf(operation, method)) headers['X-CSRF-Token'] = csrfFor(operation);
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
      if (operation === 'auth.session') sessionCsrf = data.csrfToken; // 未ログインなら null
      if (operation === 'pairing.bootstrap') pairingCsrf = data.csrfToken;
      if (operation === 'pairing.complete') {
        // 接続が確定したら、通常のログインに切り替わる
        sessionCsrf = data.csrfToken;
        pairingCsrf = null;
      }
      if (operation === 'auth.logout') sessionCsrf = null;
      if (operation === 'device.revoke' && data.currentDeviceRevoked) sessionCsrf = null;
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

      const badResponse = () => new ApiError(response.status, {
        code: 'INVALID_RESPONSE', message: ERROR_HINT.INVALID_RESPONSE, stateMayHaveChanged: uncertain,
      });
      const type = (response.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
      let payload = null;
      if (type === 'application/json') payload = await response.json().catch(() => null);

      if (!response.ok) {
        if (!validErrorBody(payload, response.status)) throw badResponse();
        throw new ApiError(response.status, payload.error);
      }
      // 成功のステータスと、data の全項目が仕様どおりかを確かめる
      const [, , successStatus, model] = ROUTES[operation];
      if (response.status !== successStatus || !validSuccess(model, payload)) throw badResponse();
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

  // どちらのモードでも、送る前に仕様どおりの形か確かめる（仕様にない操作は確認しない）
  async function call(operation, input, signal) {
    const body = NOT_IN_CONTRACT[operation] ? input : prepareInput(operation, input);
    return transport.request(operation, body, signal);
  }

  // 画面URLのクエリ・フラグメントを1つ消す（ログイン失敗の印や招待トークンを残さない）
  function cleanUrl({ query, fragment }) {
    const url = new URL(location.href);
    if (query) url.searchParams.delete(query);
    if (fragment) url.hash = '';
    history.replaceState(history.state, '', url.pathname + url.search + url.hash);
  }

  // ---- 画面から使う関数（FE-BE接続.pdf の全操作） ----
  // それぞれ BE が返した data をそのまま返す。失敗したら ApiError を投げる。
  window.API = {
    mode: transport.mode,
    ApiError,
    errorMessage,
    NOT_IN_CONTRACT,
    request: call,
    googleLoginUrl: transport.googleLoginUrl,
    signInAs: transport.signInAs || null,

    // ログインと共通の送信情報
    auth: {
      /** → SessionView。画面の初期化時に呼ぶ。CSRFトークンもここで受け取る */
      session: () => call('auth.session'),
      /** Googleログインを始める（画面ごと移動。fetch では開かない） */
      startGoogleLogin() {
        const url = transport.googleLoginUrl();
        if (url) location.assign(url);
      },
      /** → AuthorizationRedirect { authorizationUrl }。保護者のみ */
      reauthenticate: () => call('auth.google.reauthenticate'),
      /** 再認証の画面へ移動する。戻ってきたら auth.session で取り直す */
      async startReauthentication() {
        const { authorizationUrl } = await call('auth.google.reauthenticate');
        location.assign(authorizationUrl);
      },
      /** → LogoutResult { loggedOut: true } */
      logout: () => call('auth.logout'),
      /**
       * Googleログインに失敗して戻ってきたか（/?authError=login_failed）。
       * 見たら URL から消す。これだけでログイン成功や役割を判断しない。
       */
      takeLoginError() {
        const failed = new URLSearchParams(location.search).get('authError') === 'login_failed';
        if (failed) cleanUrl({ query: 'authError' });
        return failed;
      },
    },

    // 本人のプロフィール
    profile: {
      /** → ProfileView */
      get: () => call('profile.get'),
      /** input: { displayName?, profile?: { age?, gender?, preferences?: { interests?, wishes?, expectations? } } } → ProfileView */
      update: (input) => call('profile.update', input),
    },

    // 子どもごとの設定（保護者のみ）
    children: {
      /** → ChildList { children } */
      list: () => call('children.list'),
      /** → ChildView。受け取った childId を以降の操作で使う */
      create: (displayName) => call('child.create', { displayName }),
      /** → ChildView */
      rename: (childId, displayName) => call('child.rename', { childId, displayName }),
      /** → ChildSettingsView */
      getSettings: (childId) => call('child.settings.get', { childId }),
      /** input: { childId, rewardGuidelines?: { smallJpy?, mediumJpy?, largeJpy? }, constraints?: { mustHave?, mustAvoid? } } → ChildSettingsView */
      updateSettings: (input) => call('child.settings.update', input),
    },

    // 個別相談（本人だけの会話）
    conversations: {
      /** → ConversationList { conversations } */
      list: () => call('conversations.list'),
      /** input: { childId?（親が子どもを指定するときだけ）, message? } → ConversationView */
      create: (input) => call('conversation.create', input),
      /** → ConversationView */
      get: (conversationId) => call('conversation.get', { conversationId }),
      /** → ConversationView */
      message: (conversationId, message) => call('conversation.message', { conversationId, message }),
      /** → ConversationView */
      selectProduct: (conversationId, selectedProductId) => call('conversation.select_product', { conversationId, selectedProductId }),
      /** → ConversationView（currentProposal に下書きが入る） */
      generateProposal: (conversationId) => call('conversation.generate_proposal', { conversationId }),
    },

    // 共有交渉（親子に見える会話）
    negotiations: {
      /** → NegotiationList { negotiations } */
      list: () => call('negotiations.list'),
      /** → NegotiationView */
      get: (negotiationId) => call('negotiation.get', { negotiationId }),
      /** → NegotiationView */
      message: (negotiationId, message) => call('negotiation.message', { negotiationId, message }),
      /** → NegotiationView */
      selectProduct: (negotiationId, selectedProductId) => call('negotiation.select_product', { negotiationId, selectedProductId }),
      /** → NegotiationView（currentProposal に修正版の下書きが入る） */
      generateProposal: (negotiationId) => call('negotiation.generate_proposal', { negotiationId }),
    },

    // 提案
    proposals: {
      /** → ProposalView { proposal, negotiationResult } */
      get: (proposalId) => call('proposal.get', { proposalId }),
      /** input: { proposalId, version, persuasionText?, purchaseConditions? } → ProposalView */
      edit: (input) => call('proposal.edit', input),
      /** → ProposalView */
      send: (proposalId, version) => call('proposal.send', { proposalId, version }),
      /** input: { proposalId, version, decision, reason }（approved 以外は reason 必須） → ProposalView */
      respond: (input) => call('proposal.respond', input),
      received: () => call('proposals.received'), // 仕様にまだない
    },

    // 個別相談の要約を交渉へ公開する
    sharing: {
      /** input: { conversationId, negotiationId, content } → SharedConditionResult { sharedCondition } */
      publish: (input) => call('sharing.publish', input),
      /** → SharedConditionRevocation { sharedConditionId, revoked: true } */
      revoke: (sharedConditionId) => call('sharing.revoke', { sharedConditionId }),
    },

    // 端末の管理（保護者のみ）
    devices: {
      /** → DeviceList { devices } */
      list: () => call('devices.list'),
      /** → DeviceRevocation。currentDeviceRevoked が true なら未ログインの画面へ切り替える。Google再認証が必要 */
      revoke: (deviceSessionId) => call('device.revoke', { deviceSessionId }),
    },

    // 招待QR（保護者のみ。Google再認証が必要）
    invitations: {
      /** → InvitationResult { invitationToken, childId, expiresAt }。QRは5分で期限切れ */
      create: (childId) => call('invitation.create', { childId }),
      /** QRにする接続URL（サイトの /pairing#invitationToken=...） */
      pairingUrl: (invitationToken) => new URL(PAIRING_URL_PREFIX + encodeURIComponent(invitationToken), location.origin).href,
    },

    // 子ども端末のQR接続
    pairing: {
      /**
       * QRで開いたURLから招待トークンを取り出す。取り出したらURLから消す（保存しない）。
       * トークンがなければ null。
       */
      takeInvitationToken() {
        const match = /^#invitationToken=(.+)$/.exec(location.hash);
        if (!match) return null;
        cleanUrl({ fragment: true });
        try {
          return decodeURIComponent(match[1]);
        } catch {
          return null;
        }
      },
      /** 子ども端末：仮セッションを始める → PairingSession */
      bootstrap: () => call('pairing.bootstrap'),
      /** 子ども端末：接続を申請する → PairingView（confirmationCode を画面に出す） */
      request: (invitationToken) => call('pairing.request', { invitationToken }),
      /** 子ども端末：承認されたかを見る → PairingView */
      status: (pairingRequestId) => call('pairing.status', { pairingRequestId }),
      /** 子ども端末：承認後に接続を確定する → SignedInSession */
      complete: (pairingRequestId) => call('pairing.complete', { pairingRequestId }),
      /** 保護者：届いた申請を見る → PairingList { requests } */
      listRequests: () => call('pairing.requests.list'),
      /** 保護者：承認・拒否する（decision: 'approved' | 'rejected'） → PairingView。Google再認証が必要 */
      respond: (pairingRequestId, decision) => call('pairing.respond', { pairingRequestId, decision }),
    },
  };
})();
