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
} from './schemas';

export * from './schemas';

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
export const apiContract = c.router({
  auth: authContract,
  users: usersContract,
  health: healthContract,
});
