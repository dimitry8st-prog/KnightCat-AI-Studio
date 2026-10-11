'use strict';

const API_BASE = 'https://api.vk.ru/method/';
const API_VERSION = '5.131';
const LOCK_TTL_MS = 3 * 60 * 1000;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const RECENT_SCAN_LIMIT = 20;

const LIMITS = {
  vk: { min: 500, max: 800 },
  x: { min: 1, max: 280 },
  telegram: { min: 1, max: 4096 },
  instagram: { min: 1, max: 2200 },
  tiktok: { min: 1, max: 2200 }
};

const IN_FLIGHT = new Set(['locked', 'uploading', 'publishing']);
const KNOWN_REJECT_CODES = new Set([5, 7, 15, 22, 27, 28, 114, 118, 121, 214, 219]);

function emptyVkPublication() {
  return {
    status: 'not_started',
    post_id: null,
    owner_id: null,
    url: null,
    attachment: null,
    guid: null,
    content_fingerprint: null,
    locked_at: null,
    lock_token: null,
    lock_seq: 0,
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
  if (!pkg.visual) pkg.visual = { prompt: '', image: null };
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
  const base = String(pkg.platforms && pkg.platforms.telegram && pkg.platforms.telegram.content || '');
  const foot = String(footer || '').trim();
  return foot ? base + '\n\n' + foot : base;
}

function humanize(code) {
  const numeric = Number(code);
  const messages = {
    5: 'Ключ доступа ВКонтакте недействителен. Запись на стену не создана.',
    7: 'У ключа доступа недостаточно прав.',
    15: 'ВКонтакте запретил действие для этого ключа.',
    27: 'Метод недоступен ключу сообщества. Фото загружает пользовательский ключ с правом photos.',
    28: 'Сервисный ключ не может загрузить фото или опубликовать запись.',
    214: 'ВКонтакте не разрешил запись на стене. Нужно право wall у ключа этого сообщества.',
    219: 'ВКонтакте отклонил запись как слишком частую. Новый пост не создан.',
    22: 'Сервер ВКонтакте не принял изображение.',
    114: 'Неверный альбом для фотографии стены.',
    118: 'Неверный сервер загрузки изображения.',
    121: 'Неверный хеш загруженного изображения.',
    image_missing: 'В черновике нет изображения. Отправьте идею вместе с фотографией. Запись на стену не создавалась.',
    text_missing: 'В черновике нет текста ВКонтакте допустимой длины. Запись на стену не создавалась.',
    config: 'Не задан числовой идентификатор сообщества KNIGHTCAT_VK_GROUP_ID.',
    attachment: 'ВКонтакте не вернул вложение фотографии. Запись на стену не создавалась.',
    attachment_owner: 'Фото сохранилось не на стене целевого сообщества. Запись не создавалась.',
    upload_host: 'Адрес загрузки не принадлежит ВКонтакте. Файл не отправлялся.',
    lock_lost: 'Блокировка публикации принадлежит другому запросу. Этот запрос остановлен.',
    timeout: 'ВКонтакте не ответил на публикацию. Исход неизвестен, новый пост не создан.',
    scan_inconclusive: 'В последних 20 записях совпадения нет. Это не доказывает, что пост отсутствует. Новый пост не создан.'
  };
  if (messages[code]) return messages[code];
  if (messages[numeric]) return messages[numeric];
  return 'ВКонтакте вернул ошибку. Запись на стену не создана.';
}

function resultOf(pkg, action) {
  const vk = (pkg.publication && pkg.publication.vk) || emptyVkPublication();
  return {
    action,
    ready: action === 'publish' || action === 'reconcile',
    status: vk.status,
    post_id: vk.post_id,
    url: vk.url,
    attachment: vk.attachment,
    error_code: vk.error_code,
    error_message: vk.error_message,
    retryable: vk.retryable,
    lock_token: vk.lock_token
  };
}

function normalizeGroupId(groupId) {
  const value = String(groupId || '').trim().replace(/^-/, '');
  if (!/^[1-9]\d*$/.test(value)) return null;
  return value;
}

function buildFormBody(fields) {
  const form = new URLSearchParams();
  form.set('v', API_VERSION);
  const source = fields || {};
  for (const key of Object.keys(source)) {
    if (key === 'access_token' || key === 'v') continue;
    if (source[key] !== undefined && source[key] !== null) form.set(key, String(source[key]));
  }
  return form.toString();
}

function buildWallPostParams(groupId, message, attachment, guid) {
  return {
    owner_id: -Math.abs(Number(groupId)),
    from_group: 1,
    signed: 0,
    message: String(message),
    attachments: attachment,
    guid: String(guid)
  };
}

function vkApiRequest(method, fields) {
  return {
    url: API_BASE + method,
    body: buildFormBody(fields)
  };
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

function readImageSize(bytes) {
  const data = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || []);
  const kind = sniffImage(data);
  if (!kind) return null;
  if (kind.mime === 'image/png') {
    if (data.length < 24) return null;
    return { width: data.readUInt32BE(16), height: data.readUInt32BE(20), mime: kind.mime, filename: kind.filename };
  }
  if (kind.mime === 'image/gif') {
    if (data.length < 10) return null;
    return { width: data.readUInt16LE(6), height: data.readUInt16LE(8), mime: kind.mime, filename: kind.filename };
  }
  let offset = 2;
  while (offset + 9 < data.length) {
    if (data[offset] !== 0xff) return null;
    const marker = data[offset + 1];
    if (marker === 0xd8 || marker === 0xd9) {
      offset += 2;
      continue;
    }
    if (offset + 4 > data.length) return null;
    const length = data.readUInt16BE(offset + 2);
    if (length < 2 || offset + 2 + length > data.length) return null;
    const isSof = (marker >= 0xc0 && marker <= 0xc3)
      || (marker >= 0xc5 && marker <= 0xc7)
      || (marker >= 0xc9 && marker <= 0xcb)
      || (marker >= 0xcd && marker <= 0xcf);
    if (isSof) {
      return {
        width: data.readUInt16BE(offset + 7),
        height: data.readUInt16BE(offset + 5),
        mime: kind.mime,
        filename: kind.filename
      };
    }
    offset += 2 + length;
  }
  return null;
}

function imageLimitError(bytes) {
  if (!bytes || !bytes.length) return 'Изображение пустое.';
  if (bytes.length > MAX_IMAGE_BYTES) return 'Изображение больше 20 МБ. Черновик с таким файлом не сохраняется.';
  const size = readImageSize(bytes);
  if (!size || !size.width || !size.height) return 'Не удалось прочитать размер JPG, PNG или GIF.';
  if (size.width + size.height > 14000) return 'Сумма сторон изображения больше 14 000 пикселей.';
  const ratio = Math.max(size.width, size.height) / Math.min(size.width, size.height);
  if (ratio > 20) return 'Соотношение сторон хуже 1:20. ВКонтакте такое фото на стену не принимает.';
  return null;
}

function inspectImage(bytes, filename) {
  const data = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || []);
  const problem = imageLimitError(data);
  if (problem) return { ok: false, errors: [problem] };
  const size = readImageSize(data);
  return {
    ok: true,
    errors: [],
    image: {
      filename: filename || size.filename,
      mime: size.mime,
      base64: data.toString('base64'),
      byte_length: data.length,
      width: size.width,
      height: size.height,
      fingerprint: fnvHex(data)
    },
    bytes: data
  };
}

