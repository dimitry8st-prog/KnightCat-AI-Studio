'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const publisher = require('./vk-publisher.cjs');

const root = path.join(__dirname, '..', '..');
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x00, 0xff, 0xd9]);
const credentials = {
  groupId: '123',
  communityToken: 'community-token-fixture',
  userToken: 'user-token-fixture'
};

function draft(overrides) {
  const pkg = {
    request_id: 'draft-1',
    status: 'review_required',
    source: { chat_id: '10', user_id: '20' },
    platforms: {
      telegram: { content: 'Текст Telegram для проверки, что ветка не потерялась и остаётся отдельной.' },
      vk: { content: 'Текст стены ВКонтакте. Что думаете?' }
    },
    visual: { image: { bytes: jpeg, filename: 'photo.jpg' } },
    approval: { decision: 'pending', decided_by: null, decided_at: null },
    publication: {
      telegram: { status: 'not_started', message_id: null, chat_id: '-100', locked_at: null },
      vk: publisher.emptyVkPublication()
    }
  };
  return Object.assign(pkg, overrides);
}

function fakeClient(handlers) {
  const calls = [];
  return {
    calls,
    async call(method, params, options) {
      calls.push({ method, params, phase: options && options.phase, token: options && options.token });
      if (handlers && handlers.call) {
        const custom = await handlers.call(method, params, options, calls);
        if (custom !== undefined) return custom;
      }
      if (method === 'photos.getWallUploadServer') {
        return { upload_url: 'https://pu.vk.ru/upload?act=do_add', album_id: -14 };
      }
      if (method === 'photos.saveWallPhoto') {
        return [{ id: 456, owner_id: -123 }];
      }
      if (method === 'wall.post') return { post_id: 17 };
      if (method === 'wall.get' || method === 'wall.getById') return { items: [] };
      throw new Error('Неожиданный метод ' + method);
    },
    async upload(url, image) {
      calls.push({ method: 'upload', url, bytes: image.bytes.length });
      if (handlers && handlers.upload) return handlers.upload(url, image, calls);
      return { server: 1, photo: '[]', hash: 'abc' };
    }
  };
}

function wallPosts(client) {
  return client.calls.filter((call) => call.method === 'wall.post');
}

test('текст с изображением: вложение сообщества и одна запись', async () => {
  const pkg = draft();
  const client = fakeClient();
  const outcome = await publisher.publishApprovedDraft({
    pkg,
    credentials,
    client,
    now: '2026-10-11T10:00:00.000Z'
  });
  assert.strictEqual(outcome.action, 'published');
  assert.strictEqual(outcome.attachment, 'photo-123_456');
  assert.strictEqual(outcome.post_id, 17);
  assert.strictEqual(outcome.url, 'https://vk.com/wall-123_17');
  assert.strictEqual(wallPosts(client).length, 1);
  const post = wallPosts(client)[0];
  assert.strictEqual(post.params.owner_id, -123);
  assert.strictEqual(post.params.from_group, 1);
  assert.strictEqual(post.params.attachments, 'photo-123_456');
  assert.strictEqual(post.params.message, pkg.platforms.vk.content);
  assert.strictEqual(post.token, credentials.communityToken);
  assert.notStrictEqual(client.calls.find((call) => call.method === 'photos.getWallUploadServer').token, credentials.communityToken);
  assert.strictEqual(pkg.status, 'published');
});

test('повторный approve не создаёт второй пост', async () => {
  const pkg = draft();
  const client = fakeClient();
  await publisher.publishApprovedDraft({ pkg, credentials, client, now: '2026-10-11T10:00:00.000Z' });
  const again = await publisher.publishApprovedDraft({ pkg, credentials, client, now: '2026-10-11T10:05:00.000Z' });
  assert.strictEqual(again.action, 'already_published');
  assert.strictEqual(again.url, 'https://vk.com/wall-123_17');
  assert.strictEqual(wallPosts(client).length, 1);
});

