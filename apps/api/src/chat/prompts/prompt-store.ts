import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const templates = {
  main: 'agents/main.md',
  research: 'agents/research.md',
  'invalid-final': 'runtime/invalid-final.md',
  'research-recovery': 'runtime/research-recovery.md',
  'report-repair': 'runtime/report-repair.md',
} as const;

const toolSections = {
  research: ['description', 'task'],
  web_search: ['description', 'url'],
  web_fetch: ['description', 'url'],
  research_report: ['description'],
} as const;

export type PromptToolName = keyof typeof toolSections;
const files = new Map<string, string>();
const sections = new Map<string, ReadonlyMap<string, string>>();

function readPromptFile(path: string): string {
  const cached = files.get(path);
  if (cached !== undefined) return cached;
  const text = readFileSync(join(__dirname, path), 'utf8').trim();
  if (!text) throw new Error(`提示词文件为空：${path}`);
  files.set(path, text);
  return text;
}

// Only replaces named values; Markdown and JSON examples remain ordinary text.
export function promptText(
  name: keyof typeof templates,
  values: Readonly<Record<string, string | number>> = {},
): string {
  const used = new Set<string>();
  const text = readPromptFile(templates[name]).replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
    if (!Object.hasOwn(values, key)) throw new Error(`提示词 ${name} 缺少变量：${key}`);
    used.add(key);
    return String(values[key]);
  });
  for (const key of Object.keys(values))
    if (!used.has(key)) throw new Error(`提示词 ${name} 未使用变量：${key}`);
  return text;
}

export function toolPrompt<Name extends PromptToolName>(
  name: Name,
  section: (typeof toolSections)[Name][number] = 'description',
): string {
  const path = `tools/${name}.md`;
  let document = sections.get(path);
  if (!document) {
    const parsed = new Map<string, string>();
    const parts = readPromptFile(path).split(/^## ([\w-]+)\s*$/m);
    for (let index = 1; index < parts.length; index += 2) {
      const key = parts[index]!;
      const value = parts[index + 1]?.trim();
      if (!value || parsed.has(key)) throw new Error(`工具提示词章节为空或重复：${path}#${key}`);
      parsed.set(key, value);
    }
    for (const expected of toolSections[name])
      if (!parsed.has(expected)) throw new Error(`工具提示词缺少章节：${path}#${expected}`);
    document = parsed;
    sections.set(path, document);
  }
  const text = document.get(section);
  if (text === undefined) throw new Error(`工具提示词缺少章节：${path}#${section}`);
  return text;
}
