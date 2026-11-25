import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Avatar, Banner, Button, Select, Spin } from '@douyinfe/semi-ui';
import { Link } from 'react-router';
import { ChatCompletionSchema } from '@repo/contracts';
import type { ChatImage } from '@repo/contracts';
import {
  ApiError,
  listChatModels,
  listChatHistory,
  readChatImage,
  chatResourceUrl,
  streamChat,
} from '../../services/api';
import type { ChatMessage, ChatModel, User } from '../../services/api';
import Icon from '../../components/common/Icon';
import ModelSettings from '../../components/chat/ModelSettings';
import ConversationSettings from '../../components/chat/ConversationSettings';
import ContextUsage from '../../components/chat/ContextUsage';
import DebugBoundary from '../../features/chat-debug/DebugBoundary';
import ChatImages, { ImagePreviews } from '../../components/chat/ChatImages';
import { initialOf } from '../../utils/user-format';
import ChatTimings from '../../components/chat/ChatTimings';
import ChatMarkdown from '../../components/chat/ChatMarkdown';
import { contextMessages, historyMessages } from './chat-history';
import type { DisplayMessage } from './chat-history';
import { loadChatSettings, saveChatSettings } from './chat-settings';

const ChatDebug =
  import.meta.env.VITE_CHAT_DEBUG_ENABLED === 'true' ||
  (import.meta.env.DEV && import.meta.env.VITE_CHAT_DEBUG_ENABLED !== 'false')
    ? lazy(() => import('../../features/chat-debug/ChatDebug'))
    : null;

interface Props {
  user: User;
  pending: 'refresh' | 'logout' | null;
  sessionError: string;
  onLogout: () => void;
  onSessionExpired: () => void;
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
  const [conversationSettingsOpen, setConversationSettingsOpen] = useState(false);
  const [chatSettings, setChatSettings] = useState(() => loadChatSettings(user.id));
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
  const conversationRef = useRef<string>(crypto.randomUUID());
  const previousHistoryRef = useRef<string | undefined>(undefined);
  const endRef = useRef<HTMLDivElement | null>(null);
  const followRef = useRef(true);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const restoreRef = useRef<{ id: string; offset: number } | null>(null);
  const scrollTopRef = useRef(0);
  const historyRequestRef = useRef<AbortController | null>(null);
  const cursorRef = useRef<string | null>(null);
  const [historyInitial, setHistoryInitial] = useState(true);
  const [historyMore, setHistoryMore] = useState(false);
  const [historyError, setHistoryError] = useState('');
  const [historyReady, setHistoryReady] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [historyReload, setHistoryReload] = useState(0);
  const liveStartedRef = useRef(false);
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

  useEffect(() => {
    const controller = new AbortController();
    historyRequestRef.current = controller;
    void listChatHistory(null, controller.signal)
      .then((page) => {
        if (controller.signal.aborted) return;
        const latest = page.items[0];
        if (latest && !liveStartedRef.current) {
          conversationRef.current = latest.conversationId;
          setSelectedId(latest.model.id);
          previousHistoryRef.current = page.items.find(
            (item) => item.conversationId === latest.conversationId && item.status === 'SUCCEEDED',
          )?.id;
        }
        cursorRef.current = page.nextCursor;
        setHasMore(!!page.nextCursor);
        setMessages((current) => {
          const seen = new Set(current.map((item) => item.historyId));
          return [...historyMessages(page.items.filter((item) => !seen.has(item.id))), ...current];
        });
        setHistoryReady(true);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        if (error instanceof ApiError && error.status === 401) onSessionExpired();
        else setHistoryError(error instanceof Error ? error.message : '历史记录加载失败');
      })
      .finally(() => {
        if (!controller.signal.aborted) setHistoryInitial(false);
        if (historyRequestRef.current === controller) historyRequestRef.current = null;
      });
    return () => {
      controller.abort();
      historyRequestRef.current?.abort();
    };
  }, [onSessionExpired, historyReload]);

  useEffect(() => () => requestRef.current?.abort(), []);
  useLayoutEffect(() => {
    const scroll = scrollRef.current;
    if (!scroll) return;
    const restore = restoreRef.current;
    if (restore) {
      const anchor = Array.from(scroll.querySelectorAll<HTMLElement>('[data-message-id]')).find(
        (element) => element.dataset['messageId'] === restore.id,
      );
      if (anchor)
        scroll.scrollTop +=
          anchor.getBoundingClientRect().top - scroll.getBoundingClientRect().top - restore.offset;
      restoreRef.current = null;
    } else if (followRef.current) {
      scroll.scrollTop = scroll.scrollHeight;
    }
    scrollTopRef.current = scroll.scrollTop;
  }, [messages, sending, pendingAnswer, loading, historyInitial]);

