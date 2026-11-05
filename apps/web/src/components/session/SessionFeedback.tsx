import { Banner, Button, Card, Spin } from '@douyinfe/semi-ui';
import Icon from '../common/Icon';

interface Props {
  state: { status: 'loading' } | { status: 'error'; message: string };
  onRetry: () => void;
}

export default function SessionFeedback({ state, onRetry }: Props) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-canvas px-6">
      <Card className="w-full max-w-md text-center" bodyStyle={{ padding: 40 }}>
        <span className="mb-4 inline-flex size-12 items-center justify-center rounded-xl bg-indigo-500 text-white">
          <Icon name="layers" />
        </span>
        <h1 className="mb-6 text-2xl font-semibold">Demo Console</h1>
        {state.status === 'loading' ? (
          <div className="flex items-center justify-center gap-3 text-muted" role="status">
            <Spin size="small" /> 正在确认登录状态…
          </div>
        ) : (
          <>
            <div role="alert">
              <Banner className="mb-6" type="danger" description={state.message} closeIcon={null} />
            </div>
            <Button theme="solid" onClick={onRetry}>
              重新连接
            </Button>
          </>
        )}
      </Card>
    </main>
  );
}