test('параллельный approve не вызывает вторую публикацию', async () => {
  const pkg = draft();
  let release;
  const client = fakeClient({
    call(method) {
      if (method === 'wall.post') {
        return new Promise((resolve) => {
          release = () => resolve({ post_id: 17 });
        });
      }
      return undefined;
    }
  });
  const first = publisher.publishApprovedDraft({ pkg, credentials, client, now: '2026-10-11T10:00:00.000Z' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(release, 'первый запрос должен дойти до wall.post и удерживать блокировку');
  const second = await publisher.publishApprovedDraft({
    pkg,
    credentials,
    client,
    now: '2026-10-11T10:00:01.000Z'
  });
  assert.strictEqual(second.action, 'in_progress');
  release();
  const done = await first;
  assert.strictEqual(done.action, 'published');
  assert.strictEqual(wallPosts(client).length, 1);
});

test('reject не вызывает загрузку и публикацию', async () => {
  const pkg = draft();
  const decision = publisher.applyReject({
    pkg,
    chatId: '10',
    userId: '20',
    now: '2026-10-11T10:00:00.000Z'
  });
  assert.strictEqual(decision.rejected, true);
  assert.strictEqual(decision.publish, false);
  const client = fakeClient();
  const outcome = await publisher.publishApprovedDraft({ pkg, credentials, client, now: '2026-10-11T10:00:01.000Z' });
  assert.strictEqual(outcome.action, 'rejected');
  assert.strictEqual(client.calls.length, 0);
  assert.strictEqual(pkg.publication.vk.status, 'not_started');
});

test('недействительный токен останавливает публикацию до wall.post', async () => {
  const pkg = draft();
  const client = fakeClient({
    call() {
      throw publisher.interpretVkBody({ error: { error_code: 5, error_msg: 'User authorization failed' } }, 'upload');
    }
  });
  const outcome = await publisher.publishApprovedDraft({ pkg, credentials, client, now: '2026-10-11T10:00:00.000Z' });
  assert.strictEqual(outcome.action, 'failed');
  assert.strictEqual(outcome.error_code, '5');
  assert.match(outcome.error_message, /недействителен/);
  assert.strictEqual(wallPosts(client).length, 0);
  assert.doesNotMatch(outcome.error_message, /community-token-fixture|user-token-fixture/);
});

test('ошибка загрузки не создаёт запись', async () => {
  const pkg = draft();
  const client = fakeClient({
    upload() {
      throw publisher.interpretVkBody({ error: { error_code: 22, error_msg: 'Upload error' } }, 'upload');
    }
  });
  const outcome = await publisher.publishApprovedDraft({ pkg, credentials, client, now: '2026-10-11T10:00:00.000Z' });
  assert.strictEqual(outcome.action, 'failed');
  assert.strictEqual(outcome.error_code, '22');
  assert.match(outcome.error_message, /изображение/);
  assert.strictEqual(wallPosts(client).length, 0);
  assert.strictEqual(outcome.retryable, true);
});

test('тайм-аут wall.post не повторяет публикацию', async () => {
  const pkg = draft();
  const client = fakeClient({
    call(method) {
      if (method === 'wall.post') throw publisher.classifyTransportError(new Error('socket timeout'), 'publish');
      if (method === 'wall.get') return { items: [] };
      return undefined;
    }
  });
  const first = await publisher.publishApprovedDraft({ pkg, credentials, client, now: '2026-10-11T10:00:00.000Z' });
  assert.strictEqual(first.action, 'uncertain');
  assert.strictEqual(first.retryable, false);
  const postsAfterTimeout = wallPosts(client).length;
  const second = await publisher.publishApprovedDraft({ pkg, credentials, client, now: '2026-10-11T10:05:00.000Z' });
  assert.strictEqual(second.action, 'uncertain');
  assert.strictEqual(wallPosts(client).length, postsAfterTimeout);
  assert.ok(client.calls.some((call) => call.method === 'wall.get'));
});

test('ручное absent после пустой сверки разрешает одну новую попытку', async () => {
  const pkg = draft();
  pkg.publication.vk.status = 'uncertain';
  pkg.publication.vk.error_code = 'timeout';
  const client = fakeClient({
    call(method) {
      if (method === 'wall.get') return { items: [] };
      return undefined;
    }
  });
  const resolved = await publisher.resolveUncertain({
    pkg,
    argument: 'absent',
    credentials,
    client,
    now: '2026-10-11T10:10:00.000Z'
  });
  assert.strictEqual(resolved.action, 'failed');
  assert.strictEqual(resolved.error_code, 'confirmed_absent');
  assert.strictEqual(wallPosts(client).length, 0);
  const published = await publisher.publishApprovedDraft({ pkg, credentials, client, now: '2026-10-11T10:11:00.000Z' });
  assert.strictEqual(published.action, 'published');
  assert.strictEqual(wallPosts(client).length, 1);
});

test('сверка находит уже созданную запись и не публикует ещё раз', async () => {
  const pkg = draft();
  pkg.publication.vk.status = 'uncertain';
  const client = fakeClient({
    call(method) {
      if (method === 'wall.get') return { items: [{ id: 91, text: pkg.platforms.vk.content }] };
      return undefined;
    }
  });
  const outcome = await publisher.publishApprovedDraft({
    pkg,
    credentials,
    client,
    now: '2026-10-11T10:20:00.000Z',
    mode: 'reconcile_only'
  });
  assert.strictEqual(outcome.action, 'published');
  assert.strictEqual(outcome.url, 'https://vk.com/wall-123_91');
  assert.strictEqual(wallPosts(client).length, 0);
});

test('фото не с owner_id сообщества не уходит в wall.post', async () => {
  const pkg = draft();
  const client = fakeClient({
    call(method) {
      if (method === 'photos.saveWallPhoto') return [{ id: 7, owner_id: 555 }];
      return undefined;
    }
  });
  const outcome = await publisher.publishApprovedDraft({ pkg, credentials, client, now: '2026-10-11T10:00:00.000Z' });
  assert.strictEqual(outcome.action, 'failed');
  assert.strictEqual(outcome.error_code, 'attachment_owner');
  assert.strictEqual(wallPosts(client).length, 0);
});

test('HTTP-клиент n8n не кладёт ключ в URL', async () => {
  const seen = [];
  const helpers = {
    async httpRequest(options) {
      seen.push(options);
      if (String(options.url).includes('wall.post')) {
        return { response: { post_id: 3 } };
      }
      return { response: { upload_url: 'https://pu.vk.ru/c1/upload.php' } };
    }
  };
  const client = publisher.createN8nVkClient(helpers);
  await client.call('wall.post', publisher.buildWallPostParams({
    groupId: '123',
    message: 'Текст',
    attachment: 'photo-123_1',
    guid: 'kc-test-guid'
  }), { token: 'community-token-fixture', phase: 'publish' });
  assert.strictEqual(seen[0].url, 'https://api.vk.ru/method/wall.post');
  assert.strictEqual(seen[0].headers.Authorization, 'Bearer community-token-fixture');
  assert.doesNotMatch(seen[0].url, /community-token-fixture|access_token/);
  assert.doesNotMatch(seen[0].body, /access_token=/);
  assert.match(seen[0].body, /from_group=1/);
  assert.match(seen[0].body, /owner_id=-123/);
});

test('подготовленный тестовый пост: длина, JPEG и отсутствие публикации', () => {
  const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'test-post.json'), 'utf8'));
  const text = fixture.text.trim();
  assert.ok(text.length >= 500 && text.length <= 800, 'длина VK-текста ' + text.length);
  assert.match(text, /\?\s*$/);
  assert.strictEqual(fixture.published, false);
  assert.strictEqual(fixture.target_community.group_id, null);
  const imagePath = path.join(root, fixture.image.path);
  const bytes = fs.readFileSync(imagePath);
  assert.ok(publisher.sniffImage(bytes));
  assert.ok(bytes.length < 50 * 1024 * 1024);
});

