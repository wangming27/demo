import { initContract } from '@ts-rest/core';
import {
  CreateUserSchema,
  CredentialsSchema,
  ErrorResponseSchema,
  HealthResponseSchema,
  ListUsersQuerySchema,
  ManagedUserResponseSchema,
  RegistrationSchema,
  UpdateUserSchema,
  UserIdParamsSchema,
  UserListSchema,
  UserResponseSchema,
  ChatCompletionSchema,
  ChatCompletionResponseSchema,
  ChatModelResponseSchema,
  ChatModelsResponseSchema,
  CreateChatModelSchema,
  UpdateChatModelSchema,
  ChatHistoryQuerySchema,
  ChatHistoryPageSchema,
} from './schemas';

export * from './schemas';
export * from './sse';

const c = initContract();
const commonResponses = {
  400: ErrorResponseSchema,
  401: ErrorResponseSchema,
  403: ErrorResponseSchema,
  413: ErrorResponseSchema,
  429: ErrorResponseSchema,
  500: ErrorResponseSchema,
};

export const authContract = c.router(
  {
    register: {
      method: 'POST',
      path: '/auth/register',
      body: RegistrationSchema,
      responses: { 201: UserResponseSchema, 409: ErrorResponseSchema },
    },
    login: {
      method: 'POST',
      path: '/auth/login',
      body: CredentialsSchema,
      responses: { 200: UserResponseSchema },
    },
    me: {
      method: 'GET',
      path: '/auth/me',
      responses: { 200: UserResponseSchema },
    },
    logout: {
      method: 'POST',
      path: '/auth/logout',
      body: c.noBody(),
      responses: { 204: c.noBody() },
    },
  },
  { pathPrefix: '/api', commonResponses, strictStatusCodes: true },
);
export const usersContract = c.router(
  {
    list: {
      method: 'GET',
      path: '/users',
      query: ListUsersQuerySchema,
      responses: { 200: UserListSchema },
    },
    detail: {
      method: 'GET',
      path: '/users/:id',
      pathParams: UserIdParamsSchema,
      responses: { 200: ManagedUserResponseSchema, 404: ErrorResponseSchema },
    },
    create: {
      method: 'POST',
      path: '/users',
      body: CreateUserSchema,
      responses: { 201: ManagedUserResponseSchema, 409: ErrorResponseSchema },
    },
    update: {
      method: 'PATCH',
      path: '/users/:id',
      pathParams: UserIdParamsSchema,
      body: UpdateUserSchema,
      responses: {
        200: ManagedUserResponseSchema,
        404: ErrorResponseSchema,
        409: ErrorResponseSchema,
      },
    },
  },
  { pathPrefix: '/api', commonResponses, strictStatusCodes: true },
);
export const healthContract = c.router(
  {
    get: {
      method: 'GET',
      path: '/health',
      responses: { 200: HealthResponseSchema },
    },
  },
  { pathPrefix: '/api', commonResponses, strictStatusCodes: true },
);
export const chatContract = c.router(
  {
    history: {
      method: 'GET',
      path: '/chat/histories/feed',
      query: ChatHistoryQuerySchema,
      responses: { 200: ChatHistoryPageSchema },
    },
    listModels: {
      method: 'GET',
      path: '/chat/models',
      responses: { 200: ChatModelsResponseSchema },
    },
    createModel: {
      method: 'POST',
      path: '/chat/models',
      body: CreateChatModelSchema,
      responses: { 201: ChatModelResponseSchema },
    },
    updateModel: {
      method: 'PATCH',
      path: '/chat/models/:id',
      pathParams: UserIdParamsSchema,
      body: UpdateChatModelSchema,
      responses: { 200: ChatModelResponseSchema, 404: ErrorResponseSchema },
    },
    deleteModel: {
      method: 'DELETE',
      path: '/chat/models/:id',
      pathParams: UserIdParamsSchema,
      body: c.noBody(),
      responses: { 204: c.noBody(), 404: ErrorResponseSchema },
    },
    complete: {
      method: 'POST',
      path: '/chat/completions',
      body: ChatCompletionSchema,
      responses: {
        200: ChatCompletionResponseSchema,
        404: ErrorResponseSchema,
        502: ErrorResponseSchema,
        504: ErrorResponseSchema,
      },
    },
    stream: {
      method: 'POST',
      path: '/chat/stream',
      body: ChatCompletionSchema,
      responses: {
        200: c.otherResponse({ contentType: 'text/event-stream', body: c.type<string>() }),
        404: ErrorResponseSchema,
        502: ErrorResponseSchema,
        504: ErrorResponseSchema,
      },
    },
  },
  { pathPrefix: '/api', commonResponses, strictStatusCodes: true },
);
export const apiContract = c.router({
  auth: authContract,
  users: usersContract,
  health: healthContract,
  chat: chatContract,
});
