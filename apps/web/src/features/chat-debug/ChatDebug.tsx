import { useEffect, useState } from 'react';
import { Button } from '@douyinfe/semi-ui';
import type { ChatModel } from '@repo/contracts';
import Icon from '../../components/common/Icon';
import ChatDebugPanel from './ChatDebugPanel';
import type { DebugRun } from './ChatDebugPanel';
import { subscribeChatRequests } from '../../services/chat-events';

export default function ChatDebug({ models }: { models: ChatModel[] }) {
  const [open, setOpen] = useState(false);
  const [runs, setRuns] = useState<DebugRun[]>([]);
  useEffect(
    () =>
      subscribeChatRequests((event) => {
        if (event.type === 'started') {
          setRuns((current) =>
            [
              ...current,
              {
                id: event.requestId,
                modelName:
                  models.find((model) => model.id === event.input.modelId)?.name ??
                  event.input.modelId,
                prompt: event.input.messages.at(-1)?.content || '图片提问',
                startedAt: new Date().toISOString(),
                status: 'pending' as const,
                history: event.input.messages.map((message) => ({
                  role: message.role,
                  content: [
                    message.content,
                    ...(message.images ?? []).map(
                      (image) => `[图片：${image.name}；图片数据已省略]`,
                    ),
                  ]
                    .filter(Boolean)
                    .join('\n'),
                })),
              },
            ].slice(-30),
          );
        } else {
          setRuns((current) =>
            current.map((run) =>
              run.id === event.requestId
                ? { ...run, status: event.status, ...(event.error ? { error: event.error } : {}) }
                : run,
            ),
          );
        }
      }),
    [models],
  );
  return (
    <>
      <Button
        icon={<Icon name="debug" />}
        aria-label="打开调试面板"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      />
      <ChatDebugPanel visible={open} runs={runs} onClose={() => setOpen(false)} />
    </>
  );
}
