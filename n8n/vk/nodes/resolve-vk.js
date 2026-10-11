const input = $json;
const store = $getWorkflowStaticData('global');
const requestedId = input.target_request_id
  || store.latestByChat?.[String(input.reply_chat_id)]
  || null;
const pkg = requestedId ? store.pending?.[requestedId] : null;

if (!pkg) {
  return [{ json: {
    chat_id: input.reply_chat_id,
    user_message: 'Черновик не найден. Укажите ID: /vk-resolve ID'
  }}];
}

if (String(pkg.source && pkg.source.chat_id) !== String(input.reply_chat_id)) {
  return [{ json: {
    chat_id: input.reply_chat_id,
    user_message: 'Этот черновик создан в другом чате.'
  }}];
}

const vars = (typeof $vars !== 'undefined' && $vars) ? $vars : {};
const outcome = await vkPublisher.resolveUncertain({
  pkg,
  argument: input.resolve_argument,
  credentials: {
    groupId: vars.KNIGHTCAT_VK_GROUP_ID,
    communityToken: vars.KNIGHTCAT_VK_COMMUNITY_TOKEN,
    userToken: vars.KNIGHTCAT_VK_USER_TOKEN
  },
  client: vkPublisher.createN8nVkClient(this.helpers),
  now: new Date().toISOString()
});
store.pending[requestedId] = pkg;

return [{ json: {
  chat_id: input.reply_chat_id,
  user_message: vkPublisher.formatPublicationMessage(pkg) || outcome.error_message
}}];
