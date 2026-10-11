'use strict';

const API_BASE = 'https://api.vk.ru/method/';
const API_VERSION = '5.131';
const LOCK_TTL_MS = 3 * 60 * 1000;
const MAX_IMAGE_BYTES = 50 * 1024 * 1024;

const AUTH_CODES = new Set([5, 7, 15, 27, 28, 214]);
const UPLOAD_CODES = new Set([22, 114, 118, 121]);

function emptyVkPublication() {
  return {
    status: 'not_started',
    post_id: null,
    owner_id: null,
    url: null,
    attachment: null,
    guid: null,
    content_sha256: null,
    locked_at: null,
    retryable: false,
    error_code: null,
    error_message: null,
    published_at: null
  };
}

function ensurePublication(pkg) {
  if (!pkg.publication) pkg.publication = {};
  if (!pkg.publication.telegram) {
    pkg.publication.telegram = {
      status: 'not_started',
      message_id: null,
      chat_id: null,
      locked_at: null
    };
  }
  if (!pkg.publication.vk) pkg.publication.vk = emptyVkPublication();
  return pkg;
}

function fnvHex(input) {
  const data = Buffer.isBuffer(input) ? input : Buffer.from(String(input), 'utf8');
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < data.length; i += 1) {
    h1 ^= data[i];
    h1 = Math.imul(h1, 0x01000193);
    h2 ^= data[i];
    h2 = Math.imul(h2, 0x01000193) ^ (h1 >>> 0);
  }
  return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
}

function makeGuid(requestId, contentSha) {
  return ('kc' + fnvHex(String(requestId) + '\n' + String(contentSha))).slice(0, 32);
}

function isFresh(lockedAt, now, ttlMs) {
  const start = Date.parse(lockedAt || '');
  const current = Date.parse(now);
  if (!Number.isFinite(start) || !Number.isFinite(current)) return false;
  return current - start >= 0 && current - start < (ttlMs || LOCK_TTL_MS);
}

function postUrl(groupId, postId) {
  return 'https://vk.com/wall-' + String(groupId).replace(/^-/, '') + '_' + postId;
}

function telegramText(pkg, footer) {
  const base = String(pkg.platforms?.telegram?.content || '');
  const foot = String(footer || '').trim();
  return foot ? base + '\n\n' + foot : base;
}

function redact(text, secrets) {
  let out = String(text || '');
  const list = Array.isArray(secrets) ? secrets : [];
  for (const secret of list) {
    const value = String(secret || '');
    if (value.length >= 8) out = out.split(value).join('[redacted]');
  }
  return out;
}

function vkError(code, message, phase, uncertain) {
  const error = new Error(message);
  error.code = code;
  error.phase = phase;
  error.uncertain = Boolean(uncertain);
  return error;
}

function humanize(code, fallback, phase) {
  const numeric = Number(code);
  const messages = {
    5: 'Ключ доступа ВКонтакте недействителен. Публикация остановлена, повтор сам не ушёл.',
    7: 'У ключа доступа недостаточно прав для этого действия.',
    15: 'ВКонтакте запретил действие. Проверьте права ключа и роль администратора сообщества.',
    27: 'Метод недоступен ключу сообщества. Фото на стену загружается пользовательским ключом с правом photos.',
    28: 'Сервисный ключ не может ни загрузить фото на стену, ни опубликовать запись.',
    214: 'ВКонтакте не разрешил запись на стене. Нужно право wall у ключа этого сообщества.',
    219: 'ВКонтакте отклонил запись как слишком частую. Новый пост не создан.',
    22: 'Сервер ВКонтакте не принял изображение.',
    114: 'Неверный альбом для фотографии стены.',
    118: 'Неверный сервер загрузки изображения.',
    121: 'Неверный хеш загруженного изображения.',
    image_missing: 'У одобренного черновика нет изображения. Запись на стену не создавалась.',
    text_missing: 'У одобренного черновика нет текста ВКонтакте. Запись на стену не создавалась.',
    config: fallback || 'Не заданы идентификатор сообщества или ключи доступа.',
    attachment: 'ВКонтакте не вернул корректное вложение фотографии. Запись на стену не создавалась.',
    attachment_owner: 'Фото сохранилось не от имени целевого сообщества. Запись на стену не создавалась.',
    upload_host: 'Адрес загрузки не принадлежит ВКонтакте. Файл не отправлялся.',
    timeout: 'ВКонтакте не ответил вовремя. Исход публикации неизвестен, повтор не выполнен.',
    network: phase === 'publish'
      ? 'Связь оборвалась после запроса публикации. Исход неизвестен, повтор не выполнен.'
      : 'Не удалось связаться с ВКонтакте во время загрузки изображения. Запись на стену не создавалась.'
  };
  if (messages[code]) return messages[code];
  if (messages[numeric]) return messages[numeric];
  return fallback || 'ВКонтакте вернул ошибку.';
}

