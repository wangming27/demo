import type { ChatCompletionResponse } from '@repo/contracts';

interface Props {
  usage?: ChatCompletionResponse['usage'];
  contextUsage?: ChatCompletionResponse['contextUsage'];
}

const number = new Intl.NumberFormat('zh-CN');
const percent = new Intl.NumberFormat('zh-CN', {
  style: 'percent',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const labels = {
  runtime: '运行窗口',
  configured: '配置窗口',
  declared: '模型声明上限',
  unknown: '窗口',
};

export default function ContextUsage({ usage, contextUsage }: Props) {
  const used = usage ? usage.inputTokens + usage.outputTokens : null;
  const window = contextUsage?.windowTokens ?? null;
  const remaining = used !== null && window !== null ? Math.max(0, window - used) : null;
  const ratio = used !== null && window !== null ? Math.min(100, (used / window) * 100) : null;
  const display = (value: number | null) => (value === null ? '未知' : number.format(value));
  const displayPercent = (value: number | null) =>
    value !== null && window !== null ? `（${percent.format(value / window)}）` : '';
  return (
    <div className="mt-4 space-y-2 border-t border-line pt-3 text-xs text-muted">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 tabular-nums">
        <span>
          本轮已用 {display(used)} tokens{displayPercent(used)}
        </span>
        <span>
          {contextUsage?.source === 'declared' ? '剩余（按上限）' : '剩余'} {display(remaining)}{' '}
          tokens{displayPercent(remaining)}
        </span>
        <span>
          {labels[contextUsage?.source ?? 'unknown']} {display(window)} tokens
        </span>
      </div>
      {ratio !== null && (
        <div
          role="progressbar"
          aria-label="本轮上下文使用比例"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(ratio * 100) / 100}
          aria-valuetext={`已用 ${display(used)} tokens${displayPercent(used)}，剩余 ${display(remaining)} tokens${displayPercent(remaining)}`}
          className="h-1.5 overflow-hidden rounded-full bg-canvas"
        >
          <div
            className={`h-full rounded-full ${ratio >= 90 ? 'bg-amber-500' : 'bg-indigo-500'}`}
            style={{ width: `${ratio}%` }}
          />
        </div>
      )}
      <details>
        <summary className="cursor-pointer">统计说明</summary>
        <p className="mt-2 leading-5">
          {usage
            ? `输入 ${display(usage.inputTokens)} + 输出 ${display(usage.outputTokens)} tokens。`
            : '模型接口未返回 token 用量，无法计算已用和剩余。'}
          统计本轮最后一次推理的输入与输出，包含该次输入的历史、图片和工具资料，以及服务计入的思考输出。剩余为窗口减去已用，不代表下一轮还能发送的准确字数；多次工具调用不累计。
          {contextUsage?.source === 'declared' &&
            ' 当前仅获取到模型声明上限，实际运行窗口可能更小。'}
          {contextUsage?.source === 'configured' && ' 窗口取自手动配置，请与推理服务设置保持一致。'}
          {!window && ' 可在模型配置中填写上下文窗口大小。'}
          {used !== null &&
            window !== null &&
            used > window &&
            ' 返回用量已超过窗口，请核对服务设置。'}
        </p>
      </details>
    </div>
  );
}