test('Telegram-поток в локальном workflow сохранён и не активирован', () => {
  const workflow = JSON.parse(fs.readFileSync(path.join(root, 'n8n', 'workflows', 'knightcat-minimal-telegram.json'), 'utf8'));
  assert.strictEqual(workflow.active, false);
  assert.strictEqual(workflow.id, 'KnightCatMvpTg01');
  const names = workflow.nodes.map((node) => node.name);
  for (const name of ['Telegram Trigger', 'Publish to Telegram', 'Mark as Published', 'Confirm Publication', 'Reject Draft', 'Confirm Rejection', 'Publish to VK']) {
    assert.ok(names.includes(name), name);
  }
  const links = JSON.stringify(workflow.connections);
  assert.match(links, /Publish to Telegram/);
  assert.strictEqual(workflow.connections['Reject Draft'].main[0][0].node, 'Confirm Rejection');
  assert.notStrictEqual(workflow.connections['Reject Draft'].main[0][0].node, 'Publish to VK');
  assert.strictEqual(workflow.connections['Need Telegram Publish?'].main[0][0].node, 'Publish to Telegram');
  assert.strictEqual(workflow.connections['Publish to VK'].main[0][0].node, 'Confirm Publication');
  const raw = JSON.stringify(workflow);
  assert.doesNotMatch(raw, /vk1\.[A-Za-z0-9_-]{10,}/);
  assert.doesNotMatch(raw, /access_token\s*[:=]\s*['"][^'"]+['"]/);
  assert.strictEqual(workflow.connections['Route Event'].main[3][0].node, 'Resolve VK Status');
  assert.strictEqual(workflow.connections['Route Event'].main[4][0].node, 'Send Help or Access Error');
  assert.match(workflow.nodes.find((node) => node.name === 'Parse and Validate Package').parameters.jsCode, /post_id: null/);
  const publishNode = workflow.nodes.find((node) => node.name === 'Publish to VK');
  assert.match(publishNode.parameters.jsCode, /BEGIN vk-publisher\.cjs/);
  assert.match(publishNode.parameters.jsCode, /createN8nVkClient/);
  const embedded = publishNode.parameters.jsCode.split('/* BEGIN vk-publisher.cjs */')[1].split('/* END vk-publisher.cjs */')[0].trim();
  const source = fs.readFileSync(path.join(__dirname, 'vk-publisher.cjs'), 'utf8').replace(/\r\n/g, '\n').trim();
  assert.strictEqual(embedded, source);
});

