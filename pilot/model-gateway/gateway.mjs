import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const PROFILE = 'open-responses-subset';

export const UNSUPPORTED = [
  'streaming',
  'websocket',
  'tools and function calls',
  'previous_response_id',
  'reasoning items',
  'images and audio input',
  'background',
  'truncation',
  'service_tier',
  'semantic event stream'
];

const RETRYABLE = new Set([408, 429, 500, 502, 503, 504]);

export function loadConfig(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

export async function createResponse(request, options = {}) {
  const config = options.config;
  if (!config?.models) {
    return failure('invalid_request', 'Конфигурация моделей не передана.');
  }
  const problem = validateRequest(request);
  if (problem) return failure('invalid_request', problem);

  const alias = request.model || config.default_model;
  const model = config.models[alias];
  if (!model) {
    return failure('model_unavailable', `Модель «${alias}» не настроена.`);
  }

  const apiKey = options.env?.[model.api_key_env] ?? process.env[model.api_key_env];
  if (!apiKey) {
    return failure('missing_credentials', `Переменная ${model.api_key_env} не задана.`);
  }

  const targetModel = options.env?.[model.model_env]
    || process.env[model.model_env]
    || model.model_default;
  const url = options.env?.[model.base_url_env]
    || process.env[model.base_url_env]
    || model.base_url_default;
  const timeoutMs = config.timeout_ms || 20000;
  const maxAttempts = request.retry === false ? 1 : (config.max_attempts || 1);
  const transport = options.transport || defaultTransport;
  const body = chatBody(request, targetModel);

  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const raw = await transport({
        url,
        timeoutMs,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        body
      });
      return normalizeSuccess(raw, {
        alias,
        provider: model.provider,
        targetModel,
        attempt,
        request
      });
    } catch (error) {
      lastError = error;
      const retryable = error.status && RETRYABLE.has(error.status);
      if (attempt < maxAttempts && retryable) continue;
      return normalizeFailure(error, { alias, provider: model.provider, targetModel, attempt });
    }
  }
  return normalizeFailure(lastError, { alias, provider: model.provider, targetModel, attempt: maxAttempts });
}

function validateRequest(request) {
  if (!request || typeof request !== 'object') return 'Запрос должен быть объектом.';
  if (!Array.isArray(request.input) || request.input.length === 0) return 'Нужен непустой input.';
  const message = request.input.find((item) => item?.type === 'message' && item.role === 'user');
  if (!message || typeof message.content !== 'string' || !message.content.trim()) {
    return 'Нужно текстовое сообщение пользователя.';
  }
  for (const key of ['stream', 'tools', 'previous_response_id', 'background']) {
    if (request[key] != null) return `Поле ${key} в этом пилоте не поддерживается.`;
  }
  return null;
}

function chatBody(request, model) {
  const user = request.input.find((item) => item.type === 'message' && item.role === 'user');
  const system = request.instructions
    ? [{ role: 'system', content: request.instructions }]
    : [];
  const body = {
    model,
    temperature: request.temperature ?? 0,
    messages: [...system, { role: 'user', content: user.content }]
  };
  if (request.text?.format?.type === 'json_object') {
    body.response_format = { type: 'json_object' };
  }
  return body;
}

function normalizeSuccess(raw, meta) {
  const content = extractContent(raw);
  const wantsJson = meta.request.text?.format?.type === 'json_object';
  let parsed = null;
  if (wantsJson) {
    parsed = parseJsonContent(content);
    if (!parsed.ok) {
      return {
        ...baseResponse(meta, 'failed'),
        output: [],
        parsed_json: null,
        error: { code: 'invalid_json', message: parsed.message }
      };
    }
  }
  return {
    ...baseResponse(meta, 'completed'),
    output: [{
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: content }]
    }],
    parsed_json: parsed?.value ?? null,
    error: null
  };
}

function normalizeFailure(error, meta) {
  const status = error?.status;
  const providerCode = error?.body?.error?.code || error?.body?.code || '';
  const unavailable = status === 404 || /model_not_found|model_not_supported|model_unavailable/i.test(String(providerCode));
  const code = error?.name === 'TimeoutError' || error?.code === 'timeout'
    ? 'timeout'
    : unavailable
      ? 'model_unavailable'
      : 'api_error';
  return {
    ...baseResponse(meta, 'failed'),
    output: [],
    parsed_json: null,
    error: { code, message: publicMessage(error) }
  };
}

function baseResponse(meta, status) {
  return {
    id: `resp_${meta.alias}_${meta.attempt}`,
    object: 'response',
    status,
    model: meta.targetModel,
    provider: meta.provider,
    compatibility: { profile: PROFILE, unsupported: UNSUPPORTED },
    attempt: meta.attempt
  };
}

function extractContent(raw) {
  const content = raw?.choices?.[0]?.message?.content;
  if (typeof content === 'string') return stripFence(content);
  if (Array.isArray(content)) {
    return stripFence(content.map((part) => part?.text || '').join(''));
  }
  throw Object.assign(new Error('В ответе провайдера нет текста.'), { code: 'api_error', status: 502 });
}

function stripFence(text) {
  return String(text).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
}

function parseJsonContent(text) {
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { ok: false, message: 'JSON должен быть объектом.' };
    }
    return { ok: true, value };
  } catch {
    return { ok: false, message: 'Ответ модели не является корректным JSON.' };
  }
}

function publicMessage(error) {
  const raw = error?.body?.error?.message || error?.message || 'Ошибка провайдера.';
  return String(raw)
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/sk-[A-Za-z0-9_-]+/g, 'sk-[redacted]');
}

function failure(code, message) {
  return {
    id: 'resp_local',
    object: 'response',
    status: 'failed',
    model: null,
    provider: null,
    output: [],
    parsed_json: null,
    error: { code, message },
    compatibility: { profile: PROFILE, unsupported: UNSUPPORTED },
    attempt: 0
  };
}

async function defaultTransport({ url, timeoutMs, headers, body }) {
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs)
  });
  const text = await response.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { raw: text.slice(0, 300) }; }
  if (!response.ok) {
    const error = new Error(`HTTP ${response.status}`);
    error.status = response.status;
    error.body = parsed;
    throw error;
  }
  return parsed;
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  console.log(JSON.stringify({ profile: PROFILE, unsupported: UNSUPPORTED }, null, 2));
}
