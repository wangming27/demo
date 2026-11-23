import {
  apiContract,
  ChatDebugTraceSchema,
  ChatStreamEventSchema,
  SseDecoder,
} from '@repo/contracts';
import type {
  Credentials,
  HealthResponse,
  ManagedUser,
  NewUser,
  PublicUser,
  Registration,
  UserList,
  UserUpdate,
  ChatModel,
  CreateChatModel,
  UpdateChatModel,
  ChatCompletion,
  ChatCompletionResponse,
  ChatDebugTrace,
  ChatStreamEvent,
  ChatHistoryPage,
} from '@repo/contracts';
import { initClient, ResponseValidationError, validateResponse } from '@ts-rest/core';

export type {
  Credentials,
  HealthResponse,
  ManagedUser,
  NewUser,
  PublicUser as User,
  Registration,
  UserList,
  UserUpdate,
  ChatModel,
  CreateChatModel,
  UpdateChatModel,
  ChatMessage,
} from '@repo/contracts';

// Empty selection belongs to the screen; the HTTP contract uses an omitted status.
export type UserQuery = Pick<UserList, 'page' | 'pageSize'> & {
  search: string;
  status: '' | ManagedUser['status'];
};

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly debug?: ChatDebugTrace,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

function errorMessage(value: unknown, status: number): string {
  if (status === 429) return '操作太频繁，请稍后重试';
  if (status >= 500 && status !== 502 && status !== 504) return '服务暂时不可用，请稍后重试';
  if (typeof value === 'object' && value !== null && 'message' in value) {
    const message: unknown = value.message;
    if (typeof message === 'string') return message;
    if (Array.isArray(message) && message.every((item: unknown) => typeof item === 'string')) {
      return message.join('；');
    }
  }
  return status >= 500 ? '服务暂时不可用，请稍后重试' : `服务请求失败（HTTP ${status}）`;
}

const client = initClient(apiContract, {
  baseUrl: '',
  baseHeaders: {},
  credentials: 'same-origin',
  validateResponse: true,
  api: async (args) => {
    const response = await fetch(args.path, {
      ...args.fetchOptions,
      method: args.method,
      headers: args.headers,
      ...(args.body !== undefined && args.body !== null ? { body: args.body } : {}),
    });
    let data: unknown = undefined;
    if (response.status !== 204) {
      const text = await response.text();
      if (text) {
        try {
          data = JSON.parse(text) as unknown;
        } catch {
          if (response.ok) throw new Error('服务返回了无法识别的数据');
        }
      }
    }
    if (!response.ok) {
      const debug = ChatDebugTraceSchema.safeParse(
        typeof data === 'object' && data !== null && 'debug' in data ? data.debug : undefined,
      );
      throw new ApiError(
        errorMessage(data, response.status),
        response.status,
        debug.success ? debug.data : undefined,
      );
    }
    const validated = validateResponse({
      appRoute: args.route,
      response: { status: response.status, body: data },
    });
    return { status: response.status, body: validated.body, headers: response.headers };
  },
});

async function request<T>(operation: Promise<T>): Promise<T> {
  try {
    return await operation;
  } catch (error: unknown) {
    if (error instanceof ResponseValidationError) {
      throw new Error('服务返回了无法识别的数据');
    }
    throw error;
  }
}

function assertStatus<T extends { status: number; body: unknown }, S extends T['status']>(
  response: T,
  status: S,
): asserts response is Extract<T, { status: S }> {
  if (response.status !== status) {
    throw new ApiError(errorMessage(response.body, response.status), response.status);
  }
}

export async function listUsers(query: UserQuery, signal: AbortSignal): Promise<UserList> {
  const result = await request(
    client.users.list({
      query: {
        page: query.page,
        pageSize: query.pageSize,
        ...(query.search ? { search: query.search } : {}),
        ...(query.status ? { status: query.status } : {}),
      },
      fetchOptions: { signal },
    }),
  );
  assertStatus(result, 200);
  return result.body;
}

export async function getUser(id: string, signal: AbortSignal): Promise<ManagedUser> {
  const result = await request(client.users.detail({ params: { id }, fetchOptions: { signal } }));
  assertStatus(result, 200);
  return result.body.user;
}

export async function createUser(input: NewUser, signal: AbortSignal): Promise<ManagedUser> {
  const result = await request(client.users.create({ body: input, fetchOptions: { signal } }));
  assertStatus(result, 201);
  return result.body.user;
}

export async function updateUser(
  id: string,
  input: UserUpdate,
  signal: AbortSignal,
): Promise<ManagedUser> {
  const result = await request(
    client.users.update({ params: { id }, body: input, fetchOptions: { signal } }),
  );
  assertStatus(result, 200);
  return result.body.user;
}

export async function getCurrentUser(signal: AbortSignal): Promise<PublicUser | null> {
  try {
    const result = await request(client.auth.me({ fetchOptions: { signal } }));
    assertStatus(result, 200);
    return result.body.user;
  } catch (error: unknown) {
    if (error instanceof ApiError && error.status === 401) return null;
    throw error;
  }
}

