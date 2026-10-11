const update = $json;
const message = update.message || update.edited_message;

if (!message?.chat?.id || !message?.from?.id) {
  return [{ json: {
    event_type: 'unsupported',
    reply_chat_id: null,
    user_message: 'Поддерживаются только обычные сообщения Telegram.'
  }}];
}

const text = String(message.text || message.caption || '').trim();
const chatId = String(message.chat.id);
const userId = String(message.from.id);
const messageId = String(message.message_id);
const requestId = `${chatId.replace('-', 'm')}-${messageId}`;

const vars = typeof $vars !== 'undefined' ? $vars : {};
const allowedRaw = String(vars.KNIGHTCAT_ALLOWED_USER_IDS || '').trim();
const allowedUsers = allowedRaw.split(',').map(v => v.trim()).filter(Boolean);
const isAllowed = allowedUsers.length > 0 && allowedUsers.includes(userId);

const config = {
  model: String(vars.KNIGHTCAT_OPENROUTER_MODEL || 'openai/gpt-4.1-mini'),
  publish_chat_id: String(vars.KNIGHTCAT_PUBLISH_CHAT_ID || chatId),
  footer: String(vars.KNIGHTCAT_FOOTER || '').trim()
};

if (!allowedRaw) {
  return [{ json: {
    event_type: 'unsupported',
    reply_chat_id: chatId,
    user_id: userId,
    user_message: 'Сначала задайте переменную KNIGHTCAT_ALLOWED_USER_IDS в n8n.'
  }}];
}

if (!isAllowed) {
  return [{ json: {
    event_type: 'unsupported',
    reply_chat_id: chatId,
    user_id: userId,
    user_message: 'У вас нет доступа к этому боту.'
  }}];
}

const approve = text.match(/^\/approve(?:\s+([\w-]+))?$/i);
const reject = text.match(/^\/reject(?:\s+([\w-]+))?$/i);
const resolve = text.match(/^\/vk-resolve(?:\s+([\w-]+))?(?:\s+([0-9]+|absent))?$/i);

let eventType = 'generate';
let targetRequestId = null;
let resolveArgument = null;

if (approve) {
  eventType = 'approve';
  targetRequestId = approve[1] || null;
} else if (reject) {
  eventType = 'reject';
  targetRequestId = reject[1] || null;
} else if (resolve) {
  eventType = 'vk_resolve';
  targetRequestId = resolve[1] || null;
  resolveArgument = resolve[2] ? String(resolve[2]).toLowerCase() : null;
} else if (!text || text.startsWith('/start') || text.startsWith('/help')) {
  eventType = 'unsupported';
}

return [{ json: {
  event_type: eventType,
  request_id: requestId,
  target_request_id: targetRequestId,
  resolve_argument: resolveArgument,
  source_text: text,
  reply_chat_id: chatId,
  source_chat_id: chatId,
  user_id: userId,
  message_id: messageId,
  received_at: new Date().toISOString(),
  config,
  user_message: eventType === 'unsupported'
    ? 'Отправьте идею обычным сообщением. /approve ID публикует, /reject ID отклоняет. Если исход стены неизвестен: /vk-resolve ID, /vk-resolve ID POST_ID или /vk-resolve ID absent.'
    : null
}}];
