import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Avatar, Banner, Button, Select, Spin } from '@douyinfe/semi-ui';
import { Link } from 'react-router';
import { ChatCompletionSchema } from '@repo/contracts';
import type { ChatCompletionResponse, ChatImage } from '@repo/contracts';
import { ApiError, listChatModels, streamChat } from '../../services/api';
import type { ChatMessage, ChatModel, User } from '../../services/api';
import Icon from '../../components/common/Icon';
import ModelSettings from '../../components/chat/ModelSettings';
import ContextUsage from '../../components/chat/ContextUsage';
import ChatDebugPanel from '../../components/chat/ChatDebugPanel';
import ChatImages, { ImagePreviews } from '../../components/chat/ChatImages';
import type { DebugRun } from '../../components/chat/ChatDebugPanel';
import { initialOf } from '../../utils/user-format';
import ChatTimings from '../../components/chat/ChatTimings';
import type { DisplayTiming } from '../../components/chat/ChatTimings';

interface Props {
  user: User;
  pending: 'refresh' | 'logout' | null;
  sessionError: string;
  onLogout: () => void;
  onSessionExpired: () => void;
}

interface DisplayMessage extends ChatMessage {
  id: string;
  modelName?: string;
  reasoning?: string;
  sources?: ChatCompletionResponse['sources'];
  searchWarning?: string;
  usage?: ChatCompletionResponse['usage'];
  contextUsage?: ChatCompletionResponse['contextUsage'];
  timing?: DisplayTiming;
  incomplete?: boolean;
  historyEligible?: boolean;
}

