const input = $json;
const store = $getWorkflowStaticData('global');
const requestedId = input.target_request_id
  || store.latestByChat?.[String(input.reply_chat_id)]
  || null;
const pkg = requestedId ? store.pending?.[requestedId] : null;
const decision = vkPublisher.applyReject({
  pkg,
  chatId: input.reply_chat_id,
  userId: input.user_id,
  now: new Date().toISOString()
});
if (pkg && requestedId) store.pending[requestedId] = pkg;

return [{ json: {
  chat_id: input.reply_chat_id,
  user_message: (decision.rejected ? '🛑 ' : '') + decision.message
}}];
