import { apiContract } from '@repo/contracts';
import type {
  Credentials,
  HealthResponse,
  ManagedUser,
  NewUser,
  PublicUser,
  Registration,
  UserList,
  UserUpdate,
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
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

function errorMessage(value: unknown, status: number): string {
  if (status === 429) return '操作太频繁，请稍后重试';
  if (status >= 500) return '服务暂时不可用，请稍后重试';
  if (typeof value === 'object' && value !== null && 'message' in value) {
    const message: unknown = value.message;
    if (typeof message === 'string') return message;
    if (Array.isArray(message) && message.every((item: unknown) => typeof item === 'string')) {
      return message.join('；');
    }
  }
  return `服务请求失败（HTTP ${status}）`;
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
      throw new ApiError(errorMessage(data, response.status), response.status);
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
