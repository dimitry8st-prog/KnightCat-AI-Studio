import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createResponse, loadConfig } from './gateway.mjs';

const config = loadConfig(new URL('./config.example.json', import.meta.url));
const env = {
  QWEN_API_KEY: 'test-qwen-key',
  OPENROUTER_API_KEY: 'test-openrouter-key'
};

function request(extra = {}) {
  return {
    model: 'qwen',
    instructions: 'Верни JSON.',
    input: [{ type: 'message', role: 'user', content: 'Короткий пост о рыжем коте.' }],
    temperature: 0,
    text: { format: { type: 'json_object' } },
    ...extra
  };
}

function mockTransport(handler) {
  const calls = [];
  const transport = async (args) => {
    calls.push({ url: args.url, body: args.body, authorization: args.headers.Authorization });
    return handler(args, calls.length);
  };
  return { transport, calls };
}

test('мок: успешный ответ адаптера Qwen', async () => {
  const { transport, calls } = mockTransport(async () => ({
    choices: [{ message: { content: '{"title":"Рыжий","text":"Черновик"}' } }]
  }));
  const response = await createResponse(request(), { config, env, transport });
  assert.equal(response.status, 'completed');
  assert.equal(response.provider, 'qwen');
  assert.equal(response.model, 'qwen-plus');
  assert.equal(response.parsed_json.title, 'Рыжий');
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /dashscope-intl/);
  assert.equal(calls[0].authorization, 'Bearer test-qwen-key');
});

test('мок: ошибка API не возвращает секрет', async () => {
  const { transport } = mockTransport(async () => {
    const error = new Error('HTTP 401');
    error.status = 401;
    error.body = { error: { message: 'bad key sk-live-secret-value' } };
    throw error;
  });
  const response = await createResponse(request(), { config, env, transport });
  assert.equal(response.status, 'failed');
  assert.equal(response.error.code, 'api_error');
  assert.equal(response.output.length, 0);
  assert.doesNotMatch(response.error.message, /sk-live/);
  assert.match(response.error.message, /sk-\[redacted\]/);
});

test('мок: выбранная модель недоступна', async () => {
  const { transport } = mockTransport(async () => {
    const error = new Error('HTTP 404');
    error.status = 404;
    error.body = { error: { code: 'model_not_found', message: 'qwen-plus missing' } };
    throw error;
  });
  const response = await createResponse(request(), { config, env, transport });
  assert.equal(response.error.code, 'model_unavailable');
  assert.equal(response.parsed_json, null);
});

test('мок: некорректный JSON не считается готовым ответом', async () => {
  const { transport } = mockTransport(async () => ({
    choices: [{ message: { content: 'Извините, я не могу вернуть JSON.' } }]
  }));
  const response = await createResponse(request(), { config, env, transport });
  assert.equal(response.status, 'failed');
  assert.equal(response.error.code, 'invalid_json');
  assert.equal(response.output.length, 0);
});

test('мок: повтор при 503 и успех со второй попытки', async () => {
  const { transport, calls } = mockTransport(async (_args, attempt) => {
    if (attempt === 1) {
      const error = new Error('HTTP 503');
      error.status = 503;
      error.body = { error: { message: 'busy' } };
      throw error;
    }
    return { choices: [{ message: { content: '{"title":"Повтор","text":"ok"}' } }] };
  });
  const response = await createResponse(request(), { config, env, transport });
  assert.equal(calls.length, 2);
  assert.equal(response.status, 'completed');
  assert.equal(response.attempt, 2);
  assert.equal(response.parsed_json.title, 'Повтор');
});

test('тот же запрос уходит в OpenRouter при смене только алиаса модели', async () => {
  const { transport, calls } = mockTransport(async () => ({
    choices: [{ message: { content: '{"title":"OR","text":"ok"}' } }]
  }));
  const response = await createResponse(request({ model: 'knightcat-default' }), { config, env, transport });
  assert.equal(response.provider, 'openrouter');
  assert.equal(response.model, 'openai/gpt-4.1-mini');
  assert.match(calls[0].url, /openrouter\.ai/);
});

test('рабочий механизм /approve в MVP не изменён пилотом', () => {
  const workflow = readFileSync(new URL('../../n8n/workflows/knightcat-minimal-telegram.json', import.meta.url), 'utf8');
  const normalize = readFileSync(new URL('../../n8n/vk/nodes/normalize.js', import.meta.url), 'utf8');
  const pending = readFileSync(new URL('../../n8n/vk/nodes/load-pending.js', import.meta.url), 'utf8');
  assert.match(workflow, /Generate with OpenRouter/);
  assert.match(workflow, /openrouter\.ai\/api\/v1\/chat\/completions/);
  assert.match(normalize, /\/approve/);
  assert.match(normalize, /\/reject/);
  assert.match(pending, /Черновик не найден/);
  assert.match(pending, /approval_valid/);
});
