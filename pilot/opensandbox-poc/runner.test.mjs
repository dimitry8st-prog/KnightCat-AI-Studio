import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { assertCleaned, runComponent } from './runner.mjs';

const widget = readFileSync(new URL('./fixtures/widget.js', import.meta.url), 'utf8');

test('безопасный HTML/CSS/JS-компонент выполняется и среда удаляется', async () => {
  const outcome = await runComponent(widget);
  assert.equal(outcome.ok, true);
  const parsed = JSON.parse(outcome.output);
  assert.match(parsed.html, /<article/);
  assert.match(parsed.css, /\.card/);
  assert.equal(await assertCleaned(outcome.directory), true);
});

test('чтение секретов, сеть и файловый доступ блокируются до запуска', async () => {
  const samples = [
    'result = process.env.OPENROUTER_API_KEY;',
    'result = fetch("https://example.test");',
    'result = require("fs").readFileSync("/etc/passwd");'
  ];
  for (const source of samples) {
    const outcome = await runComponent(source);
    assert.equal(outcome.ok, false);
    assert.equal(outcome.code, 'blocked');
  }
});

test('бесконечный цикл останавливается по лимиту времени', async () => {
  const outcome = await runComponent('while (true) {}');
  assert.equal(outcome.ok, false);
  assert.equal(outcome.code, 'timeout');
});