export default function ChatPage({
  user,
  pending,
  sessionError,
  onLogout,
  onSessionExpired,
}: Props) {
  const [models, setModels] = useState<ChatModel[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [reload, setReload] = useState(0);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [debugOpen, setDebugOpen] = useState(false);
  const [debugRuns, setDebugRuns] = useState<DebugRun[]>([]);
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [images, setImages] = useState<ChatImage[]>([]);
  const [imagesBusy, setImagesBusy] = useState(false);
  const [sending, setSending] = useState(false);
  const [pendingMessage, setPendingMessage] = useState<ChatMessage | null>(null);
  const [pendingAnswer, setPendingAnswer] = useState<DisplayMessage | null>(null);
  const answerRef = useRef<DisplayMessage | null>(null);
  const userMessageRef = useRef<ChatMessage | null>(null);
  const [error, setError] = useState('');
  const requestRef = useRef<AbortController | null>(null);
  const debugRunRef = useRef<string | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);
  const followRef = useRef(true);
  const selected = models.find((model) => model.id === selectedId) ?? models[0];

  useEffect(() => {
    const controller = new AbortController();
    void listChatModels(controller.signal)
      .then((items) => {
        if (!controller.signal.aborted) {
          setModels(items);
          setSelectedId((current) =>
            items.some((item) => item.id === current) ? current : (items[0]?.id ?? ''),
          );
          setLoading(false);
        }
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setLoading(false);
          if (error instanceof ApiError && error.status === 401) onSessionExpired();
          else setLoadError(error instanceof Error ? error.message : '模型列表加载失败');
        }
      });
    return () => controller.abort();
  }, [onSessionExpired, reload]);

  useEffect(() => () => requestRef.current?.abort(), []);
  useEffect(() => {
    if (followRef.current) endRef.current?.scrollIntoView({ block: 'end' });
  }, [messages, sending, pendingAnswer]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const started = performance.now();
    if (
      requestRef.current ||
      imagesBusy ||
      (!draft.trim() && !images.length) ||
      !selected ||
      loading ||
      loadError
    )
      return;
    const content = draft.trim();
    const userMessage: ChatMessage = {
      role: 'user',
      content,
      ...(images.length ? { images } : {}),
    };
    const history: ChatMessage[] = [
      ...messages
        .filter((message) => message.historyEligible !== false)
        .map(({ role, content, images }) => ({
          role,
          content,
          ...(images ? { images } : {}),
        })),
      userMessage,
    ];
    const input = ChatCompletionSchema.safeParse({
      modelId: selected.id,
      messages: history,
      webSearch: true,
      debug: true,
    });
    if (!input.success) {
      setError(input.error.issues[0]?.message ?? '对话过长，请开始新对话');
      return;
    }
    const controller = new AbortController();
    const debugId = crypto.randomUUID();
    debugRunRef.current = debugId;
    setDebugRuns((current) =>
      [
        ...current,
        {
          id: debugId,
          modelName: selected.name,
          prompt: content || `图片提问（${images.length} 张）`,
          startedAt: new Date().toISOString(),
          status: 'pending' as const,
          history,
        },
      ].slice(-30),
    );
    requestRef.current = controller;
    followRef.current = true;
    let currentRound = 1;
    const partial: DisplayMessage = {
      id: crypto.randomUUID(),
      role: 'assistant',
      content: '',
      modelName: selected.name,
      timing: {
        started,
        received: started,
        firstResponseMs: null,
        totalMs: null,
        server: { elapsedMs: 0, firstResponseMs: null, phase: 'waiting', thoughts: [], tools: [] },
      },
    };
    answerRef.current = partial;
    userMessageRef.current = userMessage;
    setPendingAnswer(partial);
    setSending(true);
    setPendingMessage(userMessage);
    setError('');
    try {
      const completed = await streamChat(input.data, controller.signal, (event) => {
        if (controller.signal.aborted || requestRef.current !== controller) return;
        const current = answerRef.current;
        if (!current?.timing) return;
        const now = performance.now();
        const next = { ...current, timing: { ...current.timing } };
        if (event.type === 'delta') {
          if (event.reasoning || event.content || event.toolCall) {
            next.timing.firstResponseMs ??= now - started;
          }
          if (event.round !== currentRound) {
            next.content = '';
            if (next.reasoning) next.reasoning += '\n\n';
            currentRound = event.round;
          }
          next.content += event.content ?? '';
          next.reasoning = (next.reasoning ?? '') + (event.reasoning ?? '');
        } else {
          next.timing.server = event.timing;
          next.timing.received = now;
          if (event.type === 'done' || event.type === 'error') next.timing.totalMs = now - started;
        }
        answerRef.current = next;
        setPendingAnswer(next);
      });
      const answer = completed.answer;
      const finalTiming = answerRef.current?.timing;
      if (!controller.signal.aborted && requestRef.current === controller) {
        setDebugRuns((current) =>
          current.map((run) =>
            run.id === debugId
              ? { ...run, status: 'success', ...(answer.debug ? { trace: answer.debug } : {}) }
              : run,
          ),
        );
        setMessages((current) => [
          ...current,
          { id: crypto.randomUUID(), ...userMessage },
          {
            id: crypto.randomUUID(),
            role: 'assistant',
            content: answer.content,
            modelName: selected.name,
            ...(finalTiming ? { timing: finalTiming } : {}),
            ...(answer.usage ? { usage: answer.usage } : {}),
            ...(answer.contextUsage ? { contextUsage: answer.contextUsage } : {}),
            ...(answer.reasoning ? { reasoning: answer.reasoning } : {}),
            ...(answer.sources ? { sources: answer.sources } : {}),
            ...(answer.searchWarning ? { searchWarning: answer.searchWarning } : {}),
          },
        ]);
        setDraft('');
        setImages([]);
      }
    } catch (error: unknown) {
      if (!controller.signal.aborted && requestRef.current === controller) {
        retainIncomplete();
        setDebugRuns((current) =>
          current.map((run) =>
            run.id === debugId
              ? {
                  ...run,
                  status: 'error',
                  error: error instanceof Error ? error.message : '发送失败',
                  ...(error instanceof ApiError && error.debug ? { trace: error.debug } : {}),
                }
              : run,
          ),
        );
        if (error instanceof ApiError && error.status === 401) onSessionExpired();
        else {
          setError(error instanceof Error ? error.message : '发送失败，请重试');
          if (error instanceof ApiError && error.status === 404) {
            setLoading(true);
            setLoadError('');
            setReload((value) => value + 1);
          }
        }
      }
    } finally {
      if (requestRef.current === controller) {
        requestRef.current = null;
        debugRunRef.current = null;
        setSending(false);
        setPendingMessage(null);
        setPendingAnswer(null);
        answerRef.current = null;
        userMessageRef.current = null;
      }
    }
  }

  function retainIncomplete() {
    const answer = answerRef.current;
    const question = userMessageRef.current;
    if (!answer || !question) return;
    const now = performance.now();
    const timing = answer.timing;
    const elapsedMs =
      timing && timing.totalMs === null
        ? timing.server.elapsedMs + Math.max(0, now - timing.received)
        : (timing?.server.elapsedMs ?? 0);
    setMessages((current) => [
      ...current,
      { id: crypto.randomUUID(), ...question, historyEligible: false },
      {
        ...answer,
        incomplete: true,
        historyEligible: false,
        ...(timing
          ? {
              timing: {
                ...timing,
                totalMs: timing.totalMs ?? now - timing.started,
                server: {
                  ...timing.server,
                  elapsedMs,
                  phase: 'done',
                  thoughts: timing.server.thoughts.map((span) => ({
                    ...span,
                    endMs: span.endMs ?? elapsedMs,
                  })),
                  tools: timing.server.tools.map((span) => ({
                    ...span,
                    endMs: span.endMs ?? elapsedMs,
                  })),
                },
              },
            }
          : {}),
      },
    ]);
  }

  function stop() {
    retainIncomplete();
    const debugId = debugRunRef.current;
    setDebugRuns((current) =>
      current.map((run) =>
        run.id === debugId
          ? { ...run, status: 'cancelled', error: '用户停止生成，未收到完整的服务端调用记录' }
          : run,
      ),
    );
    debugRunRef.current = null;
    requestRef.current?.abort();
    requestRef.current = null;
    setSending(false);
    setPendingMessage(null);
    setPendingAnswer(null);
    answerRef.current = null;
    userMessageRef.current = null;
  }

  return (
    <div className="flex h-dvh flex-col bg-canvas">
      <header className="flex h-20 shrink-0 items-center justify-between gap-3 border-b border-line bg-surface px-4 sm:px-8">
        <div className="flex items-center gap-4">
          <Link to="/" className="flex items-center gap-2 font-semibold text-inherit no-underline">
            <Icon name="layers" />
            <span className="hidden sm:inline">Demo Console</span>
          </Link>
          <nav aria-label="主导航" className="flex gap-1">
            <Link
              to="/users"
              className="rounded-lg px-3 py-2 text-sm text-muted no-underline hover:bg-canvas"
            >
              用户管理
            </Link>
            <Link
              to="/chat"
              aria-current="page"
              className="rounded-lg bg-indigo-50 px-3 py-2 text-sm font-medium text-indigo-600 no-underline"
            >
              Chat
            </Link>
          </nav>
        </div>
        <div className="flex items-center gap-2">
          <Avatar color="purple" size="small">
            {initialOf(user.name)}
          </Avatar>
          <Button
            theme="borderless"
            aria-label="退出登录"
            icon={<Icon name="logout" />}
            loading={pending === 'logout'}
            disabled={pending !== null}
            onClick={onLogout}
          />
        </div>
      </header>
      <main className="relative mx-auto flex min-h-0 w-full max-w-5xl flex-1 flex-col px-4 sm:px-8">
        <div className="flex shrink-0 items-center justify-end gap-1 py-5">
          <Button
            icon={<Icon name="debug" />}
            aria-label="打开调试面板"
            aria-expanded={debugOpen}
            onClick={() => setDebugOpen(true)}
          />
          <Button
            theme="borderless"
            icon={<Icon name="settings" />}
            aria-label="打开模型配置"
            aria-expanded={settingsOpen}
            onClick={() => setSettingsOpen(true)}
          />
        </div>
        {(sessionError || loadError) && (
          <div role="alert" className="mt-4">
            <Banner type="danger" description={sessionError || loadError} closeIcon={null} />
            {loadError && (
              <Button
                className="mt-2"
                onClick={() => {
                  setLoading(true);
                  setLoadError('');
                  setReload((value) => value + 1);
                }}
              >
                重新加载模型
              </Button>
            )}
          </div>
        )}
        <div
          className="min-h-0 flex-1 overflow-y-auto py-6"
          role="log"
          aria-label="对话记录"
          aria-live="polite"
          aria-busy={sending}
          onScroll={(event) => {
            const element = event.currentTarget;
            followRef.current =
              element.scrollHeight - element.scrollTop - element.clientHeight < 80;
          }}
        >
          {loading ? (
            <div className="flex h-full items-center justify-center">
              <Spin aria-label="加载模型" />
            </div>
          ) : messages.length === 0 && !sending ? (
            <div className="flex h-full flex-col items-center justify-center px-4 text-center">
              <span className="mb-5 rounded-2xl bg-indigo-50 p-4 text-indigo-500">
                <Icon name="chat" />
              </span>
              <p className="max-w-md text-sm leading-6 text-muted">
                {models.length
                  ? '提一个问题、梳理一个想法，或让 AI 帮你完成一项工作。'
                  : '点击右侧配置图标，填写模型 API 地址和密钥，保存后即可开始对话。'}
              </p>
            </div>
          ) : (
            <div className="space-y-6">
              {messages.map((message) => (
                <Message key={message.id} message={message} userName={user.name} />
              ))}
              {sending && pendingMessage && (
                <>
                  <Message message={{ id: 'pending', ...pendingMessage }} userName={user.name} />
                  {pendingAnswer && <Message message={pendingAnswer} userName={user.name} />}
                </>
              )}
              <div ref={endRef} />
            </div>
          )}
        </div>
        <div className="shrink-0 pb-4">
          {error && (
            <div role="alert" className="mb-3">
              <Banner type="danger" description={error} closeIcon={null} />
            </div>
          )}
          <form
            onSubmit={(event) => void submit(event)}
            className="rounded-2xl border border-line bg-surface p-4 shadow-sm"
          >
            <div className="mb-3 flex items-center justify-between gap-3">
              <div className="min-w-0 flex-1">
                <label id="chat-model-label" htmlFor="chat-model" className="sr-only">
                  对话模型
                </label>
                <Select
                  id="chat-model"
                  aria-labelledby="chat-model-label"
                  className="w-full sm:w-64"
                  value={selected?.id}
                  placeholder="请先配置模型"
                  disabled={loading || sending || !!loadError || !models.length}
                  optionList={models.map((item) => ({ value: item.id, label: item.name }))}
                  onChange={(value) => {
                    if (typeof value === 'string') setSelectedId(value);
                  }}
                />
              </div>
            </div>
            <textarea
              aria-label="消息内容"
              className="block w-full resize-none bg-transparent text-sm leading-6 outline-none disabled:opacity-50"
              rows={3}
              maxLength={16000}
              placeholder={
                models.length ? '输入消息，或添加图片让模型识别…' : '配置模型后即可发送消息'
              }
              value={draft}
              disabled={sending || loading || !models.length || !!loadError}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  event.currentTarget.form?.requestSubmit();
                }
              }}
            />
            <ChatImages
              images={images}
              disabled={sending || loading || !models.length || !!loadError}
              onChange={setImages}
              onError={setError}
              onBusyChange={setImagesBusy}
            >
              {sending ? (
                <Button onClick={stop}>停止生成</Button>
              ) : (
                <Button
                  htmlType="submit"
                  theme="solid"
                  icon={<Icon name="arrow-right" />}
                  aria-label="发送"
                  disabled={
                    loading ||
                    imagesBusy ||
                    !!loadError ||
                    !selected ||
                    (!draft.trim() && !images.length)
                  }
                />
              )}
            </ChatImages>
          </form>
          <p className="mt-3 text-center text-xs text-muted">
            对话仅保留在当前页面。AI 回复请自行核实。
          </p>
        </div>
      </main>
      <ModelSettings
        models={models}
        visible={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onSessionExpired={onSessionExpired}
        onSaved={(saved) => {
          setModels((current) => {
            const next = current.some((item) => item.id === saved.id)
              ? current.map((item) => (item.id === saved.id ? saved : item))
              : [...current, saved];
            return next.sort(
              (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
            );
          });
          setSelectedId((current) => current || saved.id);
        }}
        onDeleted={(id) => {
          setModels((current) => current.filter((item) => item.id !== id));
        }}
      />
      <ChatDebugPanel visible={debugOpen} runs={debugRuns} onClose={() => setDebugOpen(false)} />
    </div>
  );
}

