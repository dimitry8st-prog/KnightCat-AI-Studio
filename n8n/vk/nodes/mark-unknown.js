const prior = $('Arm VK Wall Post').first().json;
const store = $getWorkflowStaticData('global');
const pkg = store.pending && store.pending[prior.request_id];
const unknown = vkPublisher.markPublishUnknown(pkg, {
  lockToken: prior.lock_token,
  now: new Date().toISOString(),
  body: $json
});
if (pkg) store.pending[prior.request_id] = pkg;
const text = vkPublisher.formatPublicationMessage(pkg, prior.telegram_message_id) || unknown.error_message;
return [{ json: {
  chat_id: prior.chat_id,
  request_id: prior.request_id,
  confirmation: text,
  user_message: text
}}];
