const store = $getWorkflowStaticData('global');
const requestId = $json.request_id;
const pkg = store.pending && store.pending[requestId];
const vars = (typeof $vars !== 'undefined' && $vars) ? $vars : {};
const prepared = vkPublisher.buildReconcileRequest(pkg, {
  groupId: vars.KNIGHTCAT_VK_GROUP_ID,
  postId: $json.post_id || null
});
return [{ json: {
  chat_id: $json.chat_id,
  request_id: requestId,
  lock_token: $json.lock_token || null,
  telegram_message_id: $json.telegram_message_id || null,
  vk_ready: Boolean(prepared.ready),
  vk_scope: prepared.scope || null,
  vk_post_id: $json.post_id || null,
  vk_request_body: prepared.vk_request_body || null,
  confirmation: prepared.error_message || vkPublisher.formatPublicationMessage(pkg, $json.telegram_message_id),
  user_message: prepared.error_message || vkPublisher.formatPublicationMessage(pkg, $json.telegram_message_id)
}}];
