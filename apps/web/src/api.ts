export interface HealthResponse {
  status: 'ok';
  service: string;
  timestamp: string;
}

export interface User {
  id: string;
  email: string;
  name: string;
  createdAt: string;
  role: 'ADMIN' | 'USER';
}

export interface ManagedUser extends User {
  status: 'ACTIVE' | 'DISABLED';
  updatedAt: string;
}

export interface UserList {
  items: ManagedUser[];
  total: number;
  page: number;
  pageSize: number;
  stats: { total: number; active: number; disabled: number };
}

export interface UserQuery {
  page: number;
  pageSize: number;
  search: string;
  status: '' | ManagedUser['status'];
}

export interface NewUser extends Registration {
  role: User['role'];
}

export interface UserUpdate {
  name: string;
  email: string;
  role: User['role'];
  status: ManagedUser['status'];
  updatedAt: string;
}

export interface Credentials {
  email: string;
  password: string;
}

export interface Registration extends Credentials {
  name: string;
}

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
  if (status === 429) {
    return '操作太频繁，请稍后重试';
  }
  if (status >= 500) {
    return '服务暂时不可用，请稍后重试';
  }
  if (typeof value === 'object' && value !== null && 'message' in value) {
    const message: unknown = value.message;
    if (typeof message === 'string') {
      return message;
    }
    if (Array.isArray(message) && message.every((item: unknown) => typeof item === 'string')) {
      return message.join('；');
    }
  }
  return `服务请求失败（HTTP ${status}）`;
}

async function request(path: string, options: RequestInit): Promise<unknown> {
  const response = await fetch(path, { ...options, credentials: 'same-origin' });
  if (response.status === 204) {
    return null;
  }
  const body = await response.text();
  let data: unknown = null;
  if (body) {
    try {
      data = JSON.parse(body) as unknown;
    } catch {
      if (response.ok) {
        throw new Error('服务返回了无法识别的数据');
      }
    }
  }
  if (!response.ok) {
    throw new ApiError(errorMessage(data, response.status), response.status);
  }
  return data;
}

function parseUser(value: unknown): User {
  if (typeof value === 'object' && value !== null && 'user' in value) {
    const user: unknown = value.user;
    if (
      typeof user === 'object' &&
      user !== null &&
      'id' in user &&
      typeof user.id === 'string' &&
      'email' in user &&
      typeof user.email === 'string' &&
      'name' in user &&
      typeof user.name === 'string' &&
      'createdAt' in user &&
      typeof user.createdAt === 'string' &&
      Number.isFinite(Date.parse(user.createdAt)) &&
      'role' in user &&
      (user.role === 'ADMIN' || user.role === 'USER')
    ) {
      return {
        id: user.id,
        email: user.email,
        name: user.name,
        createdAt: user.createdAt,
        role: user.role,
      };
    }
  }
  throw new Error('服务返回了无法识别的用户数据');
}

function parseManagedUser(value: unknown): ManagedUser {
  const user = parseUser({ user: value });
  if (
    typeof value === 'object' &&
    value !== null &&
    'status' in value &&
    (value.status === 'ACTIVE' || value.status === 'DISABLED') &&
    'updatedAt' in value &&
    typeof value.updatedAt === 'string' &&
    Number.isFinite(Date.parse(value.updatedAt))
  ) {
    return { ...user, status: value.status, updatedAt: value.updatedAt };
  }
  throw new Error('服务返回了无法识别的用户数据');
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export async function listUsers(query: UserQuery, signal: AbortSignal): Promise<UserList> {
  const params = new URLSearchParams({
    page: String(query.page),
    pageSize: String(query.pageSize),
  });
  if (query.search) params.set('search', query.search);
  if (query.status) params.set('status', query.status);
  const data = await request(`/api/users?${params}`, { signal });
  if (
    typeof data === 'object' &&
    data !== null &&
    'items' in data &&
    Array.isArray(data.items) &&
    'total' in data &&
    isCount(data.total) &&
    'page' in data &&
    isCount(data.page) &&
    data.page > 0 &&
    'pageSize' in data &&
    isCount(data.pageSize) &&
    data.pageSize > 0 &&
    data.pageSize <= 100 &&
    'stats' in data &&
    typeof data.stats === 'object' &&
    data.stats !== null &&
    'total' in data.stats &&
    isCount(data.stats.total) &&
    'active' in data.stats &&
    isCount(data.stats.active) &&
    'disabled' in data.stats &&
    isCount(data.stats.disabled)
  ) {
    return {
      items: data.items.map(parseManagedUser),
      total: data.total,
      page: data.page,
      pageSize: data.pageSize,
      stats: { total: data.stats.total, active: data.stats.active, disabled: data.stats.disabled },
    };
  }
  throw new Error('服务返回了无法识别的用户列表');
}

export async function getUser(id: string, signal: AbortSignal): Promise<ManagedUser> {
  const data = await request(`/api/users/${encodeURIComponent(id)}`, { signal });
  if (typeof data === 'object' && data !== null && 'user' in data)
    return parseManagedUser(data.user);
  throw new Error('服务返回了无法识别的用户数据');
}

export async function saveUser(
  id: string | null,
  input: NewUser | UserUpdate,
  signal: AbortSignal,
): Promise<ManagedUser> {
  const data = await request(id ? `/api/users/${encodeURIComponent(id)}` : '/api/users', {
    method: id ? 'PATCH' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
    signal,
  });
  if (typeof data === 'object' && data !== null && 'user' in data)
    return parseManagedUser(data.user);
  throw new Error('服务返回了无法识别的用户数据');
}

export async function getCurrentUser(signal: AbortSignal): Promise<User | null> {
  try {
    return parseUser(await request('/api/auth/me', { signal }));
  } catch (error: unknown) {
    if (error instanceof ApiError && error.status === 401) {
      return null;
    }
    throw error;
  }
}

export async function login(input: Credentials, signal: AbortSignal): Promise<User> {
  return parseUser(
    await request('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
      signal,
    }),
  );
}

export async function register(input: Registration, signal: AbortSignal): Promise<User> {
  return parseUser(
    await request('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
      signal,
    }),
  );
}

export async function logout(signal: AbortSignal): Promise<void> {
  await request('/api/auth/logout', { method: 'POST', signal });
}

function isHealthResponse(value: unknown): value is HealthResponse {
  return (
    typeof value === 'object' &&
    value !== null &&
    'status' in value &&
    value.status === 'ok' &&
    'service' in value &&
    typeof value.service === 'string' &&
    'timestamp' in value &&
    typeof value.timestamp === 'string' &&
    Number.isFinite(Date.parse(value.timestamp))
  );
}

export async function getHealth(signal?: AbortSignal): Promise<HealthResponse> {
  const response = await fetch('/api/health', signal ? { signal } : {});

  if (!response.ok) {
    throw new Error(`服务请求失败（HTTP ${response.status}）`);
  }

  const data: unknown = await response.json();

  if (!isHealthResponse(data)) {
    throw new Error('服务返回了无法识别的数据');
  }

  return data;
}
