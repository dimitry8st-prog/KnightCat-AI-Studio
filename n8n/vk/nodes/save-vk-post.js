const prior = $('Arm VK Wall Post').first().json;
const store = $getWorkflowStaticData('global');
const pkg = store.pending && store.pending[prior.request_id];
const vars = (typeof $vars !== 'undefined' && $vars) ? $vars : {};
const saved = vkPublisher.acceptWallPost(pkg, {
  lockToken: prior.lock_token,
  now: new Date().toISOString(),
  groupId: vars.KNIGHTCAT_VK_GROUP_ID,
  body: $json
});
if (pkg) store.pending[prior.request_id] = pkg;
return [{ json: {
  chat_id: prior.chat_id,
  request_id: prior.request_id,
  confirmation: vkPublisher.formatPublicationMessage(pkg, prior.telegram_message_id) || saved.error_message,
  user_message: vkPublisher.formatPublicationMessage(pkg, prior.telegram_message_id) || saved.error_message
}}];