function interpretVkBody(body, phase) {
  if (!body || !body.error) return null;
  const code = body.error.error_code;
  const uncertain = phase === 'publish' && (code === 1 || code === 10);
  return vkError(
    code,
    body.error.error_msg || humanize(code, 'Ошибка VK API', phase),
    phase,
    uncertain
  );
}

function classifyTransportError(error, phase) {
  const raw = String(error && (error.message || error.code) || error || '');
  const timedOut = /timeout|timed out|ETIMEDOUT|ESOCKETTIMEDOUT|aborted/i.test(raw);
  const code = timedOut ? 'timeout' : 'network';
  const uncertain = phase === 'publish';
  return vkError(code, humanize(code, raw, phase), phase, uncertain);
}

function classifyTokenMaterial(token) {
  const value = String(token || '').trim();
  if (!value) return { present: false, type: 'missing' };
  if (/^vk[12]\./i.test(value)) return { present: true, type: 'vk_id' };
  return { present: true, type: 'opaque' };
}

function assertUploadHost(uploadUrl) {
  let parsed;
  try {
    parsed = new URL(String(uploadUrl));
  } catch (error) {
    throw vkError('upload_host', humanize('upload_host'), 'upload', false);
  }
  const host = parsed.hostname.toLowerCase();
  const allowed = host === 'vk.ru' || host === 'vk.com'
    || host.endsWith('.vk.ru') || host.endsWith('.vk.com')
    || host.endsWith('.userapi.com');
  if (parsed.protocol !== 'https:' || !allowed) {
    throw vkError('upload_host', humanize('upload_host'), 'upload', false);
  }
}

function sniffImage(bytes) {
  const data = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || []);
  if (data.length < 8) return null;
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return { mime: 'image/jpeg', filename: 'photo.jpg' };
  }
  if (data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) {
    return { mime: 'image/png', filename: 'photo.png' };
  }
  const head = data.slice(0, 6).toString('ascii');
  if (head === 'GIF87a' || head === 'GIF89a') {
    return { mime: 'image/gif', filename: 'photo.gif' };
  }
  return null;
}

function attachmentFromPhoto(photo, groupId) {
  if (!photo || photo.id == null || photo.owner_id == null) {
    throw vkError('attachment', humanize('attachment'), 'upload', false);
  }
  const ownerId = Number(photo.owner_id);
  const expected = -Math.abs(Number(groupId));
  if (!Number.isFinite(ownerId) || ownerId !== expected) {
    throw vkError('attachment_owner', humanize('attachment_owner'), 'upload', false);
  }
  return 'photo' + ownerId + '_' + photo.id;
}

function buildWallPostParams({ groupId, message, attachment, guid }) {
  return {
    owner_id: -Math.abs(Number(groupId)),
    from_group: 1,
    signed: 0,
    message: String(message),
    attachments: attachment,
    guid: String(guid)
  };
}

function normalizeGroupId(groupId) {
  const value = String(groupId || '').trim().replace(/^-/, '');
  if (!/^[1-9]\d*$/.test(value)) return null;
  return value;
}

function extractPosts(response) {
  if (Array.isArray(response)) return response;
  if (response && Array.isArray(response.items)) return response.items;
  if (response && Array.isArray(response.posts)) return response.posts;
  return [];
}

