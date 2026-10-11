const input = $json;
const store = $getWorkflowStaticData('global');
const requestedId = input.target_request_id
  || store.latestByChat?.[String(input.reply_chat_id)]
  || null;
const pkg = requestedId ? store.pending?.[requestedId] : null;

if (!pkg) {
  return [{ json: {
    approval_valid: false,
    chat_id: input.reply_chat_id,
    user_message: 'Черновик не найден. Укажите ID: /approve ID'
  }}];
}

const decision = vkPublisher.prepareApproval({
  pkg,
  chatId: input.reply_chat_id,
  userId: input.user_id,
  now: new Date().toISOString(),
  footer: input.config && input.config.footer
});
store.pending[requestedId] = pkg;

if (!decision.ok) {
  return [{ json: {
    approval_valid: false,
    chat_id: input.reply_chat_id,
    user_message: decision.message
  }}];
}

return [{ json: {
  approval_valid: true,
  publish_telegram: decision.publishTelegram,
  vk_mode: decision.mode,
  request_id: requestedId,
  approval_chat_id: input.reply_chat_id,
  approved_by: input.user_id,
  publish_chat_id: decision.publishChatId,
  publish_text: decision.publishText
}}];
