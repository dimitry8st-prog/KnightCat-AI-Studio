const approval = $('Load Pending Draft').first().json;
const store = $getWorkflowStaticData('global');
const requestId = $json.request_id || approval.request_id;
const pkg = store.pending && store.pending[requestId];
if (!pkg) {
  return [{ json: {
    chat_id: approval.approval_chat_id,
    request_id: requestId,
    vk_action: 'stop',
    confirmation: 'Черновик исчез до публикации во ВКонтакте.'
  }}];
}
const claim = vkPublisher.claimPublication(pkg, { now: new Date().toISOString() });
store.pending[requestId] = pkg;
const action = claim.action === 'publish' || claim.action === 'reconcile' ? claim.action : 'stop';
return [{ json: {
  chat_id: approval.approval_chat_id,
  request_id: requestId,
  lock_token: claim.lock_token || null,
  telegram_message_id: $json.telegram_message_id || null,
  vk_action: action,
  confirmation: claim.message || vkPublisher.formatPublicationMessage(pkg, $json.telegram_message_id)
}}];