export async function login(input: Credentials, signal: AbortSignal): Promise<PublicUser> {
  const result = await request(client.auth.login({ body: input, fetchOptions: { signal } }));
  assertStatus(result, 200);
  return result.body.user;
}

export async function register(input: Registration, signal: AbortSignal): Promise<PublicUser> {
  const result = await request(client.auth.register({ body: input, fetchOptions: { signal } }));
  assertStatus(result, 201);
  return result.body.user;
}

export async function logout(signal: AbortSignal): Promise<void> {
  const result = await request(client.auth.logout({ fetchOptions: { signal } }));
  assertStatus(result, 204);
}

export async function getHealth(signal?: AbortSignal): Promise<HealthResponse> {
  const result = await request(client.health.get({ fetchOptions: signal ? { signal } : {} }));
  assertStatus(result, 200);
  return result.body;
}

export async function listChatModels(signal: AbortSignal): Promise<ChatModel[]> {
  const result = await request(client.chat.listModels({ fetchOptions: { signal } }));
  assertStatus(result, 200);
  return result.body.items;
}

export async function listChatHistory(
  cursor: string | null,
  signal: AbortSignal,
): Promise<ChatHistoryPage> {
  const result = await request(
    client.chat.history({
      query: cursor ? { cursor } : {},
      fetchOptions: { signal },
    }),
  );
  assertStatus(result, 200);
  return result.body;
}

export function chatResourceUrl(historyId: string, resourceId: string) {
  return `/api/chat/histories/${historyId}/resources/${resourceId}`;
}

export async function readChatImage(
  historyId: string,
  resourceId: string,
  name: string,
  signal: AbortSignal,
) {
  const response = await fetch(chatResourceUrl(historyId, resourceId), {
    credentials: 'same-origin',
    signal,
  });
  if (!response.ok) throw new ApiError('历史图片读取失败，请重试', response.status);
  const blob = await response.blob();
  signal.throwIfAborted();
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () =>
      typeof reader.result === 'string'
        ? resolve(reader.result)
        : reject(new Error('历史图片读取失败'));
    reader.onerror = () => reject(new Error('历史图片读取失败'));
    const abort = () => reader.abort();
    reader.onabort = () =>
      reject(signal.reason instanceof Error ? signal.reason : new Error('读取已取消'));
    reader.onloadend = () => signal.removeEventListener('abort', abort);
    signal.addEventListener('abort', abort, { once: true });
    reader.readAsDataURL(blob);
  });
  return { name, dataUrl };
}

export async function createChatModel(
  input: CreateChatModel,
  signal: AbortSignal,
): Promise<ChatModel> {
  const result = await request(client.chat.createModel({ body: input, fetchOptions: { signal } }));
  assertStatus(result, 201);
  return result.body.model;
}

export async function updateChatModel(
  id: string,
  input: UpdateChatModel,
  signal: AbortSignal,
): Promise<ChatModel> {
  const result = await request(
    client.chat.updateModel({ params: { id }, body: input, fetchOptions: { signal } }),
  );
  assertStatus(result, 200);
  return result.body.model;
}

export async function deleteChatModel(id: string, signal: AbortSignal): Promise<void> {
  const result = await request(
    client.chat.deleteModel({ params: { id }, fetchOptions: { signal } }),
  );
  assertStatus(result, 204);
}

export async function sendChat(
  input: ChatCompletion,
  signal: AbortSignal,
): Promise<ChatCompletionResponse> {
  const result = await request(client.chat.complete({ body: input, fetchOptions: { signal } }));
  assertStatus(result, 200);
  return result.body;
}

export async function streamChat(
  input: ChatCompletion,
  signal: AbortSignal,
  onEvent: (event: ChatStreamEvent) => void,
): Promise<Extract<ChatStreamEvent, { type: 'done' }>> {
  const response = await fetch(apiContract.chat.stream.path, {
    method: 'POST',
    credentials: 'same-origin',
    signal,
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    let data: unknown;
    try {
      data = await response.json();
    } catch {
      data = undefined;
    }
    throw new ApiError(errorMessage(data, response.status), response.status);
  }
  if (!response.headers.get('content-type')?.includes('text/event-stream') || !response.body) {
    await response.body?.cancel();
    throw new Error('服务未返回流式响应');
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const sse = new SseDecoder();
  try {
    while (true) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      const text = done ? decoder.decode() : decoder.decode(value, { stream: true });
      for (const data of sse.push(text)) {
        signal.throwIfAborted();
        let event: ChatStreamEvent;
        try {
          event = ChatStreamEventSchema.parse(JSON.parse(data));
        } catch {
          throw new Error('服务返回了无效的流式数据');
        }
        onEvent(event);
        if (event.type === 'error') throw new ApiError(event.message, event.status, event.debug);
        if (event.type === 'done') return event;
      }
      if (done) throw new Error('连接中断，未收到完整回复');
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
