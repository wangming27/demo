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
const debugToolCall = z.object({
  id: z.string(),
  name: z.string(),
  arguments: z.string(),
});
const debugMessage = z.object({
  role: z.enum(['system', 'user', 'assistant', 'tool']),
  content: z.string().nullable(),
  reasoning: z.string().optional(),
  toolCallId: z.string().optional(),
  toolCalls: z.array(debugToolCall).optional(),
});
const debugEventFields = {
  round: z.number().int().min(1).max(4),
  startedAt: timestamp,
  durationMs: z.number().nonnegative(),
  truncated: z.boolean(),
};
export const ChatDebugEventSchema = z.discriminatedUnion('kind', [
  z.object({
    ...debugEventFields,
    kind: z.literal('model_request'),
    messages: z.array(debugMessage),
    tools: z.string(),
    toolChoice: z.enum(['auto', 'none']).optional(),
  }),
  z.object({ ...debugEventFields, kind: z.literal('model_response'), message: z.string() }),
  z.object({
    ...debugEventFields,
    kind: z.literal('tool'),
    toolCallId: z.string(),
    name: z.string(),
    arguments: z.string(),
    result: z.string(),
    warning: z.string().optional(),
  }),
  z.object({ ...debugEventFields, kind: z.literal('error'), message: z.string() }),
]);
export const ChatDebugTraceSchema = z.object({
  requestId: z.string().uuid(),
  startedAt: timestamp,
  durationMs: z.number().nonnegative(),
  status: z.enum(['success', 'error']),
  model: z.object({ name: z.string(), model: z.string(), baseUrl: z.string() }),
  events: z.array(ChatDebugEventSchema).max(32),
});
export type ChatDebugTrace = z.output<typeof ChatDebugTraceSchema>;
export type ChatDebugEvent = z.output<typeof ChatDebugEventSchema>;
export const ErrorResponseSchema = z.object({
  message: z.union([z.string(), z.array(z.string())]),
  statusCode: z.number().int().optional(),
  error: z.string().optional(),
  debug: ChatDebugTraceSchema.optional(),
});

const modelFields = {
  contextWindow: z.number().int().min(1).max(2_147_483_647).nullable().optional(),
  name: z.string().trim().min(1).max(80),
  model: z.string().trim().min(1).max(200),
  baseUrl: z
    .string()
    .trim()
    .url('请输入有效的 API 地址')
    .max(2048)
    .refine((value) => {
      try {
        const url = new URL(value);
        return (
          ['https:', 'http:'].includes(url.protocol) &&
          !url.username &&
          !url.password &&
          !url.search &&
          !url.hash
        );
      } catch {
        return false;
      }
    }, 'API 地址必须使用 HTTP(S)，且不能包含账号、查询参数或片段'),
};
const apiKey = z
  .string()
  .trim()
  .min(1)
  .max(4096)
  .regex(/^[\x21-\x7e]+$/, 'API Key 格式无效');
export const ChatModelSchema = z.object({
  id: z.string().uuid(),
  ...modelFields,
  hasApiKey: z.boolean(),
  createdAt: timestamp,
});
export const CreateChatModelSchema = z.object({ ...modelFields, apiKey }).strict();
export const UpdateChatModelSchema = z
  .object({ ...modelFields, apiKey: apiKey.optional() })
  .strict();
export const ChatModelsResponseSchema = z.object({ items: z.array(ChatModelSchema) });
export const ChatModelResponseSchema = z.object({ model: ChatModelSchema });
export const CHAT_IMAGE_MAX_BYTES = 2 * 1024 * 1024;
export const CHAT_IMAGES_MAX_BYTES = 8 * 1024 * 1024;
export const CHAT_IMAGES_PER_MESSAGE = 4;
const imagePrefix = /^data:image\/(png|jpeg|webp);base64,/;
export function chatImageBytes(dataUrl: string): number {
  const data = dataUrl.slice(dataUrl.indexOf(',') + 1);
  return (data.length / 4) * 3 - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0);
}
export const ChatImageSchema = z
  .object({
    name: z.string().trim().min(1).max(255),
    dataUrl: z
      .string()
      .max(4 * Math.ceil(CHAT_IMAGE_MAX_BYTES / 3) + 40, '单张图片不能超过 2 MB')
      .refine((value) => {
        const match = imagePrefix.exec(value);
        if (!match || chatImageBytes(value) > CHAT_IMAGE_MAX_BYTES) return false;
        const data = value.slice(match[0].length);
        if (!data.length || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data))
          return false;
        try {
          const header = atob(data.slice(0, 24));
          if (match[1] === 'png') return header.startsWith('\x89PNG\r\n\x1a\n');
          if (match[1] === 'jpeg') return header.startsWith('\xff\xd8\xff');
          return header.startsWith('RIFF') && header.slice(8, 12) === 'WEBP';
        } catch {
          return false;
        }
      }, '请上传有效的 PNG、JPEG 或 WebP 图片，单张不能超过 2 MB'),
  })
  .strict();
export const ChatMessageSchema = z
  .object({
    role: z.enum(['user', 'assistant']),
    content: z.string().trim().max(16_000),
    images: z.array(ChatImageSchema).min(1).max(CHAT_IMAGES_PER_MESSAGE).optional(),
  })
  .strict()
  .refine(
    ({ role, content, images }) =>
      (role === 'user' || !images) && (content.length > 0 || (role === 'user' && !!images?.length)),
    '消息不能为空，图片仅能附在用户消息中',
  );