function markPublished(pkg, groupId, postId, now) {
  const vk = pkg.publication.vk;
  vk.status = 'published';
  vk.post_id = Number(postId);
  vk.owner_id = -Math.abs(Number(groupId));
  vk.url = postUrl(groupId, vk.post_id);
  vk.published_at = now;
  vk.retryable = false;
  vk.error_code = null;
  vk.error_message = null;
  vk.locked_at = null;
  pkg.status = 'published';
  return resultOf(pkg, 'published');
}

function resultOf(pkg, action) {
  const vk = pkg.publication.vk || emptyVkPublication();
  return {
    action,
    status: vk.status,
    post_id: vk.post_id,
    url: vk.url,
    attachment: vk.attachment,
    error_code: vk.error_code,
    error_message: vk.error_message,
    retryable: vk.retryable
  };
}

function applyFailure(pkg, error, secrets) {
  const vk = pkg.publication.vk;
  const phase = error.phase || (vk.status === 'publishing' ? 'publish' : 'upload');
  const uncertain = Boolean(error.uncertain) || (vk.status === 'publishing' && (error.code === 'timeout' || error.code === 'network' || error.code === 1 || error.code === 10));
  const message = redact(humanize(error.code, error.message, phase), secrets);
  if (uncertain) {
    vk.status = 'uncertain';
    vk.retryable = false;
    vk.error_code = String(error.code || 'uncertain');
    vk.error_message = message;
    vk.locked_at = null;
    return resultOf(pkg, 'uncertain');
  }
  vk.status = 'failed';
  vk.retryable = true;
  vk.error_code = String(error.code || 'failed');
  vk.error_message = message;
  vk.locked_at = null;
  if (pkg.publication.telegram.status === 'published' && pkg.status === 'publishing') {
    pkg.status = 'publishing';
  }
  return resultOf(pkg, 'failed');
}

async function findMatchingPost(client, credentials, text) {
  const response = await client.call('wall.get', {
    owner_id: -Math.abs(Number(credentials.groupId)),
    count: 20,
    filter: 'owner'
  }, { token: credentials.communityToken, phase: 'reconcile' });
  const posts = extractPosts(response);
  const wanted = String(text || '').trim();
  return posts.filter((post) => String(post.text || post.message || '').trim() === wanted);
}

async function confirmPostId(client, credentials, postId) {
  const groupId = normalizeGroupId(credentials.groupId);
  const response = await client.call('wall.getById', {
    posts: '-' + groupId + '_' + postId
  }, { token: credentials.communityToken, phase: 'reconcile' });
  const posts = extractPosts(response);
  return posts.find((post) => Number(post.id) === Number(postId)) || null;
}

function prepareApproval({ pkg, chatId, userId, now, footer }) {
  ensurePublication(pkg);
  if (String(pkg.source?.chat_id) !== String(chatId)) {
    return { ok: false, message: 'Этот черновик создан в другом чате.' };
  }
  if (pkg.status === 'rejected' || pkg.approval?.decision === 'rejected') {
    return { ok: false, message: 'Черновик отклонён и не будет опубликован.' };
  }

  const vk = pkg.publication.vk;
  const tg = pkg.publication.telegram;
  const stamp = now || new Date().toISOString();

  if (vk.status === 'published' && vk.post_id) {
    return {
      ok: false,
      message: 'Черновик уже опубликован во ВКонтакте.\n' + vk.url
    };
  }

  if ((vk.status === 'uploading' || vk.status === 'publishing') && isFresh(vk.locked_at, stamp)) {
    return { ok: false, message: 'Публикация во ВКонтакте уже выполняется. Второй пост не создан.' };
  }

  if (vk.status === 'uploading' || vk.status === 'publishing') {
    vk.status = 'uncertain';
    vk.retryable = false;
    vk.error_code = 'stale_lock';
    vk.error_message = 'Предыдущий запрос публикации не завершился. Новый пост не отправлен.';
    vk.locked_at = null;
  }

  if (vk.status === 'uncertain') {
    return {
      ok: true,
      publishTelegram: false,
      mode: 'reconcile_only',
      publishChatId: tg.chat_id,
      publishText: telegramText(pkg, footer)
    };
  }

  if (tg.status === 'publishing' && isFresh(tg.locked_at, stamp)) {
    return { ok: false, message: 'Публикация в Telegram уже выполняется. Повтор не создан.' };
  }

  const publishTelegram = tg.status !== 'published';
  if (publishTelegram) {
    tg.status = 'publishing';
    tg.locked_at = stamp;
  }

  if (pkg.status === 'review_required' || !pkg.approval || pkg.approval.decision === 'pending') {
    pkg.status = 'publishing';
    pkg.approval = {
      decision: 'approved',
      decided_by: String(userId || ''),
      decided_at: stamp
    };
  }

  return {
    ok: true,
    publishTelegram,
    mode: 'publish',
    publishChatId: tg.chat_id,
    publishText: telegramText(pkg, footer)
  };
}

