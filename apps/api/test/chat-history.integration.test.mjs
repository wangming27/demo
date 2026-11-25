import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { mkdir, rm, utimes } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { test } from 'node:test';
import { PrismaPg } from '@prisma/adapter-pg';
import prismaConfig from '../prisma.config.mjs';
const require = createRequire(import.meta.url);
const { publicWebRequest } = require('../.test-dist/chat/public-web.js');
const { PrismaClient } = require('../.test-dist/generated/prisma/client.js');
const { ChatService } = require('../.test-dist/chat/chat.service.js');
const { ChatController } = require('../.test-dist/chat/chat.controller.js');
const { ChatDebugStore } = require('../.test-dist/chat-debug/chat-debug.module.js');
const { ChatHistoryService } = require('../.test-dist/chat/chat-history.service.js');
const { ChatStorageService } = require('../.test-dist/chat/chat-storage.service.js');
const { ChatAgentService } = require('../.test-dist/chat/chat-agent.service.js');
const { ChatProgress } = require('../.test-dist/chat/chat-progress.js');
const { ResearchAgentService } = require('../.test-dist/chat/agents/research-agent.service.js');
const { SubAgentRegistry } = require('../.test-dist/chat/agents/sub-agent-registry.service.js');

test(
  'chat history persists rounds, resources, failures and request identity',
  { timeout: 30_000 },
  async (t) => {
    const databaseUrl = prismaConfig.datasource.url;
    assert.notEqual(process.env.NODE_ENV, 'production');
    const schema = `history_test_${randomUUID().replaceAll('-', '')}`;
    const testUrl = new URL(databaseUrl);
    testUrl.searchParams.set('schema', schema);
    const admin = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
    const prisma = new PrismaClient({
      adapter: new PrismaPg({ connectionString: testUrl.toString() }, { schema }),
    });
    const storageRoot = resolve('.chat-storage', schema);
    const previousRoot = process.env.CHAT_STORAGE_ROOT;
    process.env.CHAT_STORAGE_ROOT = storageRoot;
    const storage = new ChatStorageService();
    if (previousRoot === undefined) delete process.env.CHAT_STORAGE_ROOT;
    else process.env.CHAT_STORAGE_ROOT = previousRoot;
    const histories = new ChatHistoryService(prisma, storage);
    let handler;
    let requests = 0;
    const server = createServer(async (req, res) => {
      let text = '';
      for await (const chunk of req) text += chunk;
      requests++;
      handler(JSON.parse(text), res);
    });
    await admin.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
    try {
      execFileSync(
        process.execPath,
        [resolve('node_modules/prisma/build/index.js'), 'migrate', 'deploy'],
        {
          cwd: resolve('.'),
          env: { ...process.env, DATABASE_URL: testUrl.toString() },
          stdio: 'pipe',
        },
      );
      await mkdir(storageRoot, { recursive: true });
      await new Promise((done) => server.listen(0, '127.0.0.1', done));
      const user = await prisma.user.create({
        data: { email: `${randomUUID()}@example.com`, name: '历史测试', passwordHash: 'test-only' },
      });
      const other = await prisma.user.create({
        data: { email: `${randomUUID()}@example.com`, name: '其他用户', passwordHash: 'test-only' },
      });
      const config = await prisma.chatModel.create({
        data: {
          userId: user.id,
          name: '模型',
          model: 'test-model',
          baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
          apiKey: 'private-test-key',
          contextWindow: 1000,
        },
      });
      const toolResult = {
        data: { pages: ['文'.repeat(140_000)] },
        sources: [{ title: '来源', url: 'https://example.com/news' }],
        debug: {
          webRequests: [publicWebRequest(new URL('https://example.com/news'))],
          cacheHit: false,
        },
      };
      const agent = new ChatAgentService({
        tools: () => [
          {
            definition: {
              type: 'function',
              function: { name: 'research', description: '研究', parameters: {} },
            },
            execute: async () => toolResult,
          },
        ],
      });
      const service = new ChatService(prisma, agent, histories);
      const input = (extra = {}) => ({
        modelId: config.id,
        requestId: randomUUID(),
        conversationId: randomUUID(),
        messages: [{ role: 'user', content: '测试问题' }],
        ...extra,
      });
      const signal = () => new AbortController().signal;
      const frame = (delta, finish_reason) =>
        `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
      const normal = (_body, res) =>
        res.end(
          JSON.stringify({
            choices: [
              {
                finish_reason: 'stop',
                message: { content: '模型回答', reasoning_content: 'SECRET_THOUGHT' },
              },
            ],
            usage: { prompt_tokens: 250, completion_tokens: 30 },
          }),
        );
      handler = normal;
      let successful;
      let successfulInput;
      await t.test(
        'one question creates one main row and completed duplicates replay without provider work',
        async () => {
          successfulInput = input();
          successful = await service.complete(user.id, successfulInput, signal());
          const detail = await histories.detail(user.id, successful.historyId);
          assert.equal(detail.history.modelId, config.id);
          assert.equal(detail.history.contextUsedTokens, 250);
          assert.equal(detail.history.contextUsageRatio, 0.25);
          assert.equal(detail.history.contextWindowSource, 'configured');
          assert.equal(detail.replies.length, 1);
          assert.equal(detail.replies[0].finishReason, 'stop');
          assert.equal(detail.replies[0].outputTokens, 30);
          assert.equal(detail.replies[0].isFinal, true);
          assert.equal(detail.replies[0].reasoningContent, 'SECRET_THOUGHT');
          assert.equal(detail.history.status, 'SUCCEEDED');
          const serialized = JSON.stringify(detail);
          assert.equal(serialized.includes(config.apiKey), false);
          assert.equal('model' in detail.history, false);
          const count = requests;
          const replay = await service.complete(user.id, successfulInput, signal());
          assert.equal(replay.historyId, successful.historyId);
          assert.equal(replay.content, successful.content);
          assert.equal(replay.reasoning, undefined);
          assert.equal(requests, count);
          await assert.rejects(
            service.complete(
              user.id,
              { ...successfulInput, messages: [{ role: 'user', content: '其他问题' }] },
              signal(),
            ),
            (error) => error.getStatus() === 409,
          );
        },
      );
      await t.test('links and file access are scoped to user and conversation', async () => {
        await assert.rejects(
          histories.detail(other.id, successful.historyId),
          (error) => error.getStatus() === 404,
        );
        await assert.rejects(
          service.complete(user.id, input({ previousHistoryId: successful.historyId }), signal()),
          (error) => error.getStatus() === 400,
        );
        const png = Buffer.from('\x89PNG\r\n\x1a\nTEST', 'latin1');
        const body = input({
          conversationId: successfulInput.conversationId,
          previousHistoryId: successful.historyId,
          messages: [
            {
              role: 'user',
              content: '',
              images: [
                { name: '图片.png', dataUrl: `data:image/png;base64,${png.toString('base64')}` },
              ],
            },
          ],
        });
        const answer = await service.complete(user.id, body, signal());
        const row = await prisma.chatHistory.findUniqueOrThrow({ where: { id: answer.historyId } });
        assert.equal(row.resources.length, 1);
        assert.equal(JSON.stringify(row.resources).includes('base64'), false);
        const file = await histories.resource(user.id, row.id, row.resources[0].id);
        assert.deepEqual(file.data, png);
        await assert.rejects(
          histories.resource(other.id, row.id, row.resources[0].id),
          (error) => error.getStatus() === 404,
        );
        await histories.delete(user.id, row.id);
        await assert.rejects(
          histories.resource(user.id, row.id, row.resources[0].id),
          (error) => error.getStatus() === 404,
        );
        await assert.rejects(
          storage.read(user.id, row.id, row.resources[0]),
          (error) => error.getStatus() === 404,
        );
      });
      await t.test(
        'multiple model and tool rounds share an ordered sequence; large output stays intact',
        async () => {
          handler = (body, res) => {
            const round = body.messages.filter((message) => message.role === 'tool').length;
            for (const message of body.messages.filter((message) => message.role === 'tool'))
              assert.equal('debug' in JSON.parse(message.content), false);
            res.end(
              JSON.stringify({
                choices: [
                  {
                    finish_reason: round === 2 ? 'stop' : 'tool_calls',
                    message:
                      round === 2
                        ? { content: '联网回答', reasoning: 'SECRET_THOUGHT' }
                        : {
                            content: `查询${round + 1}`,
                            tool_calls: [
                              {
                                id: `call-${round}`,
                                type: 'function',
                                function: { name: 'research', arguments: '{"task":"查证新闻"}' },
                              },
                            ],
                          },
                  },
                ],
                usage: { prompt_tokens: 250 + round, completion_tokens: 30 },
              }),
            );
          };
          const body = input({ webSearch: true });
          const answer = await service.complete(user.id, body, signal());
          const detail = await histories.detail(user.id, answer.historyId);
          assert.equal(detail.replies.length, 3);
          assert.equal(detail.toolCalls.length, 2);
          assert.deepEqual(
            detail.replies.map((row) => row.sequence),
            [1, 3, 5],
          );
          assert.deepEqual(
            detail.toolCalls.map((row) => row.sequence),
            [2, 4],
          );
          assert.equal(detail.toolCalls[0].replyId, detail.replies[0].id);
          assert.equal(detail.replies[0].isFinal, false);
          assert.equal(detail.replies[2].isFinal, true);
          assert.equal(detail.replies[0].reasoningContent, null);
          assert.equal(detail.replies[2].reasoningContent, 'SECRET_THOUGHT');
          assert.equal(detail.history.contextUsedTokens, 252);
          const tool = detail.toolCalls[0];
          assert.equal(tool.argumentsRaw, '{"task":"查证新闻"}');
          assert.deepEqual(tool.arguments, { task: '查证新闻' });
          const file = await histories.resource(user.id, answer.historyId, tool.resources[0].id);
          assert.deepEqual(JSON.parse(file.data.toString()), toolResult);
          assert.equal(
            JSON.parse(file.data.toString()).debug.webRequests[0].curl,
            toolResult.debug.webRequests[0].curl,
          );
          const count = requests;
          const replay = await service.complete(user.id, body, signal());
          assert.deepEqual(replay.sources, answer.sources);
          assert.equal(requests, count);
        },
      );
      await t.test(
        'research rounds persist scope and only selected evidence becomes history citations',
        async () => {
          const quote = '北京今日天气晴朗，空气质量良好，适合安排户外活动。';
          let round = 0;
          handler = (body, res) => {
            round++;
            const call = (name, args, id) => ({
              id,
              type: 'function',
              function: { name, arguments: JSON.stringify(args) },
            });
            const message =
              round === 1
                ? { tool_calls: [call('research', { task: '查证北京天气' }, 'delegate')] }
                : round === 2
                  ? {
                      tool_calls: [
                        call('web_fetch', { url: 'https://example.com/relevant' }, 'relevant'),
                        call('web_fetch', { url: 'https://example.com/unrelated' }, 'unrelated'),
                      ],
                    }
                  : round === 3
                    ? {
                        content: JSON.stringify({
                          findings: [
                            {
                              claim: '北京适宜出门',
                              evidence: [{ url: 'https://example.com/relevant', quote }],
                            },
                          ],
                          gaps: [],
                        }),
                      }
                    : { content: '最终主 Agent 回答' };
            assert.equal(body.stream, true);
            res.setHeader('Content-Type', 'text/event-stream');
            res.end(
              frame({
                ...message,
                ...(message.tool_calls
                  ? { tool_calls: message.tool_calls.map((tool, index) => ({ ...tool, index })) }
                  : {}),
              }) +
                'data: {"choices":[],"usage":{"prompt_tokens":40,"completion_tokens":10}}\n\n' +
                'data: [DONE]\n\n',
            );
          };
          const research = new ResearchAgentService({
            execute: async (_name, raw) => {
              const url = JSON.parse(raw).url;
              return {
                data: { title: '网页正文', url, content: quote.repeat(5) },
                sources: [{ title: '网页正文', url }],
              };
            },
          });
          const researchService = new ChatService(
            prisma,
            new ChatAgentService(new SubAgentRegistry([research])),
            histories,
          );
          const body = input({ webSearch: true });
          const progress = new ChatProgress(() => {});
          const answer = await researchService.complete(user.id, body, signal(), progress);
          const detail = await histories.detail(user.id, answer.historyId);
          assert.deepEqual(
            detail.replies.map((reply) => [reply.round, reply.timings.agent, reply.isFinal]),
            [
              [1, 'main', false],
              [2, 'research', false],
              [3, 'research', false],
              [4, 'main', true],
            ],
          );
          assert.equal(detail.replies[1].timings.parentToolCallId, '1:delegate');
          assert.deepEqual(
            detail.toolCalls.map((tool) => tool.sequence),
            [2, 4, 5],
          );
          const feed = await histories.feed(user.id);
          const item = feed.items.find((entry) => entry.id === answer.historyId);
          assert.equal(item.reply.content, '最终主 Agent 回答');
          assert.deepEqual(item.sources, [
            { title: '网页正文', url: 'https://example.com/relevant' },
          ]);
          const replay = await researchService.complete(user.id, body, signal());
          assert.deepEqual(replay.sources, answer.sources);
          assert.equal(round, 4);
          assert.ok(progress.finish().tools.every((tool) => tool.endMs !== null));
        },
      );
      await t.test(
        'cancelled delegate content stays in detail and never becomes a chat reply',
        async () => {
          const controller = new AbortController();
          const { journal } = await histories.begin(user.id, input(), controller.signal);
          await journal.replyStart(1, { agent: 'main' });
          await journal.replyEnd(
            1,
            {
              content: '主 Agent 正在查证',
              tool_calls: [
                {
                  id: 'delegate',
                  type: 'function',
                  function: { name: 'research', arguments: '{"task":"查证"}' },
                },
              ],
            },
            { agent: 'main' },
          );
          await journal.replyStart(2, { agent: 'research', parentToolCallId: '1:delegate' });
          journal.delta({
            type: 'delta',
            round: 2,
            content: '{"findings":"子 Agent 的部分 JSON"}',
          });
          controller.abort();
          await journal.replyError(2, new Error('cancelled'));
          await journal.finishError(new Error('cancelled'));
          const detail = await histories.detail(user.id, journal.row.id);
          assert.equal(detail.replies[1].timings.agent, 'research');
          assert.match(detail.replies[1].content, /部分 JSON/);
          const feed = await histories.feed(user.id);
          assert.equal(
            feed.items.find((entry) => entry.id === journal.row.id).reply.content,
            '主 Agent 正在查证',
          );
        },
      );
      await t.test(
        'empty research reports emit SSE errors and persist failed history and delegation',
        async () => {
          let rounds = 0;
          handler = (request, res) => {
            rounds++;
            const message =
              rounds === 1
                ? {
                    tool_calls: [
                      {
                        index: 0,
                        id: 'delegate',
                        type: 'function',
                        function: { name: 'research', arguments: '{"task":"查证天气"}' },
                      },
                    ],
                  }
                : { content: null, reasoning_content: '正在整理报告。' };
            if (request.stream) {
              res.setHeader('Content-Type', 'text/event-stream');
              res.end(frame(message, 'stop') + 'data: [DONE]\n\n');
              return;
            }
            res.end(
              JSON.stringify({
                choices: [
                  {
                    finish_reason: 'stop',
                    message,
                  },
                ],
              }),
            );
          };
          const research = new ResearchAgentService({
            execute: async () => assert.fail('empty report must not publish evidence'),
          });
          const debugStore = new ChatDebugStore();
          const researchService = new ChatService(
            prisma,
            new ChatAgentService(new SubAgentRegistry([research])),
            histories,
            debugStore,
          );
          const body = input({ webSearch: true });
          const chunks = [];
          const response = Object.assign(new EventEmitter(), {
            headersSent: false,
            destroyed: false,
            writableLength: 0,
            status() {
              return this;
            },
            set() {
              return this;
            },
            write(chunk) {
              this.headersSent = true;
              chunks.push(chunk);
            },
            end() {},
          });
          await new ChatController(researchService).stream({ authUser: user }, body, response);
          const events = chunks.map((chunk) => JSON.parse(chunk.slice('data: '.length).trim()));
          const failure = events.find((event) => event.type === 'error');
          assert.equal(failure.status, 502);
          assert.match(failure.message, /报告为空或格式无效/);
          assert.equal('debug' in failure, false);
          const debug = debugStore.get(user.id, body.requestId);
          assert.equal(debug.status, 'error');
          assert.ok(
            debug.events.some(
              (event) =>
                event.kind === 'error' &&
                event.agent === 'research' &&
                event.parentToolCallId === '1:delegate',
            ),
          );
          assert.equal(
            events.some((event) => event.type === 'done'),
            false,
          );
          assert.equal(rounds, 4);
          const row = await prisma.chatHistory.findUniqueOrThrow({
            where: { userId_requestId: { userId: user.id, requestId: body.requestId } },
          });
          const detail = await histories.detail(user.id, row.id);
          assert.equal(detail.history.status, 'FAILED');
          assert.equal(detail.toolCalls[0].status, 'FAILED');
          assert.equal(detail.replies.length, 4);
          assert.ok(detail.replies.slice(1).every((reply) => !reply.isFinal));
        },
      );
      await t.test(
        'upstream errors persist and a new request can explicitly retry them',
        async () => {
          handler = (_body, res) => {
            res.statusCode = 502;
            res.end();
          };
          const body = input();
          await assert.rejects(
            service.complete(user.id, body, signal()),
            (error) => error.getStatus() === 502,
          );
          const row = await prisma.chatHistory.findUniqueOrThrow({
            where: { userId_requestId: { userId: user.id, requestId: body.requestId } },
          });
          const detail = await histories.detail(user.id, row.id);
          assert.equal(detail.history.status, 'FAILED');
          assert.equal(detail.replies[0].status, 'FAILED');
          assert.equal(detail.replies[0].reasoningContent, null);
          await assert.rejects(
            service.complete(user.id, body, signal()),
            (error) => error.getStatus() === 409,
          );
          handler = normal;
          const answer = await service.complete(
            user.id,
            input({ conversationId: body.conversationId, retryOfHistoryId: row.id }),
            signal(),
          );
          assert.equal(
            (await histories.detail(user.id, answer.historyId)).history.retryOfHistoryId,
            row.id,
          );
        },
      );
      await t.test(
        'partial streams checkpoint content and reasoning before cancellation',
        async () => {
          handler = (_body, res) => {
            res.setHeader('Content-Type', 'text/event-stream');
            res.write(frame({ reasoning_content: 'SECRET_THOUGHT' }));
            res.write(frame({ reasoning: '_CONTINUED' }));
            res.write(frame({ content: '保留的部分正文' }));
          };
          const controller = new AbortController();
          const body = input();
          let received;
          const first = new Promise((done) => {
            received = done;
          });
          const progress = new ChatProgress((event) => {
            if (event.type === 'delta' && event.content) received();
          });
          const pending = service.complete(user.id, body, controller.signal, progress);
          const rejected = assert.rejects(pending);
          await first;
          await new Promise((done) => setTimeout(done, 1300));
          const row = await prisma.chatHistory.findUniqueOrThrow({
            where: { userId_requestId: { userId: user.id, requestId: body.requestId } },
          });
          assert.equal(
            (await histories.detail(user.id, row.id)).replies[0].content,
            '保留的部分正文',
          );
          assert.equal(
            (await histories.detail(user.id, row.id)).replies[0].reasoningContent,
            'SECRET_THOUGHT_CONTINUED',
          );
          await assert.rejects(
            service.complete(user.id, body, signal()),
            (error) => error.getStatus() === 409,
          );
          controller.abort();
          await rejected;
          const detail = await histories.detail(user.id, row.id);
          assert.equal(detail.history.status, 'CANCELLED');
          assert.equal(detail.replies[0].status, 'CANCELLED');
          assert.equal(detail.replies[0].content, '保留的部分正文');
          assert.equal(detail.history.timings.thoughts.length, 1);
          assert.equal(detail.replies[0].reasoningContent, 'SECRET_THOUGHT_CONTINUED');
          assert.ok(detail.replies[0].timings.firstResponseMs >= 0);
        },
      );
      await t.test(
        'stale jobs become interrupted and orphan cleanup preserves referenced files',
        async () => {
          const body = input();
          const { journal } = await histories.begin(user.id, body, signal());
          await journal.replyStart(1);
          const toolId = await journal.toolStart(1, {
            id: 'stale-tool',
            type: 'function',
            function: { name: 'web_search', arguments: 'invalid json' },
          });
          await journal.finishError(new Error('fixture'));
          const old = new Date(Date.now() - 25 * 60 * 60_000);
          const saved = await storage.save(
            user.id,
            journal.row.id,
            'kept.json',
            'application/json',
            Buffer.from('{}'),
          );
          const orphan = await storage.save(
            user.id,
            journal.row.id,
            'orphan.json',
            'application/json',
            Buffer.from('{}'),
          );
          await utimes(join(storage.directory(user.id, journal.row.id), saved.key), old, old);
          await utimes(join(storage.directory(user.id, journal.row.id), orphan.key), old, old);
          await prisma.chatHistory.update({
            where: { id: journal.row.id },
            data: { status: 'RUNNING', heartbeatAt: old, resources: [saved] },
          });
          await prisma.chatReply.updateMany({
            where: { historyId: journal.row.id },
            data: { status: 'RUNNING' },
          });
          await prisma.chatToolCall.update({ where: { id: toolId }, data: { status: 'RUNNING' } });
          await histories.maintain();
          const detail = await histories.detail(user.id, journal.row.id);
          assert.equal(detail.history.status, 'INTERRUPTED');
          assert.equal(detail.replies[0].status, 'INTERRUPTED');
          assert.equal(detail.toolCalls[0].status, 'INTERRUPTED');
          await storage.read(user.id, journal.row.id, saved);
          await assert.rejects(
            storage.read(user.id, journal.row.id, orphan),
            (error) => error.getStatus() === 404,
          );
        },
      );
      await t.test(
        'history feed paginates ten records without duplicates across inserts and deleted anchors',
        async () => {
          const viewer = await prisma.user.create({
            data: {
              email: `${randomUUID()}@example.com`,
              name: '分页测试',
              passwordHash: 'fixture',
            },
          });
          const model = await prisma.chatModel.create({
            data: {
              userId: viewer.id,
              name: '历史模型',
              model: config.model,
              baseUrl: config.baseUrl,
              apiKey: config.apiKey,
            },
          });
          const conversationId = randomUUID();
          const ids = Array.from({ length: 23 }, () => randomUUID())
            .sort()
            .reverse();
          for (const [index, id] of ids.entries()) {
            await prisma.chatHistory.create({
              data: {
                id,
                userId: viewer.id,
                modelId: model.id,
                conversationId,
                requestId: randomUUID(),
                requestHash: 'a'.repeat(64),
                query: `问题 ${index}`,
                createdAt: new Date('2025-01-01T00:00:00Z'),
                status: 'SUCCEEDED',
                replies: {
                  create: {
                    round: 1,
                    sequence: 1,
                    content: `回答 ${index}`,
                    reasoningContent: index === 0 ? '历史思考内容' : null,
                    status: 'SUCCEEDED',
                    isFinal: true,
                  },
                },
              },
            });
          }
          const first = await histories.feed(viewer.id);
          assert.deepEqual(
            first.items.map((item) => item.id),
            ids.slice(0, 10),
          );
          assert.equal(first.items[0].reply.content, '回答 0');
          assert.equal(first.items[0].reply.reasoningContent, '历史思考内容');
          assert.equal(first.items[1].reply.reasoningContent, null);
          assert.deepEqual(first.items[0].model, { id: model.id, name: model.name });
          assert.equal(JSON.stringify(first).includes(config.apiKey), false);
          await prisma.chatHistory.create({
            data: {
              userId: viewer.id,
              modelId: model.id,
              conversationId,
              requestId: randomUUID(),
              requestHash: 'b'.repeat(64),
              query: '新问题',
              status: 'RUNNING',
            },
          });
          await prisma.chatHistory.update({
            where: { id: first.nextCursor },
            data: { deletedAt: new Date() },
          });
          const second = await histories.feed(viewer.id, first.nextCursor);
          const third = await histories.feed(viewer.id, second.nextCursor);
          assert.deepEqual(
            second.items.map((item) => item.id),
            ids.slice(10, 20),
          );
          assert.deepEqual(
            third.items.map((item) => item.id),
            ids.slice(20),
          );
          assert.equal(third.nextCursor, null);
          await assert.rejects(
            histories.feed(other.id, first.nextCursor),
            (error) => error.getStatus() === 400,
          );
          await prisma.user.delete({ where: { id: viewer.id } });
        },
      );
      await t.test(
        'soft-deleting a model retains its references and excludes it from new work',
        async () => {
          await service.delete(user.id, config.id);
          assert.equal((await service.list(user.id)).items.length, 0);
          assert.ok(
            (await prisma.chatModel.findUniqueOrThrow({ where: { id: config.id } })).deletedAt,
          );
          assert.equal(
            (await histories.detail(user.id, successful.historyId)).history.modelId,
            config.id,
          );
          await assert.rejects(
            service.complete(user.id, input(), signal()),
            (error) => error.getStatus() === 404,
          );
          assert.equal(
            (await service.complete(user.id, successfulInput, signal())).historyId,
            successful.historyId,
          );
          await prisma.user.delete({ where: { id: user.id } });
          assert.equal(await prisma.chatHistory.count({ where: { userId: user.id } }), 0);
        },
      );
    } finally {
      histories.onModuleDestroy();
      server.closeAllConnections();
      await new Promise((done) => server.close(done));
      await prisma.$disconnect();
      await admin.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.$disconnect();
      await rm(storageRoot, { recursive: true, force: true });
    }
  },
);
