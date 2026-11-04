export interface HealthResponse {
  status: 'ok';
  service: string;
  timestamp: string;
}

function isHealthResponse(value: unknown): value is HealthResponse {
  return (
    typeof value === 'object' &&
    value !== null &&
    'status' in value &&
    value.status === 'ok' &&
    'service' in value &&
    typeof value.service === 'string' &&
    'timestamp' in value &&
    typeof value.timestamp === 'string' &&
    Number.isFinite(Date.parse(value.timestamp))
  );
}

export async function getHealth(signal?: AbortSignal): Promise<HealthResponse> {
  const response = await fetch('/api/health', signal ? { signal } : {});

  if (!response.ok) {
    throw new Error(`服务请求失败（HTTP ${response.status}）`);
  }

  const data: unknown = await response.json();

  if (!isHealthResponse(data)) {
    throw new Error('服务返回了无法识别的数据');
  }

  return data;
}
