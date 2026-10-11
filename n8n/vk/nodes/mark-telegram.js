const published = $json;
const approval = $('Load Pending Draft').first().json;
const store = $getWorkflowStaticData('global');
const pkg = store.pending?.[approval.request_id];

if (!pkg) {
  throw new Error('Draft disappeared after publication: ' + approval.request_id);
}

pkg.publication = pkg.publication || {};
pkg.publication.telegram = Object.assign({}, pkg.publication.telegram, {
  status: 'published',
  message_id: published.message_id || published.result?.message_id || null,
  chat_id: approval.publish_chat_id,
  published_at: new Date().toISOString(),
  locked_at: null
});
pkg.approval = {
  decision: 'approved',
  decided_by: approval.approved_by,
  decided_at: pkg.approval?.decided_at || new Date().toISOString()
};
if (pkg.status === 'review_required') pkg.status = 'publishing';
store.pending[approval.request_id] = pkg;

return [{ json: {
  chat_id: approval.approval_chat_id,
  request_id: approval.request_id,
  telegram_message_id: pkg.publication.telegram.message_id,
  vk_mode: approval.vk_mode || 'publish'
}}];
