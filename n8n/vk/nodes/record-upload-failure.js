const names = [
  'Prepare VK Upload Server',
  'Accept VK Upload Server',
  'Accept VK Photo Upload'
];
let prior = null;
for (const name of names) {
  try {
    const item = $(name).first();
    if (item && item.json && item.json.request_id) prior = item.json;
  } catch (error) {
    prior = prior;
  }
}
const store = $getWorkflowStaticData('global');
const pkg = prior && store.pending && store.pending[prior.request_id];
const failed = pkg ? vkPublisher.recordUploadFailure(pkg, {
  lockToken: prior.lock_token,
  now: new Date().toISOString(),
  body: $json
}) : { error_message: 'Сбой загрузки изображения. Запись на стену не создавалась.' };
if (pkg && prior) store.pending[prior.request_id] = pkg;
const text = (pkg && vkPublisher.formatPublicationMessage(pkg, prior.telegram_message_id)) || failed.error_message;
return [{ json: {
  chat_id: prior && prior.chat_id,
  request_id: prior && prior.request_id,
  confirmation: text,
  user_message: text
}}];
