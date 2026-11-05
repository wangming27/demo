import { z } from 'zod';

export const UserRoleSchema = z.enum(['ADMIN', 'USER']);
export const UserStatusSchema = z.enum(['ACTIVE', 'DISABLED']);
const timestamp = z.string().datetime({ offset: true });
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const email = z.string().trim().toLowerCase().email('请输入有效的邮箱地址').max(254);
const name = z.string().trim().min(1, '昵称长度必须为 1–80 个字符').max(80);
const registrationPassword = z
  .string()
  .min(12, '密码长度必须为 12–128 个字符')
  .max(128, '密码长度必须为 12–128 个字符');

export const PublicUserSchema = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  name: z.string(),
  createdAt: timestamp,
  role: UserRoleSchema,
});
export const ManagedUserSchema = PublicUserSchema.extend({
  status: UserStatusSchema,
  updatedAt: timestamp,
});
export const UserResponseSchema = z.object({ user: PublicUserSchema });
export const ManagedUserResponseSchema = z.object({ user: ManagedUserSchema });
export const UserListSchema = z.object({
  items: z.array(ManagedUserSchema),
  total: count,
  page: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  pageSize: z.number().int().min(1).max(100),
  stats: z.object({ total: count, active: count, disabled: count }),
});
export const CredentialsSchema = z
  .object({
    email,
    password: z
      .string()
      .min(1, '请输入密码，最多 128 个字符')
      .max(128, '请输入密码，最多 128 个字符'),
  })
  .strict();
export const RegistrationSchema = CredentialsSchema.extend({
  name,
  password: registrationPassword,
});
export const CreateUserSchema = RegistrationSchema.extend({
  role: UserRoleSchema.default('USER'),
});
export const UpdateUserSchema = z
  .object({
    name,
    email,
    role: UserRoleSchema,
    status: UserStatusSchema,
    updatedAt: timestamp,
  })
  .strict();
export const ListUsersQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).max(100_000).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(10),
    search: z.string().trim().max(100).optional(),
    status: UserStatusSchema.optional(),
  })
  .strict();
export const UserIdParamsSchema = z
  .object({
    id: z
      .string()
      .uuid()
      .regex(/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i),
  })
  .strict();
export const HealthResponseSchema = z.object({
  status: z.literal('ok'),
  service: z.string(),
  timestamp,
});
export const ErrorResponseSchema = z.object({
  message: z.union([z.string(), z.array(z.string())]),
  statusCode: z.number().int().optional(),
  error: z.string().optional(),
});

export type PublicUser = z.output<typeof PublicUserSchema>;
export type ManagedUser = z.output<typeof ManagedUserSchema>;
export type UserList = z.output<typeof UserListSchema>;
export type HealthResponse = z.output<typeof HealthResponseSchema>;
export type Credentials = z.input<typeof CredentialsSchema>;
export type Registration = z.input<typeof RegistrationSchema>;
export type NewUser = z.input<typeof CreateUserSchema>;
export type UserUpdate = z.input<typeof UpdateUserSchema>;
export type CreateUserInput = z.output<typeof CreateUserSchema>;
export type ListUsersInput = z.output<typeof ListUsersQuerySchema>;
