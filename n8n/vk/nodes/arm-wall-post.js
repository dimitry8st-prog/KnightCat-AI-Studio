const prior = $('Accept VK Photo Upload').first().json;
const store = $getWorkflowStaticData('global');
const pkg = store.pending && store.pending[prior.request_id];
const vars = (typeof $vars !== 'undefined' && $vars) ? $vars : {};
const armed = vkPublisher.acceptSavedPhoto(pkg, {
  lockToken: prior.lock_token,
  now: new Date().toISOString(),
  groupId: vars.KNIGHTCAT_VK_GROUP_ID,
  body: $json
});
if (pkg) store.pending[prior.request_id] = pkg;
return [{ json: {
  chat_id: prior.chat_id,
  request_id: prior.request_id,
  lock_token: prior.lock_token,
  telegram_message_id: prior.telegram_message_id,
  vk_ready: Boolean(armed.ready),
  vk_request_body: armed.vk_request_body || null,
  confirmation: armed.error_message || vkPublisher.formatPublicationMessage(pkg, prior.telegram_message_id)
}}];