function applyReject({ pkg, chatId, userId, now }) {
  if (!pkg) {
    return { rejected: false, message: 'Черновик не найден. Укажите ID: /reject ID' };
  }
  ensurePublication(pkg);
  if (String(pkg.source?.chat_id) !== String(chatId)) {
    return { rejected: false, message: 'Этот черновик создан в другом чате.' };
  }
  if (pkg.status !== 'review_required' || pkg.approval?.decision !== 'pending') {
    return {
      rejected: false,
      message: 'Черновик ' + (pkg.request_id || '') + ' уже обработан. Статус: ' + pkg.status
    };
  }
  pkg.status = 'rejected';
  pkg.approval = {
    decision: 'rejected',
    decided_by: String(userId || ''),
    decided_at: now || new Date().toISOString()
  };
  return {
    rejected: true,
    publish: false,
    message: 'Черновик ' + pkg.request_id + ' отклонён и не опубликован.'
  };
}

async function loadDraftImage(pkg, loadImage) {
  const loader = loadImage || defaultLoadImage;
  const image = await loader(pkg);
  if (!image || !image.bytes || !image.bytes.length) {
    throw vkError('image_missing', humanize('image_missing'), 'upload', false);
  }
  const bytes = Buffer.isBuffer(image.bytes) ? image.bytes : Buffer.from(image.bytes);
  if (bytes.length > MAX_IMAGE_BYTES) {
    throw vkError('image_missing', 'Изображение больше 50 МБ. Запись на стену не создавалась.', 'upload', false);
  }
  const sniffed = sniffImage(bytes);
  if (!sniffed) {
    throw vkError('image_missing', 'Файл изображения не JPG, PNG или GIF. Запись на стену не создавалась.', 'upload', false);
  }
  return {
    bytes,
    mime: sniffed.mime,
    filename: image.filename || sniffed.filename
  };
}

async function defaultLoadImage(pkg) {
  const image = pkg.visual && pkg.visual.image;
  if (!image) throw vkError('image_missing', humanize('image_missing'), 'upload', false);
  if (image.base64) {
    return {
      bytes: Buffer.from(String(image.base64), 'base64'),
      filename: image.filename
    };
  }
  if (image.bytes) return image;
  if (image.path) {
    const fs = require('fs');
    return {
      bytes: fs.readFileSync(image.path),
      filename: image.filename || 'photo.jpg'
    };
  }
  throw vkError('image_missing', humanize('image_missing'), 'upload', false);
}

function readCredentials(credentials) {
  const groupId = normalizeGroupId(credentials && credentials.groupId);
  const communityToken = String(credentials && credentials.communityToken || '').trim();
  const userToken = String(credentials && credentials.userToken || '').trim();
  if (!groupId) {
    throw vkError('config', 'Не задан числовой идентификатор сообщества KNIGHTCAT_VK_GROUP_ID.', 'config', false);
  }
  if (!communityToken) {
    throw vkError('config', 'Не задан ключ доступа сообщества. Он нужен, чтобы опубликовать запись от имени сообщества.', 'config', false);
  }
  if (!userToken) {
    throw vkError('config', 'Не задан пользовательский ключ с правом photos. Ключ сообщества не загружает фото на стену.', 'config', false);
  }
  return { groupId, communityToken, userToken };
}

