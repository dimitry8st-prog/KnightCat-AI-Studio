'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const publisher = require('./vk-publisher.cjs');
const http = require('./vk-http.cjs');
const { syncWorkflow } = require('./sync-workflow.cjs');

const root = path.join(__dirname, '..', '..');
const NOW = '2026-10-11T10:00:00.000Z';
const LATER = '2026-10-11T10:05:00.000Z';

function jpeg(width, height) {
  const buffer = Buffer.alloc(17);
  buffer[0] = 0xff;
  buffer[1] = 0xd8;
  buffer[2] = 0xff;
  buffer[3] = 0xc0;
  buffer.writeUInt16BE(11, 4);
  buffer[6] = 8;
  buffer.writeUInt16BE(height, 7);
  buffer.writeUInt16BE(width, 9);
  buffer[11] = 1;
  buffer[15] = 0xff;
  buffer[16] = 0xd9;
  return buffer;
}

function wallText() {
  const sentence = 'Кот-рыцарь ведёт идею от черновика до стены сообщества и спрашивает, что думаете? ';
  let text = '';
  while (text.length < 617) text += sentence;
  return text.slice(0, 617);
}

function draft(overrides) {
  const pkg = {
    request_id: 'draft-1',
    status: 'review_required',
    source: { chat_id: '10', user_id: '20' },
    platforms: {
      telegram: { content: 'Текст Telegram для проверки, что ветка не потерялась и остаётся отдельной.' },
      vk: { content: wallText() }
    },
    visual: { image: null },
    approval: { decision: 'pending', decided_by: null, decided_at: null },
    publication: {
      telegram: { status: 'not_started', message_id: null, chat_id: '-100', locked_at: null },
      vk: publisher.emptyVkPublication()
    }
  };
  const attached = publisher.attachDraftImage(pkg, jpeg(640, 360), 'photo.jpg');
  assert.strictEqual(attached.ok, true);
  return Object.assign(pkg, overrides || {});
}

const uploadServer = { response: { upload_url: 'https://pu.vk.ru/upload?act=do_add' } };
const uploaded = { server: 1, photo: '[]', hash: 'abc' };
const saved = { response: [{ id: 456, owner_id: -123 }] };
const posted = { response: { post_id: 17 } };

function arm(pkg, options) {
  const opts = options || {};
  const now = opts.now || NOW;
  const claim = publisher.claimPublication(pkg, { now });
  if (claim.action !== 'publish') return { claim, wallBodies: [] };
  const token = claim.lock_token;
  const prepared = publisher.prepareGetUploadServer(pkg, { lockToken: token, groupId: '123', now });
  if (!prepared.ready) return { claim, prepared, token, wallBodies: [] };
  const accepted = publisher.acceptUploadServer(pkg, {
    lockToken: token,
    body: opts.uploadServer || uploadServer,
    now
  });
  if (!accepted.ready) return { claim, prepared, accepted, token, wallBodies: [] };
  const photo = publisher.acceptPhotoUpload(pkg, {
    lockToken: token,
    groupId: '123',
    body: opts.uploaded || uploaded,
    now
  });
  if (!photo.ready) return { claim, prepared, accepted, photo, token, wallBodies: [] };
  const armed = publisher.acceptSavedPhoto(pkg, {
    lockToken: token,
    groupId: '123',
    body: opts.saved || saved,
    now
  });
  return {
    claim,
    prepared,
    accepted,
    photo,
    armed,
    token,
    wallBodies: armed.ready ? [armed.vk_request_body] : []
  };
}

