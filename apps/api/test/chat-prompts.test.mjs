import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  mainSystemPrompt,
  researchSystemPrompt,
} from '../.test-dist/chat/prompts/agent-prompts.js';
import { promptText, toolPrompt } from '../.test-dist/chat/prompts/prompt-store.js';
import { researchAgentLimits } from '../.test-dist/chat/agents/agent-limits.js';

const require = createRequire(import.meta.url);
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'chat-prompts-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  cpSync(new URL('../.test-dist/chat/prompts/', import.meta.url), directory, { recursive: true });
  return { directory, store: require(join(directory, 'prompt-store.js')) };
}

test('compiled prompts load outside the workspace and inject the current execution context', () => {
  const modulePath = fileURLToPath(
    new URL('../.test-dist/chat/prompts/agent-prompts.js', import.meta.url),
  );
  const result = execFileSync(
    process.execPath,
    ['-e', 'process.stdout.write(require(process.argv[1]).mainSystemPrompt())', modulePath],
    { cwd: tmpdir(), encoding: 'utf8' },
  );
  assert.match(result, /你是负责完成用户任务的主 Agent/);
  assert.match(result, /当前服务器 UTC 时间：\d{4}-\d{2}-\d{2}T/);
  assert.equal(result.includes('{{'), false);
  assert.match(mainSystemPrompt(), /整个请求最多 2 次委派/);
  const research = researchSystemPrompt(6, 1000);
  assert.ok(research.includes(`${researchAgentLimits.turns} 轮推理`));
  assert.ok(research.includes(`${researchAgentLimits.calls} 次工具调用`));
  assert.ok(research.includes('6 至 1000 字符'));
  assert.ok(research.includes('```json'));
});

test('template values are literal and missing or unused variables fail clearly', () => {
  const message = '包含 $& 和 {{currentTime}} 的错误';
  assert.ok(promptText('invalid-final', { message }).startsWith(message));
  assert.throws(() => promptText('invalid-final'), /缺少变量：message/);
  assert.throws(() => promptText('invalid-final', { message, typo: 'wrong' }), /未使用变量：typo/);
  assert.ok(promptText('research-recovery').includes('"findings":['));
});

test('tool Markdown keeps paragraphs but excludes document and section headings', () => {
  const search = toolPrompt('web_search');
  assert.equal(search.includes('#'), false);
  assert.ok(search.includes('不读取正文'));
  assert.ok(toolPrompt('web_search', 'url').includes('完整的 HTTP/HTTPS'));
  for (const name of ['research', 'web_search', 'web_fetch', 'research_report'])
    assert.ok(toolPrompt(name).length > 0);
  assert.match(researchSystemPrompt(6, 1000), /调用 web_search\(\{ url \}\) 搜索候选来源/);
});

test('missing assets never fall back to source prompts', (t) => {
  const { directory, store } = fixture(t);
  rmSync(join(directory, 'agents/main.md'));
  assert.throws(() => store.promptText('main', { currentTime: 'now', maxDelegations: 2 }), {
    code: 'ENOENT',
  });
});

test('tool descriptions reject missing, empty and duplicate sections', (t) => {
  for (const content of [
    '# research\n\n## description\n\n说明',
    '# research\n\n## description\n\n## task\n\n任务',
    '# research\n\n## description\n\n说明\n\n## description\n\n重复\n\n## task\n\n任务',
  ]) {
    const { directory, store } = fixture(t);
    writeFileSync(join(directory, 'tools/research.md'), content);
    assert.throws(() => store.toolPrompt('research'), /章节/);
  }
});