async function reconcilePublication({ pkg, credentials, client, now }) {
  ensurePublication(pkg);
  const vk = pkg.publication.vk;
  const secrets = [credentials && credentials.communityToken, credentials && credentials.userToken];
  const stamp = now || new Date().toISOString();
  if (vk.status === 'published' && vk.post_id) return resultOf(pkg, 'already_published');
  if (pkg.status === 'rejected' || pkg.approval?.decision === 'rejected') {
    return resultOf(pkg, 'rejected');
  }
  try {
    const creds = readCredentials(credentials);
    if (vk.post_id) {
      const confirmed = await confirmPostId(client, creds, vk.post_id);
      if (confirmed) return markPublished(pkg, creds.groupId, vk.post_id, stamp);
    }
    const matches = await findMatchingPost(client, creds, pkg.platforms?.vk?.content);
    if (matches.length === 1 && matches[0].id != null) {
      return markPublished(pkg, creds.groupId, matches[0].id, stamp);
    }
    if (matches.length > 1) {
      vk.status = 'uncertain';
      vk.retryable = false;
      vk.error_code = 'ambiguous';
      vk.error_message = 'На стене несколько записей с тем же текстом. Укажите post_id командой /vk-resolve.';
      return Object.assign(resultOf(pkg, 'uncertain'), { search_completed: true, match_count: matches.length });
    }
    vk.status = 'uncertain';
    vk.retryable = false;
    vk.error_code = 'not_found';
    vk.error_message = 'Сверка не нашла запись. Новый пост не создан. Если на стене пусто, отправьте /vk-resolve ' + pkg.request_id + ' absent.';
    return Object.assign(resultOf(pkg, 'uncertain'), { search_completed: true, match_count: 0 });
  } catch (error) {
    if (vk.status === 'uncertain' || vk.status === 'publishing' || vk.status === 'uploading') {
      vk.status = 'uncertain';
      vk.retryable = false;
      vk.error_code = String(error.code || 'reconcile_failed');
      vk.error_message = 'Сверка не выполнена. Новый пост не создан.';
      vk.locked_at = null;
      return Object.assign(resultOf(pkg, 'uncertain'), { search_completed: false, match_count: null });
    }
    return applyFailure(pkg, error.phase ? error : classifyTransportError(error, 'reconcile'), secrets);
  }
}