test('текст с изображением черновика готовит одну запись сообщества', () => {
  const pkg = draft();
  const flow = arm(pkg);
  assert.strictEqual(flow.armed.ready, true);
  assert.strictEqual(pkg.publication.vk.status, 'publishing');
  assert.strictEqual(flow.prepared.vk_request_url, 'https://api.vk.ru/method/photos.getWallUploadServer');
  assert.strictEqual(flow.armed.vk_request_url, 'https://api.vk.ru/method/wall.post');
  const params = new URLSearchParams(flow.armed.vk_request_body);
  assert.strictEqual(params.get('owner_id'), '-123');
  assert.strictEqual(params.get('from_group'), '1');
  assert.strictEqual(params.get('signed'), '0');
  assert.strictEqual(params.get('attachments'), 'photo-123_456');
  assert.strictEqual(params.get('message'), pkg.platforms.vk.content);
  assert.strictEqual(params.get('v'), '5.131');
  assert.strictEqual(params.get('access_token'), null);
  assert.doesNotMatch(flow.armed.vk_request_body, /access_token=/);
  const savedPost = publisher.acceptWallPost(pkg, { lockToken: flow.token, groupId: '123', body: posted, now: NOW });
  assert.strictEqual(savedPost.action, 'published');
  assert.strictEqual(savedPost.url, 'https://vk.com/wall-123_17');
  assert.strictEqual(flow.wallBodies.length, 1);
  const again = publisher.claimPublication(pkg, { now: LATER });
  assert.strictEqual(again.action, 'already_published');
  assert.strictEqual(again.url, 'https://vk.com/wall-123_17');
});

test('свежая блокировка не пускает второй запрос к wall.post', () => {
  const pkg = draft();
  const first = publisher.claimPublication(pkg, { now: NOW });
  const second = publisher.claimPublication(pkg, { now: '2026-10-11T10:00:01.000Z' });
  assert.strictEqual(second.action, 'in_progress');
  assert.strictEqual(pkg.publication.vk.lock_token, first.lock_token);
  const hijack = publisher.acceptSavedPhoto(pkg, {
    lockToken: 'other-request',
    groupId: '123',
    body: saved,
    now: NOW
  });
  assert.strictEqual(hijack.action, 'lock_lost');
  assert.strictEqual(pkg.publication.vk.status, 'locked');
  assert.strictEqual(pkg.publication.vk.lock_token, first.lock_token);
});

test('reject не готовит загрузку и публикацию', () => {
  const pkg = draft();
  const decision = publisher.applyReject({ pkg, chatId: '10', userId: '20', now: NOW });
  assert.strictEqual(decision.rejected, true);
  assert.strictEqual(decision.publish, false);
  const claim = publisher.claimPublication(pkg, { now: LATER });
  assert.strictEqual(claim.action, 'rejected');
  assert.strictEqual(pkg.publication.vk.status, 'not_started');
});

test('недействительный ключ останавливает публикацию до wall.post', () => {
  const pkg = draft();
  const flow = arm(pkg, { uploadServer: { error: { error_code: 5, error_msg: 'User authorization failed' } } });
  assert.strictEqual(flow.accepted.action, 'failed');
  assert.strictEqual(flow.accepted.error_code, '5');
  assert.match(flow.accepted.error_message, /недействителен/);
  assert.strictEqual(flow.wallBodies.length, 0);
  assert.notStrictEqual(pkg.publication.vk.status, 'publishing');
  assert.strictEqual(flow.accepted.retryable, true);
});

test('ошибка загрузки не создаёт запись', () => {
  const pkg = draft();
  const flow = arm(pkg, { uploaded: { error: { error_code: 22, error_msg: 'Upload error' } } });
  assert.strictEqual(flow.photo.action, 'failed');
  assert.strictEqual(flow.photo.error_code, '22');
  assert.match(flow.photo.error_message, /изображение/);
  assert.strictEqual(flow.wallBodies.length, 0);
  assert.strictEqual(flow.photo.retryable, true);
  assert.notStrictEqual(pkg.publication.vk.status, 'publishing');
});

test('тайм-аут после arm не открывает второй wall.post', () => {
  const pkg = draft();
  const flow = arm(pkg);
  assert.strictEqual(flow.wallBodies.length, 1);
  const unknown = publisher.markPublishUnknown(pkg, {
    lockToken: flow.token,
    body: { error: { message: 'socket timeout' } }
  });
  assert.strictEqual(unknown.action, 'uncertain');
  assert.strictEqual(unknown.retryable, false);
  const second = publisher.claimPublication(pkg, { now: LATER });
  assert.strictEqual(second.action, 'reconcile');
  assert.notStrictEqual(second.action, 'publish');
  const request = publisher.buildReconcileRequest(pkg, { groupId: '123' });
  assert.strictEqual(request.scope, 'recent');
  assert.strictEqual(request.vk_request_url, 'https://api.vk.ru/method/wall.get');
  const applied = publisher.applyReconcileResult(pkg, {
    groupId: '123',
    scope: 'recent',
    body: { response: { items: [] } },
    now: LATER
  });
  assert.strictEqual(applied.action, 'uncertain');
  assert.strictEqual(applied.error_code, 'scan_inconclusive');
  assert.strictEqual(applied.retryable, false);
  const third = publisher.claimPublication(pkg, { now: '2026-10-11T10:06:00.000Z' });
  assert.strictEqual(third.action, 'reconcile');
});

