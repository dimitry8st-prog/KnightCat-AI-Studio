const input = $json;
const store = $getWorkflowStaticData('global');
const approval = $('Load Pending Draft').first().json;
const requestId = input.request_id || approval.request_id;
const pkg = store.pending && store.pending[requestId];
const chatId = approval.approval_chat_id || input.chat_id;

if (!pkg) {
  return [{ json: {
    chat_id: chatId,
    confirmation: 'Черновик исчез до публикации во ВКонтакте: ' + requestId
  }}];
}

const vars = (typeof $vars !== 'undefined' && $vars) ? $vars : {};
const credentials = {
  groupId: vars.KNIGHTCAT_VK_GROUP_ID,
  communityToken: vars.KNIGHTCAT_VK_COMMUNITY_TOKEN,
  userToken: vars.KNIGHTCAT_VK_USER_TOKEN
};
const nodeHelpers = this.helpers;

async function loadImage(draft) {
  const image = draft.visual && draft.visual.image;
  if (image && image.base64) {
    return {
      bytes: Buffer.from(String(image.base64), 'base64'),
      filename: image.filename || 'photo.jpg'
    };
  }
  const binary = $input.item && $input.item.binary;
  if (binary && binary.image && nodeHelpers.getBinaryDataBuffer) {
    return {
      bytes: await nodeHelpers.getBinaryDataBuffer(0, 'image'),
      filename: binary.image.fileName || 'photo.jpg'
    };
  }
  if (image && image.path) {
    try {
      return {
        bytes: require('fs').readFileSync(image.path),
        filename: image.filename || 'photo.jpg'
      };
    } catch (error) {
      const missing = new Error('Не удалось прочитать изображение черновика.');
      missing.code = 'image_missing';
      missing.phase = 'upload';
      missing.uncertain = false;
      throw missing;
    }
  }
  const missing = new Error('У одобренного черновика нет изображения.');
  missing.code = 'image_missing';
  missing.phase = 'upload';
  missing.uncertain = false;
  throw missing;
}

const outcome = await vkPublisher.publishApprovedDraft({
  pkg,
  credentials,
  client: vkPublisher.createN8nVkClient(nodeHelpers),
  now: new Date().toISOString(),
  loadImage,
  mode: input.vk_mode || approval.vk_mode || 'publish'
});
store.pending[requestId] = pkg;

return [{ json: {
  chat_id: chatId,
  request_id: requestId,
  confirmation: vkPublisher.formatPublicationMessage(pkg, input.telegram_message_id || null),
  vk_status: outcome.status,
  vk_url: outcome.url || null
}}];
