import { useEffect, useState } from 'react';
import type { ChatTiming } from '@repo/contracts';

export interface DisplayTiming {
  server: ChatTiming;
  started: number;
  received: number;
  firstResponseMs: number | null;
  totalMs: number | null;
}
const seconds = (ms: number) => `${(ms / 1000).toFixed(2)}s`;
const phases = {
  waiting: '等待模型响应',
  thinking: '模型思考中',
  answering: '回复生成中',
  tool: '工具执行中',
  finishing: '整理回复',
  done: '已结束',
};
const toolLabels: Record<string, string> = {
  research: '资料查证',
  web_search: '联网搜索',
  web_fetch: '网页读取',
};
const toolStatuses: Record<string, string> = {
  research: '正在查证资料',
  web_search: '正在搜索',
  web_fetch: '正在读取网页',
};
export default function ChatTimings({ timing }: { timing: DisplayTiming }) {
  const [now, setNow] = useState(() => performance.now());
  useEffect(() => {
    if (timing.totalMs !== null) return;
    const interval = setInterval(() => setNow(performance.now()), 100);
    return () => clearInterval(interval);
  }, [timing.totalMs]);
  const current =
    timing.totalMs === null
      ? timing.server.elapsedMs + Math.max(0, now - timing.received)
      : timing.server.elapsedMs;
  const spanTime = (span: { startMs: number; endMs: number | null }) =>
    seconds(Math.max(0, (span.endMs ?? current) - span.startMs));
  const activeTool = [...timing.server.tools].reverse().find((span) => span.endMs === null);
  const status =
    timing.server.phase === 'tool' && activeTool
      ? (toolStatuses[activeTool.name] ?? phases.tool)
      : phases[timing.server.phase];
  return (
    <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 border-t border-line pt-3 text-xs text-muted">
      {timing.totalMs === null && <span role="status">{status}</span>}
      <span>
        首响应：{timing.firstResponseMs === null ? '等待中' : seconds(timing.firstResponseMs)}
      </span>
      {timing.server.thoughts.length === 0 && <span>思考：未输出思考内容</span>}
      {timing.server.thoughts.map((span, index) => (
        <span key={index}>
          思考 {index + 1}（第 {span.round} 轮）：{spanTime(span)}
        </span>
      ))}
      {timing.server.tools.length === 0 && <span>工具：未调用</span>}
      {timing.server.tools.map((span, index) => (
        <span key={index}>
          工具 {index + 1} · {toolLabels[span.name] ?? span.name}：{spanTime(span)}
        </span>
      ))}
      <span>总耗时：{seconds(timing.totalMs ?? Math.max(0, now - timing.started))}</span>
    </div>
  );
}