function attachDraftImage(pkg, bytes, filename) {
  ensurePublication(pkg);
  const inspected = inspectImage(bytes, filename);
  if (!inspected.ok) {
    pkg.visual.image = null;
    return inspected;
  }
  pkg.visual.image = inspected.image;
  return inspected;
}

function readDraftImage(pkg) {
  const image = pkg && pkg.visual && pkg.visual.image;
  if (!image || !image.base64) return null;
  const bytes = Buffer.from(String(image.base64), 'base64');
  const inspected = inspectImage(bytes, image.filename);
  if (!inspected.ok) return null;
  return inspected;
}

function validateModelPackage(data) {
  const errors = [];
  if (!data || typeof data !== 'object') {
    return { ok: false, errors: ['Ответ модели не является объектом JSON.'], lengths: {} };
  }
  if (!data.analysis || typeof data.analysis !== 'object' || Array.isArray(data.analysis)) {
    errors.push('В пакете нет объекта analysis.');
  }
  if (!data.image_prompt || typeof data.image_prompt !== 'string' || !data.image_prompt.trim()) {
    errors.push('В пакете нет image_prompt.');
  }
  const lengths = {};
  for (const name of Object.keys(LIMITS)) {
    const content = data.platforms && data.platforms[name] && data.platforms[name].content;
    if (typeof content !== 'string' || !content.trim()) {
      errors.push('В пакете нет текста платформы ' + name + '.');
      lengths[name] = 0;
      continue;
    }
    lengths[name] = content.length;
    const rule = LIMITS[name];
    if (content.length < rule.min || content.length > rule.max) {
      errors.push('Текст ' + name + ' имеет длину ' + content.length + '. Допустимо ' + rule.min + '–' + rule.max + ' символов.');
    }
  }
  return { ok: errors.length === 0, errors, lengths };
}