  async function loadOlder() {
    const cursor = cursorRef.current;
    if (!cursor || historyRequestRef.current || requestRef.current || historyInitial) return;
    const controller = new AbortController();
    historyRequestRef.current = controller;
    setHistoryMore(true);
    setHistoryError('');
    try {
      const page = await listChatHistory(cursor, controller.signal);
      if (controller.signal.aborted) return;
      const scroll = scrollRef.current;
      const top = scroll?.getBoundingClientRect().top ?? 0;
      const anchor =
        scroll &&
        Array.from(scroll.querySelectorAll<HTMLElement>('[data-message-id]')).find(
          (element) => element.getBoundingClientRect().bottom > top,
        );
      if (anchor)
        restoreRef.current = {
          id: anchor.dataset['messageId']!,
          offset: anchor.getBoundingClientRect().top - top,
        };
      followRef.current = false;
      cursorRef.current = page.nextCursor;
      setHasMore(!!page.nextCursor);
      setMessages((current) => {
        const seen = new Set(current.map((item) => item.historyId));
        return [...historyMessages(page.items.filter((item) => !seen.has(item.id))), ...current];
      });
    } catch (error) {
      if (controller.signal.aborted) return;
      if (error instanceof ApiError && error.status === 401) onSessionExpired();
      else setHistoryError(error instanceof Error ? error.message : '更早记录加载失败');
    } finally {
      if (!controller.signal.aborted) setHistoryMore(false);
      if (historyRequestRef.current === controller) historyRequestRef.current = null;
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const started = performance.now();
    if (
      requestRef.current ||
      historyRequestRef.current ||
      historyInitial ||
      imagesBusy ||
      (!draft.trim() && !images.length) ||
      !selected ||
      loading ||
      loadError
    )
      return;
    const content = draft.trim();
    liveStartedRef.current = true;
    const userMessage: ChatMessage = {
      role: 'user',
      content,
      ...(images.length ? { images } : {}),
    };
    const context = contextMessages(
      messages,
      conversationRef.current,
      userMessage,
      chatSettings.historyRounds,
    );
    const imageController = new AbortController();
    requestRef.current = imageController;
    setImagesBusy(true);
    let history: ChatMessage[];
    try {
      history = [];
      for (const message of context) {
        const restoredImages = [...(message.images ?? [])];
        for (const resource of message.historyImages ?? [])
          restoredImages.push(
            await readChatImage(
              resource.historyId,
              resource.id,
              resource.name,
              imageController.signal,
            ),
          );
        history.push({
          role: message.role,
          content: message.content,
          ...(restoredImages.length ? { images: restoredImages } : {}),
        });
      }
      history.push(userMessage);
    } catch (error) {
      if (!imageController.signal.aborted) {
        if (error instanceof ApiError && error.status === 401) onSessionExpired();
        else setError(error instanceof Error ? error.message : '历史图片读取失败');
      }
      return;
    } finally {
      if (requestRef.current === imageController) requestRef.current = null;
      setImagesBusy(false);
    }
    if (imageController.signal.aborted) return;
    const input = ChatCompletionSchema.safeParse({
      modelId: selected.id,
      requestId: crypto.randomUUID(),
      conversationId: conversationRef.current,
      previousHistoryId: previousHistoryRef.current,
      messages: history,
      webSearch: true,
    });
    if (!input.success) {
      setError(input.error.issues[0]?.message ?? '对话过长，请开始新对话');
      return;
    }
    const controller = new AbortController();
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
        previousHistoryRef.current = answer.historyId;
        setMessages((current) => [
          ...current,
          {
            id: crypto.randomUUID(),
            ...userMessage,
            ...(answer.historyId ? { historyId: answer.historyId } : {}),
            conversationId: conversationRef.current,
          },
          {
            id: crypto.randomUUID(),
            role: 'assistant',
            ...(answer.historyId ? { historyId: answer.historyId } : {}),
            conversationId: conversationRef.current,
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
            theme="borderless"
            icon={<Icon name="chat" />}
            aria-label="打开会话配置"
            title="会话配置"
            aria-expanded={conversationSettingsOpen}
            onClick={() => setConversationSettingsOpen(true)}
          />
          {ChatDebug && (
            <DebugBoundary>
              <Suspense fallback={null}>
                <ChatDebug models={models} />
              </Suspense>
            </DebugBoundary>
          )}
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
          ref={scrollRef}
          style={{ overflowAnchor: 'none' }}
          className="min-h-0 flex-1 overflow-y-auto py-6"
          role="log"
          aria-label="对话记录"
          aria-live="polite"
          aria-busy={sending || historyInitial || historyMore}
          onScroll={(event) => {
            const element = event.currentTarget;
            followRef.current =
              element.scrollHeight - element.scrollTop - element.clientHeight < 80;
            const upward = element.scrollTop < scrollTopRef.current;
            scrollTopRef.current = element.scrollTop;
            if (upward && element.scrollTop < 80 && !historyError) void loadOlder();
          }}
          onWheel={(event) => {
            if (event.deltaY < 0 && event.currentTarget.scrollTop < 80 && !historyError)
              void loadOlder();
          }}
        >
          {(historyReady || historyError) && (
            <div className="mb-4 flex min-h-8 items-center justify-center gap-2 text-xs text-muted">
              {historyMore ? (
                <Spin size="small" aria-label="加载更早记录" />
              ) : historyError ? (
                <>
                  <span role="alert">{historyError}</span>
                  <Button
                    size="small"
                    theme="borderless"
                    onClick={() => {
                      if (historyReady) void loadOlder();
                      else {
                        setHistoryInitial(true);
                        setHistoryError('');
                        setHistoryReload((value) => value + 1);
                      }
                    }}
                  >
                    重试
                  </Button>
                </>
              ) : hasMore ? (
                <Button
                  size="small"
                  theme="borderless"
                  disabled={sending}
                  onClick={() => void loadOlder()}
                >
                  向上滚动加载更早记录
                </Button>
              ) : messages.length > 0 ? (
                <span>已加载全部历史记录</span>
              ) : null}
            </div>
          )}
          {loading || historyInitial ? (
            <div className="flex h-full items-center justify-center">
              <Spin aria-label="加载对话" />
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
                  disabled={
                    loading ||
                    historyInitial ||
                    sending ||
                    imagesBusy ||
                    !!loadError ||
                    !models.length
                  }
                  optionList={models.map((item) => ({ value: item.id, label: item.name }))}
                  onChange={(value) => {
                    if (typeof value === 'string') setSelectedId(value);
                  }}
                />
              </div>
            </div>
            <ChatImages
              images={images}
              disabled={sending || loading || historyInitial || !models.length || !!loadError}
              onChange={setImages}
              onError={setError}
              onBusyChange={setImagesBusy}
              input={
                <textarea
                  aria-label="消息内容"
                  className="block w-full resize-none bg-transparent text-sm leading-6 outline-none disabled:opacity-50"
                  rows={3}
                  maxLength={16000}
                  placeholder={
                    models.length
                      ? '输入消息，或粘贴、添加图片让模型识别…'
                      : '配置模型后即可发送消息'
                  }
                  value={draft}
                  disabled={
                    sending ||
                    loading ||
                    historyInitial ||
                    imagesBusy ||
                    !models.length ||
                    !!loadError
                  }
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (
                      event.key === 'Enter' &&
                      !event.shiftKey &&
                      !event.nativeEvent.isComposing
                    ) {
                      event.preventDefault();
                      event.currentTarget.form?.requestSubmit();
                    }
                  }}
                />
              }
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
                    historyInitial ||
                    historyMore ||
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
            对话自动保存，可向上滚动查看历史。AI 回复请自行核实。
          </p>
        </div>
      </main>
      {conversationSettingsOpen && (
        <ConversationSettings
          settings={chatSettings}
          onClose={() => setConversationSettingsOpen(false)}
          onSave={(settings) => {
            setChatSettings(settings);
            return saveChatSettings(user.id, settings);
          }}
        />
      )}
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
    </div>
  );
}

function Message({ message, userName }: { message: DisplayMessage; userName: string }) {
  const own = message.role === 'user';
  return (
    <article
      data-message-id={message.id}
      className={`flex ${own ? 'justify-end' : 'justify-start'}`}
    >
      <div
        className={`min-w-0 max-w-[90%] rounded-2xl px-5 py-4 sm:max-w-[85%] ${own ? 'bg-indigo-50' : 'border border-line bg-surface'}`}
      >
        <p className="mb-2 text-xs font-medium text-muted">{own ? userName : message.modelName}</p>
        {!!message.images?.length && <ImagePreviews images={message.images} />}
        {!!message.historyImages?.length && (
          <div className="mb-3 flex flex-wrap gap-2">
            {message.historyImages.map((resource) => (
              <a
                key={resource.id}
                href={chatResourceUrl(resource.historyId, resource.id)}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={`查看图片 ${resource.name}`}
              >
                <img
                  src={chatResourceUrl(resource.historyId, resource.id)}
                  alt={resource.name}
                  className="h-48 w-64 max-w-full rounded-lg border border-line object-contain"
                />
              </a>
            ))}
          </div>
        )}
        {!own && message.reasoning && (
          <details open className="mb-4 rounded-xl border border-line bg-canvas px-4 py-3">
            <summary className="cursor-pointer text-sm font-medium text-muted">模型思考</summary>
            <div className="mt-3 text-muted">
              <ChatMarkdown content={message.reasoning} />
            </div>
          </details>
        )}
        {own ? (
          <p className="whitespace-pre-wrap break-words text-sm leading-7">{message.content}</p>
        ) : (
          <ChatMarkdown content={message.content} />
        )}
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
