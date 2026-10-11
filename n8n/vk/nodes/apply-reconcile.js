const prior = $('Prepare VK Reconcile').first().json;
const store = $getWorkflowStaticData('global');
const pkg = store.pending && store.pending[prior.request_id];
const vars = (typeof $vars !== 'undefined' && $vars) ? $vars : {};
const applied = vkPublisher.applyReconcileResult(pkg, {
  now: new Date().toISOString(),
  groupId: vars.KNIGHTCAT_VK_GROUP_ID,
  scope: prior.vk_scope,
  postId: prior.vk_post_id,
  body: $json
});
if (pkg) store.pending[prior.request_id] = pkg;
const text = vkPublisher.formatPublicationMessage(pkg, prior.telegram_message_id) || applied.error_message;
return [{ json: {
  chat_id: prior.chat_id,
  request_id: prior.request_id,
  confirmation: text,
  user_message: text
}}];
