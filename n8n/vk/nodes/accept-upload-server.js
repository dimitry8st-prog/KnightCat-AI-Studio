const prior = $('Prepare VK Upload Server').first().json;
const store = $getWorkflowStaticData('global');
const pkg = store.pending && store.pending[prior.request_id];
const accepted = vkPublisher.acceptUploadServer(pkg, {
  lockToken: prior.lock_token,
  now: new Date().toISOString(),
  body: $json
});
if (pkg) store.pending[prior.request_id] = pkg;
if (!accepted.ready) {
  return [{ json: {
    chat_id: prior.chat_id,
    request_id: prior.request_id,
    lock_token: prior.lock_token,
    telegram_message_id: prior.telegram_message_id,
    vk_ready: false,
    confirmation: accepted.error_message || vkPublisher.formatPublicationMessage(pkg, prior.telegram_message_id)
  }}];
}
const image = vkPublisher.readDraftImage(pkg);
const binary = await this.helpers.prepareBinaryData(image.bytes, image.image.filename, image.image.mime);
return [{
  json: {
    chat_id: prior.chat_id,
    request_id: prior.request_id,
    lock_token: prior.lock_token,
    telegram_message_id: prior.telegram_message_id,
    vk_ready: true,
    vk_upload_url: accepted.vk_upload_url
  },
  binary: { photo: binary }
}];