function validatePublishableVk(pkg, groupId) {
  ensurePublication(pkg);
  const errors = [];
  const text = String(pkg.platforms && pkg.platforms.vk && pkg.platforms.vk.content || '').trim();
  if (text.length < LIMITS.vk.min || text.length > LIMITS.vk.max) {
    errors.push(humanize('text_missing') + ' Сейчас ' + text.length + ' символов.');
  }
  const image = readDraftImage(pkg);
  if (!image) errors.push(humanize('image_missing'));
  if (!normalizeGroupId(groupId)) errors.push(humanize('config'));
  return { ok: errors.length === 0, errors, text, image };
}

function ownsLock(pkg, lockToken) {
  const vk = pkg.publication && pkg.publication.vk;
  return Boolean(lockToken && vk && vk.lock_token === lockToken);
}

function clearLock(vk) {
  vk.lock_token = null;
  vk.locked_at = null;
}

function failKnown(pkg, code) {
  const vk = pkg.publication.vk;
  vk.status = 'failed';
  vk.retryable = true;
  vk.error_code = String(code);
  vk.error_message = humanize(code);
  clearLock(vk);
  return Object.assign(resultOf(pkg, 'failed'), { ready: false });
}

function markUncertain(pkg, code, message) {
  const vk = pkg.publication.vk;
  vk.status = 'uncertain';
  vk.retryable = false;
  vk.error_code = String(code || 'timeout');
  vk.error_message = message || humanize('timeout');
  clearLock(vk);
  return Object.assign(resultOf(pkg, 'uncertain'), { ready: false });
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
  clearLock(vk);
  pkg.status = 'published';
  return Object.assign(resultOf(pkg, 'published'), { ready: false });
}

function lostLock(pkg) {
  return Object.assign(resultOf(pkg, 'lock_lost'), {
    ready: false,
    error_message: humanize('lock_lost')
  });
}