test('узлы approve и reject сохраняют развилку Telegram', async () => {
  const store = { pending: {}, latestByChat: {} };
  const pkg = draft();
  store.pending[pkg.request_id] = pkg;
  store.latestByChat['10'] = pkg.request_id;
  const workflow = JSON.parse(fs.readFileSync(path.join(root, 'n8n', 'workflows', 'knightcat-minimal-telegram.json'), 'utf8'));
  const normalizeCode = workflow.nodes.find((node) => node.name === 'Normalize and Authorize').parameters.jsCode;
  const loadCode = workflow.nodes.find((node) => node.name === 'Load Pending Draft').parameters.jsCode;
  const rejectCode = workflow.nodes.find((node) => node.name === 'Reject Draft').parameters.jsCode;

  async function run(code, json, extra) {
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    const fn = new AsyncFunction('$json', '$vars', '$getWorkflowStaticData', '$', '$input', code);
    return fn.call(extra || {}, json, { KNIGHTCAT_ALLOWED_USER_IDS: '20' }, () => store, () => ({ first: () => ({ json }) }), { item: {} });
  }

  const idea = (await run(normalizeCode, { message: { chat: { id: 10 }, from: { id: 20 }, message_id: 1, text: 'Кот-рыцарь готовит пост для стены сообщества.' } }))[0];
  assert.strictEqual(idea.json.event_type, 'generate');
  const approved = (await run(normalizeCode, { message: { chat: { id: 10 }, from: { id: 20 }, message_id: 2, text: '/approve draft-1' } }))[0];
  assert.strictEqual(approved.json.event_type, 'approve');
  const rejected = (await run(normalizeCode, { message: { chat: { id: 10 }, from: { id: 20 }, message_id: 3, text: '/reject draft-1' } }))[0];
  assert.strictEqual(rejected.json.event_type, 'reject');
  const resolve = (await run(normalizeCode, { message: { chat: { id: 10 }, from: { id: 20 }, message_id: 4, text: '/vk-resolve draft-1 absent' } }))[0];
  assert.strictEqual(resolve.json.event_type, 'vk_resolve');
  assert.notStrictEqual(resolve.json.event_type, 'approve');

  const fresh = draft();
  store.pending[fresh.request_id] = fresh;
  const decision = (await run(loadCode, {
    target_request_id: fresh.request_id,
    reply_chat_id: '10',
    user_id: '20',
    config: { footer: '' }
  }))[0];
  assert.strictEqual(decision.json.approval_valid, true);
  assert.strictEqual(decision.json.publish_telegram, true);
  assert.match(decision.json.publish_text, /Текст Telegram/);

  const blocked = publisher.applyReject({
    pkg: fresh,
    chatId: '10',
    userId: '20',
    now: '2026-10-11T11:00:00.000Z'
  });
  assert.strictEqual(blocked.rejected, false);
  const rejectDecision = (await run(rejectCode, {
    target_request_id: 'draft-1',
    reply_chat_id: '10',
    user_id: '20'
  }))[0];
  assert.match(rejectDecision.json.user_message, /уже обработан|не опубликован/);
  assert.notStrictEqual(store.pending[fresh.request_id].publication.vk.status, 'published');
});
