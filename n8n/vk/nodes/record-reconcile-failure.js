const prior = $('Prepare VK Reconcile').first().json;
const store = $getWorkflowStaticData('global');
const pkg = store.pending && store.pending[prior.request_id];
const failed = pkg ? vkPublisher.recordReconcileFailure(pkg) : { error_message: 'Сверка не выполнена.' };
if (pkg) store.pending[prior.request_id] = pkg;
const text = (pkg && vkPublisher.formatPublicationMessage(pkg, prior.telegram_message_id)) || failed.error_message;
return [{ json: {
  chat_id: prior.chat_id,
  request_id: prior.request_id,
  confirmation: text,
  user_message: text
}}];