test('пустой просмотр 20 записей и absent не доказывают отсутствие', () => {
  const pkg = draft();
  pkg.publication.vk.status = 'uncertain';
  pkg.publication.vk.retryable = false;
  const empty = publisher.applyReconcileResult(pkg, {
    groupId: '123',
    scope: 'recent',
    body: { response: { count: 20, items: [] } },
    now: NOW
  });
  assert.strictEqual(empty.error_code, 'scan_inconclusive');
  assert.strictEqual(empty.retryable, false);
  assert.match(empty.error_message, /не доказывает/);
  const plan = publisher.planResolve(pkg, 'absent');
  assert.strictEqual(plan.http, false);
  assert.strictEqual(plan.action, 'stop');
  assert.match(plan.message, /не снимает блокировку/);
  assert.strictEqual(pkg.publication.vk.status, 'uncertain');
  const claim = publisher.claimPublication(pkg, { now: LATER });
  assert.strictEqual(claim.action, 'reconcile');
  assert.notStrictEqual(claim.action, 'publish');
});

test('одно точное совпадение среди 20 подтверждает запись, промах by id — нет', () => {
  const found = draft();
  found.publication.vk.status = 'uncertain';
  const matched = publisher.applyReconcileResult(found, {
    groupId: '123',
    scope: 'recent',
    body: { response: { items: [{ id: 91, text: found.platforms.vk.content }, { id: 3, text: 'другой текст' }] } },
    now: NOW
  });
  assert.strictEqual(matched.action, 'published');
  assert.strictEqual(matched.url, 'https://vk.com/wall-123_91');
  assert.strictEqual(publisher.claimPublication(found, { now: LATER }).action, 'already_published');

  const missed = draft({ request_id: 'draft-2' });
  missed.publication.vk.status = 'uncertain';
  const byId = publisher.applyReconcileResult(missed, {
    groupId: '123',
    scope: 'by_id',
    postId: '91',
    body: { response: [] },
    now: NOW
  });
  assert.strictEqual(byId.action, 'uncertain');
  assert.strictEqual(byId.error_code, 'by_id_miss');
  assert.strictEqual(byId.retryable, false);
  assert.strictEqual(publisher.claimPublication(missed, { now: LATER }).action, 'reconcile');

  const ambiguous = draft({ request_id: 'draft-3' });
  ambiguous.publication.vk.status = 'uncertain';
  const many = publisher.applyReconcileResult(ambiguous, {
    groupId: '123',
    scope: 'recent',
    body: {
      response: {
        items: [
          { id: 1, text: ambiguous.platforms.vk.content },
          { id: 2, text: ambiguous.platforms.vk.content }
        ]
      }
    },
    now: NOW
  });
  assert.strictEqual(many.error_code, 'ambiguous');
  assert.strictEqual(many.retryable, false);
});

test('устаревший статус publishing уходит в сверку, а не в новый пост', () => {
  const pkg = draft();
  pkg.publication.vk.status = 'publishing';
  pkg.publication.vk.locked_at = '2026-10-11T09:00:00.000Z';
  pkg.publication.vk.lock_token = 'old';
  const claim = publisher.claimPublication(pkg, { now: NOW });
  assert.strictEqual(claim.action, 'reconcile');
  assert.strictEqual(pkg.publication.vk.status, 'uncertain');
  assert.strictEqual(pkg.publication.vk.retryable, false);
});

test('фото не с owner_id сообщества не готовит wall.post', () => {
  const pkg = draft();
  const flow = arm(pkg, { saved: { response: [{ id: 7, owner_id: 555 }] } });
  assert.strictEqual(flow.armed.action, 'failed');
  assert.strictEqual(flow.armed.error_code, 'attachment_owner');
  assert.strictEqual(flow.wallBodies.length, 0);
  assert.notStrictEqual(pkg.publication.vk.status, 'publishing');
});

