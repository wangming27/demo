import { useState } from 'react';
import type { FormEvent } from 'react';
import { Banner, Button, SideSheet } from '@douyinfe/semi-ui';
import {
  DEFAULT_HISTORY_ROUNDS,
  MAX_HISTORY_ROUNDS,
  isHistoryRounds,
} from '../../pages/chat/chat-settings';
import type { ChatSettings } from '../../pages/chat/chat-settings';

interface Props {
  settings: ChatSettings;
  onSave: (settings: ChatSettings) => boolean;
  onClose: () => void;
}

export default function ConversationSettings({ settings, onSave, onClose }: Props) {
  const [rounds, setRounds] = useState(String(settings.historyRounds));
  const [error, setError] = useState('');

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const historyRounds = rounds.trim() ? Number(rounds) : NaN;
    if (!isHistoryRounds(historyRounds)) {
      setError(`请输入 0–${MAX_HISTORY_ROUNDS} 之间的整数`);
      return;
    }
    if (onSave({ historyRounds })) onClose();
    else setError('设置已在当前页面生效，但浏览器无法保存。刷新后将恢复之前的设置。');
  }

  return (
    <SideSheet
      title="会话配置"
      placement="right"
      visible
      motion={false}
      width="min(460px, 100vw)"
      onCancel={onClose}
    >
      <form onSubmit={save} className="space-y-6">
        <p className="text-sm leading-6 text-muted">
          设置从下一次发送生效，保存在当前浏览器，按登录账号分别保存。
        </p>
        <div className="rounded-xl border border-line p-4">
          <label htmlFor="chat-history-rounds" className="mb-3 block text-sm font-medium">
            携带历史轮数
          </label>
          <div className="flex items-center gap-3">
            <input
              id="chat-history-rounds"
              type="number"
              min={0}
              max={MAX_HISTORY_ROUNDS}
              step={1}
              required
              aria-describedby="chat-history-rounds-help"
              className="w-28 rounded-lg border border-line bg-surface px-3 py-2 text-sm outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100"
              value={rounds}
              onChange={(event) => {
                setRounds(event.target.value);
                setError('');
              }}
            />
            <span className="text-sm text-muted">轮（0–{MAX_HISTORY_ROUNDS}）</span>
          </div>
          <p id="chat-history-rounds-help" className="mt-3 text-xs leading-5 text-muted">
            一轮是一次提问和完整回复。设为 0 时只发送当前问题；大于 0
            时，携带当前会话最近的完整历史，最多为设置的轮数。
          </p>
        </div>
        <p className="text-xs leading-5 text-muted">
          历史记录仍会保存并显示。失败或中断的回复不计入历史轮数，文本和图片较大时可能携带更少的历史。
        </p>
        {error && (
          <div role="alert">
            <Banner type="warning" description={error} closeIcon={null} />
          </div>
        )}
        <div className="flex items-center justify-between gap-3">
          <Button
            onClick={() => {
              setRounds(String(DEFAULT_HISTORY_ROUNDS));
              setError('');
            }}
          >
            恢复默认
          </Button>
          <Button theme="solid" htmlType="submit">
            保存配置
          </Button>
        </div>
      </form>
    </SideSheet>
  );
}