export const ChatCompletionSchema = z
  .object({
    modelId: z.string().uuid(),
    requestId: z.string().uuid().optional(),
    conversationId: z.string().uuid().optional(),
    previousHistoryId: z.string().uuid().optional(),
    retryOfHistoryId: z.string().uuid().optional(),
    messages: z.array(ChatMessageSchema).min(1).max(50),
    webSearch: z.boolean().optional(),
    debug: z.boolean().optional(),
  })
  .strict()
  .refine(
    ({ messages }) =>
      messages.at(-1)?.role === 'user' &&
      messages.reduce((total, message) => total + message.content.length, 0) <= 60_000,
    '对话过长或最后一条不是用户消息，请开始新对话',
  )
  .refine(
    ({ messages }) =>
      messages.reduce(
        (total, message) =>
          total +
          (message.images ?? []).reduce((bytes, image) => bytes + chatImageBytes(image.dataUrl), 0),
        0,
      ) <= CHAT_IMAGES_MAX_BYTES,
    '对话图片合计不能超过 8 MB，请开始新对话',
  );
export const ChatCompletionResponseSchema = z.object({
  historyId: z.string().uuid().optional(),
  usage: z
    .object({
      inputTokens: count,
      outputTokens: count,
    })
    .optional(),
  contextUsage: z
    .object({
      windowTokens: count.positive().nullable(),
      source: z.enum(['runtime', 'configured', 'declared', 'unknown']),
    })
    .optional(),
  content: z.string().min(1).max(100_000),
  reasoning: z.string().min(1).max(100_000).optional(),
  sources: z
    .array(
      z.object({
        title: z.string().min(1).max(300),
        url: z
          .string()
          .url()
          .max(2048)
          .refine((value) => {
            const url = new URL(value);
            return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
          }),
      }),
    )
    .max(20)
    .optional(),
  searchWarning: z.string().min(1).max(1000).optional(),
  debug: ChatDebugTraceSchema.optional(),
});
export type ChatModel = z.output<typeof ChatModelSchema>;
export type CreateChatModel = z.input<typeof CreateChatModelSchema>;
export type UpdateChatModel = z.input<typeof UpdateChatModelSchema>;
export type ChatMessage = z.output<typeof ChatMessageSchema>;
export type ChatImage = z.output<typeof ChatImageSchema>;
export type ChatCompletion = z.output<typeof ChatCompletionSchema>;
export type ChatCompletionResponse = z.output<typeof ChatCompletionResponseSchema>;

export const ChatHistoryQuerySchema = z.object({ cursor: z.string().uuid().optional() }).strict();
export const ChatHistoryEntrySchema = z.object({
  id: z.string().uuid(),
  conversationId: z.string().uuid(),
  query: z.string().max(16_000),
  createdAt: timestamp,
  status: z.enum(['PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'INTERRUPTED']),
  model: z.object({ id: z.string().uuid(), name: z.string() }),
  resources: z.array(
    z.object({
      id: z.string().uuid(),
      name: z.string(),
      mime: z.enum(['image/png', 'image/jpeg', 'image/webp', 'application/json']),
      bytes: count,
    }),
  ),
  reply: z
    .object({
      id: z.string().uuid(),
      content: z.string().nullable(),
      reasoningContent: z.string().nullable(),
      isFinal: z.boolean(),
      usage: ChatCompletionResponseSchema.shape.usage,
    })
    .nullable(),
  contextUsage: ChatCompletionResponseSchema.shape.contextUsage,
  timing: z.lazy(() => ChatTimingSchema).optional(),
  durationMs: count.nullable(),
  sources: ChatCompletionResponseSchema.shape.sources,
  searchWarning: ChatCompletionResponseSchema.shape.searchWarning,
});
export const ChatHistoryPageSchema = z.object({
  items: z.array(ChatHistoryEntrySchema).max(10),
  nextCursor: z.string().uuid().nullable(),
});
export type ChatHistoryEntry = z.output<typeof ChatHistoryEntrySchema>;
export type ChatHistoryPage = z.output<typeof ChatHistoryPageSchema>;
const duration = z.number().finite().nonnegative();
const span = z.object({
  round: z.number().int().min(1).max(4),
  startMs: duration,
  endMs: duration.nullable(),
});
export const ChatTimingSchema = z.object({
  elapsedMs: duration,
  firstResponseMs: duration.nullable(),
  phase: z.enum(['waiting', 'thinking', 'answering', 'tool', 'finishing', 'done']),
  thoughts: z.array(span).max(32),
  tools: z.array(span.extend({ id: z.string(), name: z.string() })).max(4),
});
export const ChatStreamEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('state'), timing: ChatTimingSchema }),
  z.object({
    type: z.literal('delta'),
    round: z.number().int().min(1).max(4),
    reasoning: z.string().max(100_000).optional(),
    content: z.string().max(100_000).optional(),
    toolCall: z.boolean().optional(),
  }),
  z.object({
    type: z.literal('done'),
    answer: ChatCompletionResponseSchema,
    timing: ChatTimingSchema,
  }),
  z.object({
    type: z.literal('error'),
    message: z.string(),
    status: z.number().int(),
    debug: ChatDebugTraceSchema.optional(),
    timing: ChatTimingSchema,
  }),
]);
export type ChatTiming = z.output<typeof ChatTimingSchema>;
export type ChatStreamEvent = z.output<typeof ChatStreamEventSchema>;

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
