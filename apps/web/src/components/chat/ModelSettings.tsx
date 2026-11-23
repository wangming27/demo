import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import {
  Banner,
  Button,
  Input,
  Popconfirm,
  Select,
  SideSheet,
  Tabs,
  TabPane,
} from '@douyinfe/semi-ui';
import { ApiError, createChatModel, deleteChatModel, updateChatModel } from '../../services/api';
import type { ChatModel } from '../../services/api';
import Icon from '../common/Icon';

const presets = [
  {
    value: 'openai',
    label: 'OpenAI',
    name: 'GPT-4o mini',
    model: 'gpt-4o-mini',
    baseUrl: 'https://api.openai.com/v1',
  },
  {
    value: 'deepseek',
    label: 'DeepSeek',
    name: 'DeepSeek Chat',
    model: 'deepseek-chat',
    baseUrl: 'https://api.deepseek.com/v1',
  },
  {
    value: 'qwen',
    label: '通义千问',
    name: 'Qwen Plus',
    model: 'qwen-plus',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  },
  { value: 'custom', label: '自定义（OpenAI 兼容）', name: '', model: '', baseUrl: '' },
];

interface Props {
  models: ChatModel[];
  visible: boolean;
  onClose: () => void;
  onSaved: (model: ChatModel) => void;
  onDeleted: (id: string) => void;
  onSessionExpired: () => void;
}