async function publishApprovedDraft({ pkg, credentials, client, now, loadImage, mode }) {
  ensurePublication(pkg);
  const vk = pkg.publication.vk;
  const secrets = [credentials && credentials.communityToken, credentials && credentials.userToken];
  const stamp = now || new Date().toISOString();

  if (pkg.status === 'rejected' || pkg.approval?.decision === 'rejected') {
    return resultOf(pkg, 'rejected');
  }
  if (vk.status === 'published' && vk.post_id) return resultOf(pkg, 'already_published');
  if ((vk.status === 'uploading' || vk.status === 'publishing') && isFresh(vk.locked_at, stamp)) {
    return resultOf(pkg, 'in_progress');
  }
  if (vk.status === 'uncertain' || mode === 'reconcile_only') {
    return reconcilePublication({ pkg, credentials, client, now: stamp });
  }
  if ((vk.status === 'uploading' || vk.status === 'publishing') && !isFresh(vk.locked_at, stamp)) {
    vk.status = 'uncertain';
    vk.retryable = false;
    vk.error_code = 'stale_lock';
    vk.error_message = humanize('timeout');
    return reconcilePublication({ pkg, credentials, client, now: stamp });
  }

  vk.status = 'uploading';
  vk.locked_at = stamp;
  vk.error_code = null;
  vk.error_message = null;

  try {
    const text = String(pkg.platforms?.vk?.content || '').trim();
    if (!text) throw vkError('text_missing', humanize('text_missing'), 'upload', false);
    const image = await loadDraftImage(pkg, loadImage);
    const creds = readCredentials(credentials);
    const contentSha = fnvHex(text + '\n' + fnvHex(image.bytes));
    vk.content_sha256 = contentSha;
    vk.guid = vk.guid || makeGuid(pkg.request_id, contentSha);

    const server = await client.call('photos.getWallUploadServer', {
      group_id: creds.groupId
    }, { token: creds.userToken, phase: 'upload' });
    if (!server || !server.upload_url) {
      throw vkError('upload_host', 'ВКонтакте не вернул адрес загрузки изображения.', 'upload', false);
    }
    assertUploadHost(server.upload_url);
    const uploaded = await client.upload(server.upload_url, image, { phase: 'upload' });
    if (!uploaded || uploaded.error || uploaded.server == null || !uploaded.photo || !uploaded.hash) {
      throw vkError('22', humanize(22), 'upload', false);
    }
    const saved = await client.call('photos.saveWallPhoto', {
      group_id: creds.groupId,
      server: uploaded.server,
      photo: uploaded.photo,
      hash: uploaded.hash
    }, { token: creds.userToken, phase: 'upload' });
    const photo = Array.isArray(saved) ? saved[0] : saved;
    vk.attachment = attachmentFromPhoto(photo, creds.groupId);

    vk.status = 'publishing';
    vk.locked_at = new Date(Date.parse(stamp) + 1).toISOString();
    const params = buildWallPostParams({
      groupId: creds.groupId,
      message: text,
      attachment: vk.attachment,
      guid: vk.guid
    });
    let posted;
    try {
      posted = await client.call('wall.post', params, { token: creds.communityToken, phase: 'publish' });
    } catch (error) {
      const interpreted = error.phase ? error : classifyTransportError(error, 'publish');
      if (interpreted.uncertain) {
        vk.status = 'uncertain';
        vk.retryable = false;
        vk.error_code = String(interpreted.code);
        vk.error_message = redact(humanize(interpreted.code, interpreted.message, 'publish'), secrets);
        vk.locked_at = null;
        try {
          const matches = await findMatchingPost(client, creds, text);
          if (matches.length === 1 && matches[0].id != null) {
            return markPublished(pkg, creds.groupId, matches[0].id, stamp);
          }
          if (matches.length > 1) {
            vk.error_code = 'ambiguous';
            vk.error_message = 'На стене несколько записей с тем же текстом. Укажите post_id командой /vk-resolve.';
          }
        } catch (reconcileError) {
          vk.error_message = redact(humanize(interpreted.code, interpreted.message, 'publish'), secrets);
        }
        return resultOf(pkg, 'uncertain');
      }
      try {
        const matches = await findMatchingPost(client, creds, text);
        if (matches.length === 1 && matches[0].id != null) {
          return markPublished(pkg, creds.groupId, matches[0].id, stamp);
        }
      } catch (reconcileError) {
        // Сверка не удалась. Ниже сохранится исходная ошибка публикации, без нового wall.post.
      }
      throw interpreted;
    }
    if (!posted || posted.post_id == null) {
      throw vkError('publish_response', 'ВКонтакте не вернул post_id.', 'publish', true);
    }
    return markPublished(pkg, creds.groupId, posted.post_id, stamp);
  } catch (error) {
    const interpreted = error && error.phase ? error : classifyTransportError(error, vk.status === 'publishing' ? 'publish' : 'upload');
    return applyFailure(pkg, interpreted, secrets);
  }
}

async function resolveUncertain({ pkg, argument, credentials, client, now }) {
  ensurePublication(pkg);
  const vk = pkg.publication.vk;
  const stamp = now || new Date().toISOString();
  if (pkg.status === 'rejected' || pkg.approval?.decision === 'rejected') {
    return resultOf(pkg, 'rejected');
  }
  if (vk.status === 'published' && vk.post_id) return resultOf(pkg, 'already_published');
  if (vk.status !== 'uncertain') {
    vk.error_message = 'Сверка доступна только когда исход публикации неизвестен. Сейчас статус: ' + vk.status;
    return resultOf(pkg, vk.status === 'published' ? 'already_published' : 'failed');
  }
  const decision = String(argument || '').trim().toLowerCase();
  if (decision === 'absent') {
    const looked = await reconcilePublication({ pkg, credentials, client, now: stamp });
    if (looked.action === 'published' || looked.action === 'already_published') return looked;
    if (looked.error_code === 'ambiguous' || looked.search_completed !== true || looked.match_count !== 0) {
      vk.status = 'uncertain';
      vk.retryable = false;
      if (!vk.error_message) {
        vk.error_message = 'Нельзя разрешить повтор, пока сверка не подтвердила отсутствие записи.';
      }
      return resultOf(pkg, 'uncertain');
    }
    vk.status = 'failed';
    vk.retryable = true;
    vk.error_code = 'confirmed_absent';
    vk.error_message = 'Запись на стене не найдена. Следующий /approve может опубликовать её один раз.';
    return resultOf(pkg, 'failed');
  }
  if (/^[1-9]\d*$/.test(decision)) {
    try {
      const creds = readCredentials(credentials);
      const confirmed = await confirmPostId(client, creds, decision);
      if (!confirmed) {
        vk.status = 'uncertain';
        vk.error_code = 'not_found';
        vk.error_message = 'Запись ' + decision + ' на стене сообщества не найдена. Статус остаётся неопределённым.';
        return resultOf(pkg, 'uncertain');
      }
      return markPublished(pkg, creds.groupId, decision, stamp);
    } catch (error) {
      return applyFailure(pkg, error.phase ? error : classifyTransportError(error, 'reconcile'), [credentials.communityToken, credentials.userToken]);
    }
  }
  return reconcilePublication({ pkg, credentials, client, now: stamp });
}

