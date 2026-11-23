/** Incremental SSE framing; callers decode UTF-8 with a streaming TextDecoder. */
export class SseDecoder {
  private buffer = '';
  private data: string[] = [];
  private size = 0;

  push(text: string): string[] {
    this.buffer += text;
    const events: string[] = [];
    while (true) {
      const match = /[\r\n]/.exec(this.buffer);
      if (!match || (match[0] === '\r' && match.index === this.buffer.length - 1)) break;
      const line = this.buffer.slice(0, match.index);
      const length =
        match.index + (this.buffer.slice(match.index, match.index + 2) === '\r\n' ? 2 : 1);
      this.buffer = this.buffer.slice(length);
      if (!line) {
        if (this.data.length) events.push(this.data.join('\n'));
        this.data = [];
        this.size = 0;
      } else if (line.startsWith('data:')) {
        const value = line.slice(5).replace(/^ /, '');
        this.size += value.length;
        if (this.size > 1_000_000) throw new Error('流式事件过大');
        this.data.push(value);
      }
    }
    if (this.buffer.length > 1_000_000) throw new Error('流式事件过大');
    return events;
  }
}