export default function ModelSettings({
  models,
  visible,
  onClose,
  onSaved,
  onDeleted,
  onSessionExpired,
}: Props) {
  const [editing, setEditing] = useState<ChatModel | null>(null);
  const [preset, setPreset] = useState('openai');
  const [name, setName] = useState(presets[0]!.name);
  const [model, setModel] = useState(presets[0]!.model);
  const [baseUrl, setBaseUrl] = useState(presets[0]!.baseUrl);
  const [apiKey, setApiKey] = useState('');
  const [contextWindow, setContextWindow] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const requestRef = useRef<AbortController | null>(null);
  useEffect(() => () => requestRef.current?.abort(), []);

  function reset() {
    setEditing(null);
    setPreset('openai');
    setName(presets[0]!.name);
    setModel(presets[0]!.model);
    setBaseUrl(presets[0]!.baseUrl);
    setApiKey('');
    setContextWindow('');
    setError('');
  }

  function fail(error: unknown) {
    if (error instanceof ApiError && error.status === 401) onSessionExpired();
    else setError(error instanceof Error ? error.message : '操作失败，请重试');
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (requestRef.current) return;
    const controller = new AbortController();
    requestRef.current = controller;
    setPending(true);
    setError('');
    try {
      const input = {
        name: name.trim(),
        model: model.trim(),
        baseUrl: baseUrl.trim(),
        contextWindow: contextWindow.trim() ? Number(contextWindow) : null,
      };
      const saved = editing
        ? await updateChatModel(
            editing.id,
            { ...input, ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}) },
            controller.signal,
          )
        : await createChatModel({ ...input, apiKey: apiKey.trim() }, controller.signal);
      if (!controller.signal.aborted) {
        onSaved(saved);
        reset();
      }
    } catch (error: unknown) {
      if (!controller.signal.aborted) fail(error);
    } finally {
      requestRef.current = null;
      if (!controller.signal.aborted) setPending(false);
    }
  }

  async function remove(id: string) {
    if (requestRef.current) return;
    const controller = new AbortController();
    requestRef.current = controller;
    setPending(true);
    setError('');
    try {
      await deleteChatModel(id, controller.signal);
      if (!controller.signal.aborted) {
        onDeleted(id);
        if (editing?.id === id) reset();
      }
    } catch (error: unknown) {
      if (!controller.signal.aborted) fail(error);
    } finally {
      requestRef.current = null;
      if (!controller.signal.aborted) setPending(false);
    }
  }

  return (
    <SideSheet
      title="Chat 配置"
      placement="right"
      visible={visible}
      motion={false}
      width="min(460px, 100vw)"
      onCancel={() => {
        if (!pending) {
          setApiKey('');
          onClose();
        }
      }}
      maskClosable={!pending}
      closeOnEsc={!pending}
    >
      <Tabs type="line" defaultActiveKey="models">
        <TabPane tab="模型配置" itemKey="models">
          <p className="my-4 text-sm leading-6 text-muted">
            配置你常用的模型。配置仅当前账号可见，列表中的第一个模型为默认模型。
          </p>
          <div className="mb-6 space-y-3">
            {models.map((item, index) => (
              <div
                key={item.id}
                className="flex items-center justify-between gap-3 rounded-xl border border-line p-3"
              >
                <div className="min-w-0">
                  <p className="truncate font-medium">
                    {item.name}
                    {index === 0 && <span className="ml-2 text-xs text-indigo-500">默认</span>}
                  </p>
                  <p className="mt-1 truncate text-xs text-muted">{item.model}</p>
                </div>
                <div className="flex shrink-0 gap-1">
                  <Button
                    size="small"
                    disabled={pending}
                    onClick={() => {
                      setEditing(item);
                      setPreset('custom');
                      setName(item.name);
                      setModel(item.model);
                      setBaseUrl(item.baseUrl);
                      setApiKey('');
                      setContextWindow(item.contextWindow?.toString() ?? '');
                      setError('');
                    }}
                  >
                    编辑
                  </Button>
                  <Popconfirm
                    title={`删除 ${item.name}？`}
                    content="删除后将无法继续使用该配置。"
                    onConfirm={() => remove(item.id)}
                  >
                    <Button
                      theme="borderless"
                      type="danger"
                      size="small"
                      disabled={pending}
                      icon={<Icon name="trash" />}
                      aria-label={`删除 ${item.name}`}
                    />
                  </Popconfirm>
                </div>
              </div>
            ))}
          </div>
          <form onSubmit={(event) => void save(event)} aria-busy={pending}>
            <fieldset disabled={pending} className="space-y-4">
              <div className="flex items-center justify-between">
                <h2 className="font-semibold">{editing ? '编辑模型' : '添加模型'}</h2>
                {editing && (
                  <Button size="small" disabled={pending} onClick={reset}>
                    添加新模型
                  </Button>
                )}
              </div>
              {!editing && (
                <div className="space-y-2">
                  <label id="model-provider-label" htmlFor="model-provider" className="text-sm">
                    常用服务商
                  </label>
                  <Select
                    id="model-provider"
                    className="w-full"
                    aria-labelledby="model-provider-label"
                    value={preset}
                    disabled={pending}
                    optionList={presets}
                    onChange={(value) => {
                      const selected = presets.find((item) => item.value === value);
                      if (selected) {
                        setPreset(selected.value);
                        setName(selected.name);
                        setModel(selected.model);
                        setBaseUrl(selected.baseUrl);
                        setApiKey('');
                        setContextWindow('');
                      }
                    }}
                  />
                </div>
              )}
              <label className="block space-y-2 text-sm" htmlFor="model-name">
                显示名称
                <Input
                  id="model-name"
                  value={name}
                  onChange={setName}
                  disabled={pending}
                  required
                  maxLength={80}
                  placeholder="例如：日常助手"
                />
              </label>
              <label className="block space-y-2 text-sm" htmlFor="model-id">
                模型名称
                <Input
                  id="model-id"
                  value={model}
                  onChange={setModel}
                  disabled={pending}
                  required
                  maxLength={200}
                  placeholder="例如：gpt-4o-mini"
                />
              </label>
              <label className="block space-y-2 text-sm" htmlFor="model-url">
                API Base URL
                <Input
                  id="model-url"
                  value={baseUrl}
                  onChange={setBaseUrl}
                  disabled={pending}
                  type="url"
                  required
                  maxLength={2048}
                  placeholder="https://api.example.com/v1"
                />
                <span className="block text-xs text-muted">
                  使用 OpenAI 兼容接口，支持填写 Base URL 或完整的 /chat/completions 地址。
                </span>
              </label>
              <label className="block space-y-2 text-sm" htmlFor="model-key">
                API Key
                <Input
                  id="model-key"
                  mode="password"
                  autoComplete="new-password"
                  value={apiKey}
                  onChange={setApiKey}
                  disabled={pending}
                  required={!editing}
                  maxLength={4096}
                  placeholder={editing ? '已保存，留空保持不变' : '输入服务商 API Key'}
                />
                <span className="block text-xs text-muted">
                  密钥保存在服务端，保存后不会返回浏览器。
                </span>
              </label>
              <label className="block space-y-2 text-sm" htmlFor="model-context-window">
                上下文窗口（tokens，可选）
                <input
                  id="model-context-window"
                  type="number"
                  min={1}
                  max={2147483647}
                  step={1}
                  value={contextWindow}
                  onChange={(event) => setContextWindow(event.target.value)}
                  className="w-full rounded-lg border border-line bg-canvas px-3 py-2"
                  placeholder="例如：131072"
                />
                <span className="block text-xs text-muted">
                  本地 Ollama 优先读取运行窗口；其他服务填写实际设置，留空显示未知。
                </span>
              </label>
              {error && (
                <div role="alert">
                  <Banner type="danger" description={error} closeIcon={null} />
                </div>
              )}
              <Button theme="solid" htmlType="submit" block loading={pending} disabled={pending}>
                {editing ? '保存修改' : '添加模型'}
              </Button>
            </fieldset>
          </form>
        </TabPane>
      </Tabs>
    </SideSheet>
  );
}