function permissionNames(payload) {
  const list = payload && (payload.permissions || payload.settings) || [];
  if (!Array.isArray(list)) return [];
  return list.map((item) => typeof item === 'string' ? item : item && item.name).filter(Boolean);
}

async function probeAccess({ client, communityToken, userToken }) {
  const report = {
    community: classifyTokenMaterial(communityToken),
    user: classifyTokenMaterial(userToken)
  };
  if (communityToken) {
    try {
      const payload = await client.call('groups.getTokenPermissions', {}, {
        token: communityToken,
        phase: 'probe'
      });
      const names = permissionNames(payload);
      report.community = {
        present: true,
        type: 'community',
        permissions: names,
        hasWall: names.includes('wall'),
        hasPhotos: names.includes('photos')
      };
    } catch (error) {
      report.community = {
        present: true,
        type: error.code === 5 ? 'invalid' : (error.code === 28 ? 'service' : 'unknown'),
        error_code: error.code || null,
        message: humanize(error.code, 'Ключ сообщества не подтвердился.', 'probe')
      };
    }
  }
  if (userToken) {
    try {
      const maskPayload = await client.call('account.getAppPermissions', {}, {
        token: userToken,
        phase: 'probe'
      });
      const mask = typeof maskPayload === 'number' ? maskPayload : Number(maskPayload && maskPayload.mask);
      report.user = {
        present: true,
        type: 'user',
        hasPhotos: (mask & 4) === 4,
        hasWall: (mask & 8192) === 8192
      };
    } catch (error) {
      let type = 'unknown';
      if (error.code === 27) type = 'community_not_user';
      else if (error.code === 28) type = 'service';
      else if (error.code === 5) type = 'invalid';
      report.user = {
        present: true,
        type,
        error_code: error.code || null,
        message: humanize(error.code, 'Пользовательский ключ не подтвердился.', 'probe')
      };
    }
  }
  return report;
}

function createN8nVkClient(helpers) {
  if (!helpers || typeof helpers.httpRequest !== 'function') {
    throw vkError('config', 'В узле n8n нет HTTP-клиента.', 'config', false);
  }
  return {
    async call(method, params, options) {
      const phase = options && options.phase || 'call';
      const token = options && options.token;
      const form = new URLSearchParams();
      form.set('v', API_VERSION);
      const source = params || {};
      for (const key of Object.keys(source)) {
        if (source[key] !== undefined && source[key] !== null && key !== 'access_token') {
          form.set(key, String(source[key]));
        }
      }
      let body;
      try {
        body = await helpers.httpRequest({
          method: 'POST',
          url: API_BASE + method,
          headers: {
            Authorization: 'Bearer ' + token,
            'Content-Type': 'application/x-www-form-urlencoded'
          },
          body: form.toString(),
          json: true,
          timeout: 20000
        });
      } catch (error) {
        throw classifyTransportError(error, phase);
      }
      const interpreted = interpretVkBody(body, phase);
      if (interpreted) throw interpreted;
      return body && Object.prototype.hasOwnProperty.call(body, 'response') ? body.response : body;
    },
    async upload(uploadUrl, image, options) {
      const phase = options && options.phase || 'upload';
      assertUploadHost(uploadUrl);
      let body;
      try {
        body = await helpers.httpRequest({
          method: 'POST',
          url: uploadUrl,
          formData: {
            photo: {
              value: image.bytes,
              options: {
                filename: image.filename || 'photo.jpg',
                contentType: image.mime || 'image/jpeg'
              }
            }
          },
          json: true,
          timeout: 30000
        });
      } catch (error) {
        throw classifyTransportError(error, phase);
      }
      if (body && body.error) {
        throw vkError(body.error.error_code || 22, body.error.error_msg || humanize(22), phase, false);
      }
      return body;
    }
  };
}

