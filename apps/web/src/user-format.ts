export function formatDate(value: string, includeTime = false) {
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    ...(includeTime ? ({ hour: '2-digit', minute: '2-digit' } as const) : {}),
  }).format(new Date(value));
}

export function initialOf(name: string) {
  return Array.from(name.trim())[0]?.toLocaleUpperCase() ?? 'U';
}