test('чужой адрес загрузки и известная ошибка wall.post не становятся публикацией', () => {
  const pkg = draft();
  const foreign = arm(pkg, { uploadServer: { response: { upload_url: 'https://evil.example/upload' } } });
  assert.strictEqual(foreign.accepted.error_code, 'upload_host');
  assert.strictEqual(foreign.wallBodies.length, 0);

  const refused = draft({ request_id: 'draft-refused' });
  const flow = arm(refused);
  const outcome = publisher.acceptWallPost(refused, {
    lockToken: flow.token,
    groupId: '123',
    body: { error: { error_code: 214, error_msg: 'Access denied' } },
    now: NOW
  });
  assert.strictEqual(outcome.action, 'failed');
  assert.strictEqual(outcome.error_code, '214');
  assert.strictEqual(outcome.retryable, true);

  const vague = draft({ request_id: 'draft-vague' });
  const armed = arm(vague);
  const unknown = publisher.acceptWallPost(vague, {
    lockToken: armed.token,
    groupId: '123',
    body: { error: { error_code: 10, error_msg: 'Internal server error' } },
    now: NOW
  });
  assert.strictEqual(unknown.action, 'uncertain');
  assert.strictEqual(unknown.retryable, false);
});

test('пакет без лимитов и без изображения не доходит до HTTP', () => {
  const short = {
    analysis: { warnings: [] },
    image_prompt: 'poster',
    platforms: {
      vk: { content: 'коротко' },
      x: { content: 'x' },
      telegram: { content: 'telegram' },
      instagram: { content: 'instagram' },
      tiktok: { content: 'tiktok' }
    }
  };
  const verdict = publisher.validateModelPackage(short);
  assert.strictEqual(verdict.ok, false);
  assert.match(verdict.errors.join('\n'), /vk/);
  assert.strictEqual(publisher.validateModelPackage({ platforms: short.platforms }).ok, false);

  const pkg = draft();
  pkg.visual.image = null;
  const claim = publisher.claimPublication(pkg, { now: NOW });
  const prepared = publisher.prepareGetUploadServer(pkg, {
    lockToken: claim.lock_token,
    groupId: '123',
    now: NOW
  });
  assert.strictEqual(prepared.ready, false);
  assert.strictEqual(pkg.publication.vk.error_code, 'validation');
  assert.strictEqual(pkg.publication.vk.retryable, true);
  pkg.visual.image = { path: 'C:/secret.jpg', filename: 'secret.jpg' };
  assert.strictEqual(publisher.readDraftImage(pkg), null);
});

test('размеры JPEG, PNG и слишком узкого кадра проверяются до сохранения', () => {
  const png = Buffer.alloc(24);
  png.write('PNG', 1, 'ascii');
  png[0] = 0x89;
  png.writeUInt32BE(32, 16);
  png.writeUInt32BE(16, 20);
  const inspected = publisher.inspectImage(png, 'photo.png');
  assert.strictEqual(inspected.ok, true);
  assert.strictEqual(inspected.image.width, 32);
  assert.strictEqual(inspected.image.height, 16);
  const narrow = publisher.inspectImage(jpeg(2100, 100), 'narrow.jpg');
  assert.strictEqual(narrow.ok, false);
  assert.match(narrow.errors[0], /1:20/);
});

