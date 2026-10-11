const input = $json;
const store = $getWorkflowStaticData('global');
const requestedId = input.target_request_id
  || store.latestByChat?.[String(input.reply_chat_id)]
  || null;
const pkg = requestedId ? store.pending?.[requestedId] : null;
if (!pkg) {
  return [{ json: {
    chat_id: input.reply_chat_id,
    vk_action: 'stop',
    user_message: 'Черновик не найден. Укажите ID: /vk-resolve ID POST_ID',
    confirmation: 'Черновик не найден. Укажите ID: /vk-resolve ID POST_ID'
  }}];
}
if (String(pkg.source && pkg.source.chat_id) !== String(input.reply_chat_id)) {
  return [{ json: {
    chat_id: input.reply_chat_id,
    vk_action: 'stop',
    user_message: 'Этот черновик создан в другом чате.',
    confirmation: 'Этот черновик создан в другом чате.'
  }}];
}
const plan = vkPublisher.planResolve(pkg, input.resolve_argument);
return [{ json: {
  chat_id: input.reply_chat_id,
  request_id: requestedId,
  post_id: plan.postId || null,
  vk_action: plan.http ? 'reconcile' : 'stop',
  user_message: plan.message || vkPublisher.formatPublicationMessage(pkg),
  confirmation: plan.message || vkPublisher.formatPublicationMessage(pkg)
}}];
