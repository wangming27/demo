import { Card } from '@douyinfe/semi-ui';
import { Link } from 'react-router';

export default function NotFoundPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-canvas px-6">
      <Card className="w-full max-w-md text-center" bodyStyle={{ padding: 40 }}>
        <p className="mb-4 text-5xl font-semibold text-indigo-500">404</p>
        <h1 className="text-2xl font-semibold">页面不存在</h1>
        <p className="my-5 text-muted">请检查访问地址，或返回工作台。</p>
        <Link to="/" className="text-sm font-medium text-indigo-600">
          返回工作台
        </Link>
      </Card>
    </main>
  );
}
