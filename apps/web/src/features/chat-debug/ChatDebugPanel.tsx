import { useEffect, useState } from 'react';
import { Button, SideSheet } from '@douyinfe/semi-ui';
import { readChatDebug } from './api';
import type { ChatDebugEvent, ChatDebugTrace, ChatMessage, ChatWebRequest } from '@repo/contracts';

export interface DebugRun {
  id: string;
  modelName: string;
  prompt: string;
  startedAt: string;
  status: 'pending' | 'success' | 'error' | 'cancelled';
  history: ChatMessage[];
  error?: string;
}

const statuses = { pending: '执行中', success: '完成', error: '失败', cancelled: '已停止' };
const roles = {
  system: '系统 prompt',
  user: '用户 prompt',
  assistant: '历史模型回复',
  tool: '工具结果',
};

export default function ChatDebugPanel({
  visible,
  runs,
  onClose,
}: {
  visible: boolean;
  runs: DebugRun[];
  onClose: () => void;
}) {
  const [selectedId, setSelectedId] = useState('');
  const selected = runs.find((run) => run.id === selectedId) ?? runs.at(-1);
  const [record, setRecord] = useState<{ id: string; trace?: ChatDebugTrace; error?: string }>();
  const [reload, setReload] = useState(0);
  const requestId = selected?.id;
  const status = selected?.status;
  useEffect(() => {
    if (!visible || !requestId || status === 'pending') return;
    const controller = new AbortController();
    void (async () => {
      try {
        const trace = await readChatDebug(requestId, controller.signal);
        if (!controller.signal.aborted) setRecord({ id: requestId, trace });
      } catch (error) {
        if (!controller.signal.aborted)
          setRecord({
            id: requestId,
            error: error instanceof Error ? error.message : '调试记录读取失败',
          });
      }
    })();
    return () => controller.abort();
  }, [visible, requestId, status, reload]);
  const trace = record && record.id === requestId ? record.trace : undefined;
  const loadError = record && record.id === requestId ? record.error : undefined;
  return (
    <SideSheet
      title="Chat 调试"
      placement="right"
      visible={visible}
      motion={false}
      width="min(780px, 100vw)"
      onCancel={onClose}
    >
      <div className="space-y-5">
        <p className="text-xs leading-5 text-muted">
          记录当前页面最近 30 次请求，包含重试和失败。调试记录独立读取，服务端最多保留 30
          分钟，刷新页面后清空。
        </p>
        {!runs.length ? (
          <p className="rounded-xl border border-line bg-canvas p-5 text-sm text-muted">
            暂无调用记录，发送一条消息后可查看调用过程。
          </p>
        ) : (
          <>
            <label className="block text-sm font-medium">
              请求历史
              <select
                aria-label="选择调试请求"
                className="mt-2 w-full rounded-lg border border-line bg-surface p-3 text-sm"
                value={selected?.id ?? ''}
                onChange={(event) => setSelectedId(event.target.value)}
              >
                {[...runs].reverse().map((run) => (
                  <option key={run.id} value={run.id}>
                    {new Date(run.startedAt).toLocaleTimeString()} · {run.modelName} ·{' '}
                    {statuses[run.status]} · {run.prompt.slice(0, 50)}
                  </option>
                ))}
              </select>
            </label>
            {selected && (
              <div key={selected.id} className="space-y-4">
                <div className="rounded-xl border border-line bg-canvas p-4 text-xs leading-6">
                  <p className="font-medium">
                    {selected.modelName} · {statuses[selected.status]}
                  </p>
                  <p className="break-all text-muted">请求 ID：{selected.id}</p>
                  {trace && (
                    <>
                      <p className="text-muted">
                        模型：{trace.model.model} · 总耗时 {trace.durationMs} ms · 模型轮次{' '}
                        {trace.events.filter((event) => event.kind === 'model_request').length} ·
                        工具调用 {trace.events.filter((event) => event.kind === 'tool').length}
                      </p>
                      <p className="break-all text-muted">API 地址：{trace.model.baseUrl}</p>
                    </>
                  )}
                  {selected.error && <p className="break-words text-amber-700">{selected.error}</p>}
                  {loadError && (
                    <p role="status" className="text-amber-700">
                      {loadError}
                    </p>
                  )}
                  {trace?.truncated && (
                    <p className="text-amber-700">调试记录已达到采集上限，部分内容已省略。</p>
                  )}
                  {selected.status !== 'pending' && (
                    <Button size="small" onClick={() => setReload((value) => value + 1)}>
                      重新读取调试记录
                    </Button>
                  )}
                </div>
                {trace ? (
                  trace.events.map((event, index) => (
                    <DebugEvent key={index} event={event} index={index} />
                  ))
                ) : (
                  <div className="space-y-3">
                    <p className="text-sm font-medium">浏览器 → 服务端：提交的对话历史</p>
                    {selected.history.map((message, index) => (
                      <Detail
                        key={index}
                        title={`${index + 1}. ${roles[message.role]}`}
                        content={message.content}
                        open
                      />
                    ))}
                    <p className="text-xs text-muted">
                      {selected.status === 'pending'
                        ? '请求结束后可独立读取服务端调用记录…'
                        : '调试记录独立读取，以上为浏览器提交的消息。'}
                    </p>
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </SideSheet>
  );
}

function DebugEvent({ event, index }: { event: ChatDebugEvent; index: number }) {
  const title = {
    model_request: '服务端 → 模型：发送消息',
    model_response: '模型 → 服务端：回复 / 工具调用',
    tool: '服务端 → 工具 → 服务端',
    error: '执行错误',
  }[event.kind];
  return (
    <section className="rounded-xl border border-line bg-surface p-4">
      <h3 className="text-sm font-semibold">
        {index + 1}. {title}
      </h3>
      <p className="mt-1 text-xs text-muted">
        {event.agent ? `${event.agent} · ` : ''}第 {event.round} 轮 ·
        {new Date(event.startedAt).toLocaleTimeString()}
        {event.parentToolCallId ? ` · 委派 ${event.parentToolCallId}` : ''}
        {event.kind !== 'model_request' && ` · ${event.durationMs} ms`}
      </p>
      {event.truncated && <p className="mt-2 text-xs text-amber-700">内容过长，部分文本已截断。</p>}
      <div className="mt-3 space-y-3">
        {event.kind === 'model_request' && (
          <>
            <p className="text-xs text-muted">
              tool_choice：{event.toolChoice ?? '未发送（普通聊天）'} · {event.messages.length}{' '}
              条消息
            </p>
            {event.messages.map((message, messageIndex) => (
              <div key={messageIndex} className="space-y-2">
                <Detail
                  title={`${messageIndex + 1}. ${roles[message.role]}`}
                  content={message.content ?? '(content: null)'}
                  open={message.role === 'system' || message.role === 'user'}
                />
                {message.toolCallId && (
                  <p className="break-all text-xs text-muted">tool_call_id：{message.toolCallId}</p>
                )}
                {message.toolCalls && (
                  <Detail
                    title="模型提出的工具调用"
                    content={JSON.stringify(message.toolCalls, null, 2)}
                  />
                )}
                {message.reasoning && (
                  <Detail title="随本轮传入的模型思考" content={message.reasoning} />
                )}
              </div>
            ))}
            <Detail title="本轮提供给模型的工具定义" content={event.tools} />
          </>
        )}
        {event.kind === 'model_response' && (
          <Detail title="模型响应消息（含思考与 tool_calls）" content={event.message} open />
        )}
        {event.kind === 'tool' && (
          <>
            <p className="break-all text-sm font-medium">{event.name}</p>
            <p className="break-all text-xs text-muted">tool_call_id：{event.toolCallId}</p>
            <Detail title="工具参数" content={event.arguments} open />
            {event.cacheHit && (
              <p className="text-xs text-muted">
                命中缓存，本次未发送网页请求；下方为首次请求的记录。
              </p>
            )}
            {event.webRequests?.map((request, requestIndex) => (
              <WebRequest key={requestIndex} request={request} index={requestIndex} />
            ))}
            <Detail title="工具返回结果（传回模型的内容）" content={event.result} open />
            {event.warning && <p className="text-xs text-amber-700">{event.warning}</p>}
          </>
        )}
        {event.kind === 'error' && (
          <p className="whitespace-pre-wrap break-words text-sm text-amber-700">{event.message}</p>
        )}
      </div>
    </section>
  );
}

function WebRequest({ request, index }: { request: ChatWebRequest; index: number }) {
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copied' | 'error'>('idle');
  async function copy() {
    try {
      await navigator.clipboard.writeText(request.curl);
      setCopyStatus('copied');
    } catch {
      setCopyStatus('error');
    }
  }
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-muted">
          网页请求 {index + 1} · {new Date(request.requestedAt).toLocaleTimeString()}
        </p>
        <Button size="small" onClick={() => void copy()}>
          {copyStatus === 'copied' ? '已复制 cURL' : '复制 cURL'}
        </Button>
      </div>
      <Detail title="网页请求 cURL" content={request.curl} />
      {copyStatus === 'error' && (
        <p role="status" className="text-xs text-amber-700">
          复制失败，请展开 cURL 后手动复制。
        </p>
      )}
    </div>
  );
}

function Detail({
  title,
  content,
  open = false,
}: {
  title: string;
  content: string;
  open?: boolean;
}) {
  return (
    <details open={open} className="rounded-lg border border-line bg-canvas p-3">
      <summary className="cursor-pointer text-xs font-medium">{title}</summary>
      <pre className="mt-3 whitespace-pre-wrap break-words font-mono text-xs leading-6">
        {content || '(空内容)'}
      </pre>
    </details>
  );
}
