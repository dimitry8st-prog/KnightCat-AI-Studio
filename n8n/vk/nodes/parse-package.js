const response = $json;
const original = $('Prepare AI Request').first().json;

function fail(message) {
  return [{ json: {
    ...original,
    package_valid: false,
    user_message: message
  }}];
}

if (response.error) {
  return fail('OpenRouter вернул ошибку: ' + (response.error.message || JSON.stringify(response.error)));
}

let raw = response?.choices?.[0]?.message?.content;
if (!raw || typeof raw !== 'string') {
  return fail('Модель не вернула текстовый результат.');
}

raw = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');

let data;
try {
  data = JSON.parse(raw);
} catch (error) {
  return fail('Ответ модели не является корректным JSON.');
}

const verdict = vkPublisher.validateModelPackage(data);
if (!verdict.ok) {
  return fail('Пакет не прошёл проверку лимитов:\n' + verdict.errors.join('\n'));
}

const warnings = Array.isArray(data.analysis.warnings) ? [...data.analysis.warnings] : [];
const contentPackage = {
  schema_version: 'knightcat/v1.1',
  request_id: original.request_id,
  status: 'review_required',
  source: {
    type: 'text',
    text: original.source_text,
    chat_id: original.source_chat_id,
    user_id: original.user_id,
    received_at: original.received_at,
    photo_file_id: original.source_photo_file_id || null
  },
  model: {
    provider: 'openrouter',
    id: original.config.model,
    prompt_version: original.prompt_version
  },
  analysis: {
    ...data.analysis,
    warnings
  },
  suggested_headline: String(data.suggested_headline || ''),
  image_prompt: String(data.image_prompt),
  platforms: data.platforms,
  validation: {
    schema_valid: true,
    lengths: verdict.lengths,
    warnings,
    limits: vkPublisher.LIMITS
  },
  approval: {
    decision: 'pending',
    decided_by: null,
    decided_at: null
  },
  visual: {
    prompt: String(data.image_prompt),
    image: null
  },
  publication: {
    telegram: {
      status: 'not_started',
      message_id: null,
      chat_id: original.config.publish_chat_id,
      locked_at: null
    },
    vk: vkPublisher.emptyVkPublication()
  },
  created_at: new Date().toISOString()
};

return [{ json: {
  ...original,
  package_valid: true,
  content_package: contentPackage
}}];