function createHttpClient({ fetchImpl, apiBase, version } = {}) {
  const fetchFn = fetchImpl || globalThis.fetch;
  const base = apiBase || API_BASE;
  const apiVersion = version || API_VERSION;

  async function call(method, params, options) {
    const phase = options && options.phase || 'call';
    const token = options && options.token;
    const form = new URLSearchParams();
    form.set('v', apiVersion);
    const source = params || {};
    for (const key of Object.keys(source)) {
      if (source[key] !== undefined && source[key] !== null && key !== 'access_token') {
        form.set(key, String(source[key]));
      }
    }
    const url = base.replace(/\/$/, '') + '/' + method;
    let response;
    try {
      response = await fetchFn(url, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + token,
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: form.toString()
      });
    } catch (error) {
      throw classifyTransportError(error, phase);
    }
    if (!response.ok && response.status !== 200) {
      throw classifyTransportError(new Error('HTTP ' + response.status), phase);
    }
    const body = await response.json();
    const interpreted = interpretVkBody(body, phase);
    if (interpreted) throw interpreted;
    return body.response;
  }

  async function upload(uploadUrl, image, options) {
    const phase = options && options.phase || 'upload';
    assertUploadHost(uploadUrl);
    const form = new FormData();
    const blob = new Blob([image.bytes], { type: image.mime || 'image/jpeg' });
    form.append('photo', blob, image.filename || 'photo.jpg');
    let response;
    try {
      response = await fetchFn(uploadUrl, { method: 'POST', body: form });
    } catch (error) {
      throw classifyTransportError(error, phase);
    }
    const body = await response.json();
    if (body && body.error) {
      throw vkError(body.error.error_code || 22, body.error.error_msg || humanize(22), phase, false);
    }
    return body;
  }

  return { call, upload };
}

function formatPublicationMessage(pkg, telegramMessageId) {
  ensurePublication(pkg);
  const lines = [];
  const tg = pkg.publication.telegram;
  const vk = pkg.publication.vk;
  if (tg.status === 'published') {
    lines.push('Telegram опубликован. Message ID: ' + (telegramMessageId || tg.message_id || 'не возвращён API'));
  }
  if (vk.status === 'published') {
    lines.push('ВКонтакте опубликовано от имени сообщества.');
    lines.push(vk.url);
  } else if (vk.status === 'uncertain') {
    lines.push('ВКонтакте: исход неизвестен. Новый пост не создан.');
    lines.push(vk.error_message || 'Нужна сверка.');
    lines.push('/vk-resolve ' + pkg.request_id);
    lines.push('/vk-resolve ' + pkg.request_id + ' absent');
  } else if (vk.status === 'failed') {
    lines.push('ВКонтакте не опубликовано. ' + (vk.error_message || 'Ошибка без подробностей.'));
  } else if (vk.status === 'in_progress' || vk.status === 'uploading' || vk.status === 'publishing') {
    lines.push('ВКонтакте: публикация уже выполняется. Второй пост не создан.');
  }
  return lines.join('\n');
}

module.exports = {
  API_BASE,
  API_VERSION,
  LOCK_TTL_MS,
  AUTH_CODES,
  UPLOAD_CODES,
  emptyVkPublication,
  ensurePublication,
  makeGuid,
  attachmentFromPhoto,
  buildWallPostParams,
  prepareApproval,
  applyReject,
  publishApprovedDraft,
  reconcilePublication,
  resolveUncertain,
  probeAccess,
  createHttpClient,
  createN8nVkClient,
  interpretVkBody,
  classifyTokenMaterial,
  classifyTransportError,
  formatPublicationMessage,
  sniffImage,
  normalizeGroupId,
  humanize
};