test('HTTP-клиент проверки кладёт ключ только в заголовок', async () => {
  const seen = [];
  const client = http.createHttpClient({
    fetchImpl: async (url, options) => {
      seen.push({ url, options });
      return { json: async () => ({ response: { permissions: [{ name: 'wall' }] } }) };
    }
  });
  await client.call('groups.getTokenPermissions', {}, { token: 'community-token-fixture', phase: 'probe' });
  assert.strictEqual(seen[0].url, 'https://api.vk.ru/method/groups.getTokenPermissions');
  assert.strictEqual(seen[0].options.headers.Authorization, 'Bearer community-token-fixture');
  assert.doesNotMatch(seen[0].url, /community-token-fixture|access_token/);
  assert.doesNotMatch(seen[0].options.body, /access_token=/);
  assert.match(seen[0].options.body, /v=5\.131/);
  const source = fs.readFileSync(path.join(__dirname, 'vk-publisher.cjs'), 'utf8');
  assert.doesNotMatch(source, /helpers\.httpRequest|createN8nVkClient|\bfetch\s*\(/);
});

test('подготовленный тестовый пост: длина, JPEG и отсутствие публикации', () => {
  const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'test-post.json'), 'utf8'));
  const text = fixture.text.trim();
  assert.ok(text.length >= 500 && text.length <= 800, 'длина VK-текста ' + text.length);
  assert.match(text, /\?\s*$/);
  assert.strictEqual(fixture.published, false);
  assert.strictEqual(fixture.target_community.group_id, null);
  const bytes = fs.readFileSync(path.join(root, fixture.image.path));
  const inspected = publisher.inspectImage(bytes, 'poster.jpg');
  assert.strictEqual(inspected.ok, true);
  assert.ok(bytes.length < publisher.MAX_IMAGE_BYTES);
});