function Message({ message, userName }: { message: DisplayMessage; userName: string }) {
  const own = message.role === 'user';
  return (
    <article className={`flex ${own ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-[90%] rounded-2xl px-5 py-4 sm:max-w-[85%] ${own ? 'bg-indigo-50' : 'border border-line bg-surface'}`}
      >
        <p className="mb-2 text-xs font-medium text-muted">{own ? userName : message.modelName}</p>
        {!!message.images?.length && <ImagePreviews images={message.images} />}
        {!own && message.reasoning && (
          <details open className="mb-4 rounded-xl border border-line bg-canvas px-4 py-3">
            <summary className="cursor-pointer text-sm font-medium text-muted">模型思考</summary>
            <p className="mt-3 whitespace-pre-wrap break-words text-sm leading-7 text-muted">
              {message.reasoning}
            </p>
          </details>
        )}
        <p className="whitespace-pre-wrap break-words text-sm leading-7">{message.content}</p>
        {!own && message.searchWarning && (
          <p role="status" className="mt-3 text-xs text-amber-700">
            {message.searchWarning}
          </p>
        )}
        {!own && !!message.sources?.length && (
          <div className="mt-4 border-t border-line pt-3">
            <p className="mb-2 text-xs font-medium text-muted">参考来源</p>
            <ol className="list-inside list-decimal space-y-1 text-xs">
              {message.sources.map((source) => (
                <li key={source.url}>
                  <a
                    className="break-words text-indigo-600 hover:underline"
                    href={source.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    referrerPolicy="no-referrer"
                  >
                    {source.title}
                  </a>
                </li>
              ))}
            </ol>
          </div>
        )}
        {!own && !message.incomplete && (!message.timing || message.timing.totalMs !== null) && (
          <ContextUsage usage={message.usage} contextUsage={message.contextUsage} />
        )}
        {!own && message.incomplete && (
          <p className="mt-3 text-xs text-amber-700">
            回复未完成（已停止或连接中断），可重新发送。
          </p>
        )}
        {!own && message.timing && <ChatTimings timing={message.timing} />}
      </div>
    </article>
  );
}
