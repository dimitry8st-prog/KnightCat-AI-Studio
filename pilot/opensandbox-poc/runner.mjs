import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { pathToFileURL } from 'node:url';

const policyUrl = new URL('./policy.json', import.meta.url);

export async function loadPolicy() {
  return JSON.parse(await readFile(policyUrl, 'utf8'));
}

export async function runComponent(source, options = {}) {
  const policy = options.policy || await loadPolicy();
  const dir = await mkdtemp(path.join(tmpdir(), 'knightcat-sandbox-'));
  try {
    const blocked = inspect(source, policy);
    if (blocked) {
      return { ok: false, code: 'blocked', message: blocked, cleanup: true };
    }
    await writeFile(path.join(dir, 'component.js'), source, { encoding: 'utf8', flag: 'wx' });
    const output = execute(source, policy);
    const clipped = output.slice(0, policy.limits.max_output_chars);
    return { ok: true, code: 'completed', output: clipped, cleanup: true, directory: dir };
  } catch (error) {
    const code = error.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT' ? 'timeout' : 'blocked';
    return { ok: false, code, message: 'Выполнение остановлено политикой песочницы.', cleanup: true };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function inspect(source, policy) {
  if (typeof source !== 'string' || !source.trim()) return 'Пустой код.';
  if (Buffer.byteLength(source) > policy.limits.max_source_bytes) return 'Код превышает лимит размера.';
  const hit = policy.denied_patterns.find((pattern) => source.includes(pattern));
  return hit ? `Запрещённая конструкция: ${hit}` : null;
}

function execute(source, policy) {
  const context = vm.createContext({
    result: null,
    Math,
    JSON,
    String,
    Number,
    Array,
    Object
  });
  const script = new vm.Script(`${source}\n;JSON.stringify(result);`);
  return script.runInContext(context, { timeout: policy.limits.timeout_ms });
}

export async function assertCleaned(directory) {
  try {
    await readFile(path.join(directory, 'component.js'));
    return false;
  } catch {
    return true;
  }
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  const sample = await readFile(new URL('./fixtures/widget.js', import.meta.url), 'utf8');
  const outcome = await runComponent(sample);
  console.log(JSON.stringify({ ok: outcome.ok, code: outcome.code }));
}
