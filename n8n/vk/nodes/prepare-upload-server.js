const store = $getWorkflowStaticData('global');
const requestId = $json.request_id;
const pkg = store.pending && store.pending[requestId];
const vars = (typeof $vars !== 'undefined' && $vars) ? $vars : {};
const prepared = vkPublisher.prepareGetUploadServer(pkg, {
  lockToken: $json.lock_token,
  now: new Date().toISOString(),
  groupId: vars.KNIGHTCAT_VK_GROUP_ID
});
if (pkg) store.pending[requestId] = pkg;
return [{ json: {
  chat_id: $json.chat_id,
  request_id: requestId,
  lock_token: $json.lock_token,
  telegram_message_id: $json.telegram_message_id || null,
  vk_ready: Boolean(prepared.ready),
  vk_request_body: prepared.vk_request_body || null,
  confirmation: prepared.error_message || vkPublisher.formatPublicationMessage(pkg, $json.telegram_message_id)
}}];