function prepareApproval({ pkg, chatId, userId, now, footer }) {
  ensurePublication(pkg);
  if (String(pkg.source && pkg.source.chat_id) !== String(chatId)) {
    return { ok: false, message: 'Этот черновик создан в другом чате.' };
  }
  if (pkg.status === 'rejected' || (pkg.approval && pkg.approval.decision === 'rejected')) {
    return { ok: false, message: 'Черновик отклонён и не будет опубликован.' };
  }
  const vk = pkg.publication.vk;
  const tg = pkg.publication.telegram;
  const stamp = now || new Date().toISOString();
  if (vk.status === 'published' && vk.post_id) {
    return { ok: false, message: 'Черновик уже опубликован во ВКонтакте.\n' + vk.url };
  }
  if (IN_FLIGHT.has(vk.status) && isFresh(vk.locked_at, stamp)) {
    return { ok: false, message: 'Публикация во ВКонтакте уже выполняется. Второй пост не создан.' };
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
  let mode = 'publish';
  if (vk.status === 'uncertain' || vk.status === 'publishing') mode = 'reconcile';
  return {
    ok: true,
    publishTelegram,
    mode,
    publishChatId: tg.chat_id,
    publishText: telegramText(pkg, footer)
  };
}

function applyReject({ pkg, chatId, userId, now }) {
  if (!pkg) return { rejected: false, message: 'Черновик не найден. Укажите ID: /reject ID' };
  ensurePublication(pkg);
  if (String(pkg.source && pkg.source.chat_id) !== String(chatId)) {
    return { rejected: false, message: 'Этот черновик создан в другом чате.' };
  }
  if (pkg.status !== 'review_required' || !pkg.approval || pkg.approval.decision !== 'pending') {
    return {
      rejected: false,
      publish: false,
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

function claimPublication(pkg, options) {
  const opts = options || {};
  const now = opts.now || new Date().toISOString();
  ensurePublication(pkg);
  const vk = pkg.publication.vk;
  if (pkg.status === 'rejected' || (pkg.approval && pkg.approval.decision === 'rejected')) {
    return Object.assign(resultOf(pkg, 'rejected'), { ready: false, message: 'Черновик отклонён и не будет опубликован.' });
  }
  if (vk.status === 'published' && vk.post_id) {
    return Object.assign(resultOf(pkg, 'already_published'), { ready: false, message: 'Черновик уже опубликован во ВКонтакте.\n' + vk.url });
  }
  if (vk.status === 'uncertain') {
    return Object.assign(resultOf(pkg, 'reconcile'), { message: vk.error_message || humanize('timeout') });
  }
  if (IN_FLIGHT.has(vk.status) && isFresh(vk.locked_at, now)) {
    return Object.assign(resultOf(pkg, 'in_progress'), {
      ready: false,
      message: 'Публикация во ВКонтакте уже выполняется. Второй пост не создан.'
    });
  }
  if (vk.status === 'publishing') {
    markUncertain(pkg, 'stale_lock', 'Предыдущий запрос публикации не завершился. Новый пост не отправлен. Нужна сверка, а не повтор.');
    return Object.assign(resultOf(pkg, 'reconcile'), {
      message: pkg.publication.vk.error_message
    });
  }
  vk.lock_seq = Number(vk.lock_seq || 0) + 1;
  vk.lock_token = opts.lockToken || ('lk' + fnvHex(String(pkg.request_id) + '\n' + now + '\n' + vk.lock_seq));
  vk.locked_at = now;
  vk.status = 'locked';
  vk.retryable = false;
  vk.error_code = null;
  vk.error_message = null;
  return Object.assign(resultOf(pkg, 'publish'), { message: null });
}

function prepareGetUploadServer(pkg, options) {
  const opts = options || {};
  ensurePublication(pkg);
  if (!ownsLock(pkg, opts.lockToken)) return lostLock(pkg);
  const vk = pkg.publication.vk;
  if (vk.status === 'uncertain' || vk.status === 'publishing' || vk.status === 'published') {
    return Object.assign(resultOf(pkg, vk.status === 'published' ? 'already_published' : 'uncertain'), { ready: false });
  }
  const check = validatePublishableVk(pkg, opts.groupId);
  if (!check.ok) {
    vk.status = 'failed';
    vk.retryable = true;
    vk.error_code = 'validation';
    vk.error_message = check.errors.join(' ');
    clearLock(vk);
    return Object.assign(resultOf(pkg, 'failed'), { ready: false });
  }
  const contentSha = fnvHex(check.text + '\n' + check.image.image.fingerprint);
  vk.content_fingerprint = contentSha;
  vk.guid = makeGuid(pkg.request_id, contentSha);
  vk.status = 'uploading';
  vk.locked_at = opts.now || new Date().toISOString();
  const request = vkApiRequest('photos.getWallUploadServer', { group_id: normalizeGroupId(opts.groupId) });
  return Object.assign(resultOf(pkg, 'publish'), {
    ready: true,
    vk_request_url: request.url,
    vk_request_body: request.body
  });
}

function envelopeError(body) {
  if (!body || typeof body !== 'object') return { code: 'empty' };
  if (body.error && body.error.error_code) return { code: body.error.error_code, message: body.error.error_msg || '' };
  return null;
}

function acceptUploadServer(pkg, options) {
  const opts = options || {};
  ensurePublication(pkg);
  if (!ownsLock(pkg, opts.lockToken)) return lostLock(pkg);
  const apiError = envelopeError(opts.body);
  if (apiError) return failKnown(pkg, apiError.code);
  const response = opts.body && opts.body.response;
  if (!response || !response.upload_url) return failKnown(pkg, 'upload_host');
  let parsed;
  try {
    parsed = new URL(String(response.upload_url));
  } catch (error) {
    return failKnown(pkg, 'upload_host');
  }
  const host = parsed.hostname.toLowerCase();
  const allowed = parsed.protocol === 'https:' && (
    host === 'vk.ru' || host === 'vk.com' || host.endsWith('.vk.ru') || host.endsWith('.vk.com') || host.endsWith('.userapi.com')
  );
  if (!allowed) return failKnown(pkg, 'upload_host');
  return Object.assign(resultOf(pkg, 'publish'), { ready: true, vk_upload_url: response.upload_url });
}

function acceptPhotoUpload(pkg, options) {
  const opts = options || {};
  ensurePublication(pkg);
  if (!ownsLock(pkg, opts.lockToken)) return lostLock(pkg);
  const body = opts.body || {};
  if (body.error) return failKnown(pkg, body.error.error_code || 22);
  if (body.server == null || !body.photo || !body.hash) return failKnown(pkg, 22);
  const request = vkApiRequest('photos.saveWallPhoto', {
    group_id: normalizeGroupId(opts.groupId),
    server: body.server,
    photo: body.photo,
    hash: body.hash
  });
  return Object.assign(resultOf(pkg, 'publish'), {
    ready: true,
    vk_request_url: request.url,
    vk_request_body: request.body
  });
}

function attachmentFromPhoto(photo, groupId) {
  if (!photo || photo.id == null || photo.owner_id == null) return { ok: false, code: 'attachment' };
  const ownerId = Number(photo.owner_id);
  const expected = -Math.abs(Number(groupId));
  if (!Number.isFinite(ownerId) || ownerId !== expected) return { ok: false, code: 'attachment_owner' };
  return { ok: true, attachment: 'photo' + ownerId + '_' + photo.id };
}

function acceptSavedPhoto(pkg, options) {
  const opts = options || {};
  const now = opts.now || new Date().toISOString();
  ensurePublication(pkg);
  if (!ownsLock(pkg, opts.lockToken)) return lostLock(pkg);
  const apiError = envelopeError(opts.body);
  if (apiError) return failKnown(pkg, apiError.code);
  const response = opts.body && opts.body.response;
  const photo = Array.isArray(response) ? response[0] : response;
  const attachment = attachmentFromPhoto(photo, opts.groupId);
  if (!attachment.ok) return failKnown(pkg, attachment.code);
  const vk = pkg.publication.vk;
  vk.attachment = attachment.attachment;
  vk.status = 'publishing';
  vk.locked_at = now;
  const text = String(pkg.platforms.vk.content || '').trim();
  const request = vkApiRequest('wall.post', buildWallPostParams(
    normalizeGroupId(opts.groupId),
    text,
    vk.attachment,
    vk.guid
  ));
  return Object.assign(resultOf(pkg, 'publish'), {
    ready: true,
    vk_request_url: request.url,
    vk_request_body: request.body
  });
}

function acceptWallPost(pkg, options) {
  const opts = options || {};
  const now = opts.now || new Date().toISOString();
  ensurePublication(pkg);
  if (!ownsLock(pkg, opts.lockToken)) return lostLock(pkg);
  const apiError = envelopeError(opts.body);
  if (apiError) {
    if (Number(apiError.code) === 1 || Number(apiError.code) === 10) {
      return markUncertain(pkg, apiError.code, humanize('timeout'));
    }
    return failKnown(pkg, apiError.code);
  }
  const response = opts.body && opts.body.response;
  if (!response || response.post_id == null) return markUncertain(pkg, 'publish_response', humanize('timeout'));
  return markPublished(pkg, opts.groupId, response.post_id, now);
}

function markPublishUnknown(pkg, options) {
  const opts = options || {};
  ensurePublication(pkg);
  if (!ownsLock(pkg, opts.lockToken)) return lostLock(pkg);
  const code = opts.body && opts.body.error && opts.body.error.error_code;
  if (code && KNOWN_REJECT_CODES.has(Number(code))) return failKnown(pkg, Number(code));
  return markUncertain(pkg, code || 'timeout', humanize('timeout') + ' Просмотр последних 20 записей это не подтверждает и не опровергает.');
}

function recordUploadFailure(pkg, options) {
  const opts = options || {};
  ensurePublication(pkg);
  if (!ownsLock(pkg, opts.lockToken)) return lostLock(pkg);
  if (pkg.publication.vk.status === 'publishing') return markPublishUnknown(pkg, opts);
  const code = opts.body && opts.body.error && (opts.body.error.error_code || opts.body.error.code);
  return failKnown(pkg, code || 22);
}

function buildReconcileRequest(pkg, options) {
  const opts = options || {};
  ensurePublication(pkg);
  const groupId = normalizeGroupId(opts.groupId);
  if (!groupId) {
    return Object.assign(resultOf(pkg, 'failed'), { ready: false, error_message: humanize('config') });
  }
  const postId = String(opts.postId || pkg.publication.vk.post_id || '').trim();
  if (/^[1-9]\d*$/.test(postId)) {
    const request = vkApiRequest('wall.getById', { posts: '-' + groupId + '_' + postId });
    return Object.assign(resultOf(pkg, 'reconcile'), {
      ready: true,
      scope: 'by_id',
      vk_request_url: request.url,
      vk_request_body: request.body
    });
  }
  const request = vkApiRequest('wall.get', {
    owner_id: -Number(groupId),
    count: RECENT_SCAN_LIMIT,
    filter: 'owner'
  });
  return Object.assign(resultOf(pkg, 'reconcile'), {
    ready: true,
    scope: 'recent',
    vk_request_url: request.url,
    vk_request_body: request.body
  });
}

function extractPosts(body) {
  const response = body && body.response ? body.response : body;
  if (Array.isArray(response)) return response;
  if (response && Array.isArray(response.items)) return response.items;
  if (response && Array.isArray(response.posts)) return response.posts;
  return [];
}

function applyReconcileResult(pkg, options) {
  const opts = options || {};
  const now = opts.now || new Date().toISOString();
  ensurePublication(pkg);
  const vk = pkg.publication.vk;
  if (vk.status === 'published' && vk.post_id) return resultOf(pkg, 'already_published');
  const apiError = envelopeError(opts.body);
  if (apiError) {
    return markUncertain(pkg, 'reconcile_failed', 'Сверка не выполнена. Новый пост не создан.');
  }
  const posts = extractPosts(opts.body);
  const wanted = String(pkg.platforms && pkg.platforms.vk && pkg.platforms.vk.content || '').trim();
  if (opts.scope === 'by_id') {
    const confirmed = posts.find((post) => Number(post.id) === Number(opts.postId || vk.post_id));
    if (confirmed && confirmed.id != null) return markPublished(pkg, opts.groupId, confirmed.id, now);
    return markUncertain(
      pkg,
      'by_id_miss',
      'Указанная запись на стене не найдена. Это не доказывает, что прежняя публикация не создалась. Новый пост не создан.'
    );
  }
  const matches = posts.filter((post) => String(post.text || post.message || '').trim() === wanted && post.id != null);
  if (matches.length === 1) return markPublished(pkg, opts.groupId, matches[0].id, now);
  if (matches.length > 1) {
    return markUncertain(pkg, 'ambiguous', 'В последних записях несколько постов с тем же текстом. Укажите post_id: /vk-resolve ID POST_ID.');
  }
  return markUncertain(pkg, 'scan_inconclusive', humanize('scan_inconclusive') + ' Если запись уже есть, пришлите её id: /vk-resolve ' + pkg.request_id + ' POST_ID.');
}

function planResolve(pkg, argument) {
  ensurePublication(pkg);
  const vk = pkg.publication.vk;
  if (vk.status === 'published' && vk.post_id) {
    return { action: 'stop', http: false, message: 'Запись уже сохранена.\n' + vk.url };
  }
  if (vk.status !== 'uncertain') {
    return { action: 'stop', http: false, message: 'Сверка доступна, когда исход публикации неизвестен. Сейчас статус: ' + vk.status };
  }
  const decision = String(argument || '').trim().toLowerCase();
  if (decision === 'absent') {
    return {
      action: 'stop',
      http: false,
      message: 'Команда absent не снимает блокировку. Просмотр последних 20 записей не доказывает, что поста нет. Новый пост не будет создан. Если запись уже есть, укажите её id.'
    };
  }
  if (/^[1-9]\d*$/.test(decision)) {
    return { action: 'reconcile', http: true, postId: decision, scope: 'by_id' };
  }
  return { action: 'reconcile', http: true, postId: null, scope: 'recent' };
}

function recordReconcileFailure(pkg) {
  ensurePublication(pkg);
  if (pkg.publication.vk.status === 'published') return resultOf(pkg, 'already_published');
  return markUncertain(pkg, 'reconcile_failed', 'Сверка не выполнена. Новый пост не создан. Отсутствие записи не установлено.');
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
    lines.push(vk.error_message || humanize('timeout'));
    lines.push('Если запись уже видна на стене: /vk-resolve ' + pkg.request_id + ' POST_ID');
  } else if (vk.status === 'failed') {
    lines.push('ВКонтакте не опубликовано. ' + (vk.error_message || 'Ошибка без подробностей.'));
  } else if (IN_FLIGHT.has(vk.status)) {
    lines.push('ВКонтакте: публикация уже выполняется. Второй пост не создан.');
  }
  return lines.join('\n');
}

function largestPhotoFileId(photos) {
  const list = Array.isArray(photos) ? photos.filter((item) => item && item.file_id) : [];
  if (!list.length) return null;
  const best = list.reduce((left, right) => ((right.file_size || 0) > (left.file_size || 0) ? right : left));
  return String(best.file_id);
}

module.exports = {
  API_BASE,
  API_VERSION,
  LOCK_TTL_MS,
  MAX_IMAGE_BYTES,
  RECENT_SCAN_LIMIT,
  LIMITS,
  emptyVkPublication,
  ensurePublication,
  makeGuid,
  buildFormBody,
  buildWallPostParams,
  vkApiRequest,
  sniffImage,
  readImageSize,
  inspectImage,
  attachDraftImage,
  readDraftImage,
  validateModelPackage,
  validatePublishableVk,
  prepareApproval,
  applyReject,
  claimPublication,
  prepareGetUploadServer,
  acceptUploadServer,
  acceptPhotoUpload,
  acceptSavedPhoto,
  acceptWallPost,
  markPublishUnknown,
  recordUploadFailure,
  buildReconcileRequest,
  applyReconcileResult,
  planResolve,
  recordReconcileFailure,
  formatPublicationMessage,
  attachmentFromPhoto,
  largestPhotoFileId,
  humanize,
  normalizeGroupId,
  ownsLock
};