test('workflow n8n: HTTP Request, фото черновика, без HTTP внутри Code', () => {
  syncWorkflow();
  const workflow = JSON.parse(fs.readFileSync(path.join(root, 'n8n', 'workflows', 'knightcat-minimal-telegram.json'), 'utf8'));
  assert.strictEqual(workflow.active, false);
  assert.strictEqual(workflow.id, 'KnightCatMvpTg01');
  const byName = (name) => workflow.nodes.find((node) => node.name === name);
  const names = workflow.nodes.map((node) => node.name);
  for (const name of [
    'Telegram Trigger',
    'Publish to Telegram',
    'Mark as Published',
    'Confirm Publication',
    'Reject Draft',
    'Has Draft Photo?',
    'Download Draft Photo',
    'Attach Draft Image',
    'Claim VK Publish',
    'VK Wall Post',
    'Mark VK Unknown',
    'Plan VK Resolve'
  ]) {
    assert.ok(names.includes(name), name);
  }
  assert.ok(!names.includes('Publish to VK'));
  assert.ok(!names.includes('Resolve VK Status'));

  const download = byName('Download Draft Photo');
  assert.strictEqual(download.type, 'n8n-nodes-base.telegram');
  assert.strictEqual(download.parameters.resource, 'file');
  assert.strictEqual(download.parameters.operation, 'get');
  assert.strictEqual(download.parameters.download, true);
  assert.strictEqual(download.onError, 'continueErrorOutput');

  const wall = byName('VK Wall Post');
  assert.strictEqual(wall.type, 'n8n-nodes-base.httpRequest');
  assert.strictEqual(wall.typeVersion, 4.2);
  assert.strictEqual(wall.parameters.url, 'https://api.vk.ru/method/wall.post');
  assert.strictEqual(wall.retryOnFail, false);
  assert.strictEqual(wall.onError, 'continueErrorOutput');
  assert.strictEqual(wall.credentials.httpBearerAuth.id, 'REPLACE_VK_COMMUNITY_BEARER_ID');
  assert.strictEqual(workflow.connections['VK Wall Post'].main[0][0].node, 'Save VK Post');
  assert.strictEqual(workflow.connections['VK Wall Post'].main[1][0].node, 'Mark VK Unknown');
  assert.strictEqual(workflow.connections['Mark VK Unknown'].main[0][0].node, 'Confirm Publication');
  const unknownLinks = JSON.stringify(workflow.connections['Mark VK Unknown']);
  assert.doesNotMatch(unknownLinks, /VK Wall Post/);

  const upload = byName('VK Upload Photo');
  assert.strictEqual(upload.parameters.contentType, 'multipart-form-data');
  assert.strictEqual(upload.parameters.bodyParameters.parameters[0].name, 'photo');
  assert.strictEqual(upload.parameters.bodyParameters.parameters[0].parameterType, 'formBinaryData');
  assert.strictEqual(upload.retryOnFail, false);
  assert.ok(!upload.credentials);

  assert.strictEqual(byName('VK Get Upload Server').parameters.url, 'https://api.vk.ru/method/photos.getWallUploadServer');
  assert.strictEqual(byName('VK Get Upload Server').credentials.httpBearerAuth.id, 'REPLACE_VK_USER_BEARER_ID');
  assert.strictEqual(byName('VK Save Wall Photo').parameters.url, 'https://api.vk.ru/method/photos.saveWallPhoto');
  assert.strictEqual(byName('VK Reconcile Wall').parameters.url, '={{ $json.vk_request_url }}');
  assert.strictEqual(workflow.connections['VK Get Upload Server'].main[1][0].node, 'Record VK Upload Failure');
  assert.strictEqual(workflow.connections['VK Upload Photo'].main[1][0].node, 'Record VK Upload Failure');
  assert.strictEqual(workflow.connections['VK Save Wall Photo'].main[1][0].node, 'Record VK Upload Failure');
  assert.strictEqual(workflow.connections['VK Reconcile Wall'].main[1][0].node, 'Record VK Reconcile Failure');

  assert.strictEqual(workflow.connections['Package Valid?'].main[0][0].node, 'Has Draft Photo?');
  assert.strictEqual(workflow.connections['Has Draft Photo?'].main[0][0].node, 'Download Draft Photo');
  assert.strictEqual(workflow.connections['Has Draft Photo?'].main[1][0].node, 'Store Pending Draft');
  assert.strictEqual(workflow.connections['Download Draft Photo'].main[0][0].node, 'Attach Draft Image');
  assert.strictEqual(workflow.connections['Image Accepted?'].main[0][0].node, 'Store Pending Draft');
  assert.strictEqual(workflow.connections['Need Telegram Publish?'].main[0][0].node, 'Publish to Telegram');
  assert.strictEqual(workflow.connections['Need Telegram Publish?'].main[1][0].node, 'Claim VK Publish');
  assert.strictEqual(workflow.connections['Mark as Published'].main[0][0].node, 'Claim VK Publish');
  assert.strictEqual(workflow.connections['Reject Draft'].main[0][0].node, 'Confirm Rejection');
  assert.strictEqual(workflow.connections['Route Event'].main[3][0].node, 'Plan VK Resolve');
  assert.strictEqual(workflow.connections['Resolve Needs HTTP?'].main[1][0].node, 'Send Approval Error');

  for (const node of workflow.nodes) {
    if (!node.parameters || !node.parameters.jsCode) continue;
    assert.doesNotMatch(node.parameters.jsCode, /helpers\.httpRequest|createN8nVkClient|\bfetch\s*\(/, node.name);
  }
  const raw = JSON.stringify(workflow);
  assert.doesNotMatch(raw, /vk1\.[A-Za-z0-9_-]{10,}/);
  assert.doesNotMatch(raw, /access_token\s*[:=]\s*['"][^'"]+['"]/);
  const embedded = byName('Claim VK Publish').parameters.jsCode.split('/* BEGIN vk-publisher.cjs */')[1].split('/* END vk-publisher.cjs */')[0].trim();
  const source = fs.readFileSync(path.join(__dirname, 'vk-publisher.cjs'), 'utf8').replace(/\r\n/g, '\n').trim();
  assert.strictEqual(embedded, source);
  assert.match(byName('Normalize and Authorize').parameters.jsCode, /source_photo_file_id/);
  assert.doesNotMatch(byName('Normalize and Authorize').parameters.jsCode, /vk-resolve ID absent/);
});

test('узлы approve, reject и валидации сохраняют развилку Telegram', async () => {
  const store = { pending: {}, latestByChat: {} };
  const workflow = JSON.parse(fs.readFileSync(path.join(root, 'n8n', 'workflows', 'knightcat-minimal-telegram.json'), 'utf8'));
  const codeOf = (name) => workflow.nodes.find((node) => node.name === name).parameters.jsCode;

  async function run(code, json, lookup) {
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    const fn = new AsyncFunction('$json', '$vars', '$getWorkflowStaticData', '$', '$input', code);
    const dollar = (name) => ({ first: () => ({ json: lookup && lookup[name] ? lookup[name] : json }) });
    return fn.call({}, json, { KNIGHTCAT_ALLOWED_USER_IDS: '20' }, () => store, dollar, { item: {} });
  }

  const idea = (await run(codeOf('Normalize and Authorize'), {
    message: {
      chat: { id: 10 },
      from: { id: 20 },
      message_id: 1,
      text: 'Кот-рыцарь готовит пост для стены сообщества.',
      photo: [{ file_id: 'small', file_size: 10 }, { file_id: 'large', file_size: 90 }]
    }
  }))[0];
  assert.strictEqual(idea.json.event_type, 'generate');
  assert.strictEqual(idea.json.source_photo_file_id, 'large');
  const resolve = (await run(codeOf('Normalize and Authorize'), {
    message: { chat: { id: 10 }, from: { id: 20 }, message_id: 4, text: '/vk-resolve draft-1 absent' }
  }))[0];
  assert.strictEqual(resolve.json.event_type, 'vk_resolve');
  assert.strictEqual(resolve.json.resolve_argument, 'absent');

  const fresh = draft();
  store.pending[fresh.request_id] = fresh;
  const decision = (await run(codeOf('Load Pending Draft'), {
    target_request_id: fresh.request_id,
    reply_chat_id: '10',
    user_id: '20',
    config: { footer: '' }
  }))[0];
  assert.strictEqual(decision.json.approval_valid, true);
  assert.strictEqual(decision.json.publish_telegram, true);
  assert.match(decision.json.publish_text, /Текст Telegram/);

  const blocked = publisher.applyReject({ pkg: fresh, chatId: '10', userId: '20', now: '2026-10-11T11:00:00.000Z' });
  assert.strictEqual(blocked.rejected, false);
  const rejectDecision = (await run(codeOf('Reject Draft'), {
    target_request_id: 'draft-1',
    reply_chat_id: '10',
    user_id: '20'
  }))[0];
  assert.match(rejectDecision.json.user_message, /уже обработан|не опубликован/);
  assert.notStrictEqual(store.pending[fresh.request_id].publication.vk.status, 'published');

  const original = {
    request_id: 'r1',
    source_text: 'Идея для пяти площадок с фотографией.',
    source_chat_id: '10',
    user_id: '20',
    received_at: NOW,
    source_photo_file_id: 'large',
    reply_chat_id: '10',
    config: { model: 'openai/gpt-4.1-mini', publish_chat_id: '-100' },
    prompt_version: 'v1'
  };
  const model = {
    analysis: { warnings: [] },
    image_prompt: 'poster',
    suggested_headline: 'Заголовок',
    platforms: {
      vk: { content: wallText() },
      x: { content: 'Коротко для X.' },
      telegram: { content: 'Текст Telegram.' },
      instagram: { content: 'Текст Instagram.' },
      tiktok: { content: 'Текст TikTok.' }
    }
  };
  const tooShort = JSON.parse(JSON.stringify(model));
  tooShort.platforms.vk.content = 'коротко';
  const invalid = (await run(codeOf('Parse and Validate Package'), {
    choices: [{ message: { content: JSON.stringify(tooShort) } }]
  }, { 'Prepare AI Request': original }))[0];
  assert.strictEqual(invalid.json.package_valid, false);
  assert.match(invalid.json.user_message, /500/);
  assert.strictEqual(store.pending.r1, undefined);

  const valid = (await run(codeOf('Parse and Validate Package'), {
    choices: [{ message: { content: JSON.stringify(model) } }]
  }, { 'Prepare AI Request': original }))[0];
  assert.strictEqual(valid.json.package_valid, true);
  assert.strictEqual(valid.json.content_package.source.photo_file_id, 'large');
  assert.strictEqual(valid.json.content_package.visual.image, null);
  assert.strictEqual(valid.json.source_photo_file_id, 'large');

  const planned = (await run(codeOf('Plan VK Resolve'), {
    reply_chat_id: '10',
    target_request_id: fresh.request_id,
    resolve_argument: 'absent'
  }))[0];
  fresh.publication.vk.status = 'uncertain';
  store.pending[fresh.request_id] = fresh;
  const plannedAgain = (await run(codeOf('Plan VK Resolve'), {
    reply_chat_id: '10',
    target_request_id: fresh.request_id,
    resolve_argument: 'absent'
  }))[0];
  assert.strictEqual(planned.json.vk_action, 'stop');
  assert.strictEqual(plannedAgain.json.vk_action, 'stop');
  assert.match(plannedAgain.json.user_message, /не снимает блокировку/);
  assert.strictEqual(store.pending[fresh.request_id].publication.vk.status, 'uncertain');
});
