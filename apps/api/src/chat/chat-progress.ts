import type { ChatStreamEvent, ChatTiming } from '@repo/contracts';

export type ModelDelta = Extract<ChatStreamEvent, { type: 'delta' }>;
export interface ModelObserver {
  modelStart(round: number): void;
  delta(event: ModelDelta): void;
  modelEnd(): void;
}

export class ChatProgress implements ModelObserver {
  private readonly started: number;
  private timing: ChatTiming = {
    elapsedMs: 0,
    firstResponseMs: null,
    phase: 'waiting',
    thoughts: [],
    tools: [],
  };
  constructor(
    private readonly emit: (event: ChatStreamEvent) => void,
    private readonly clock = () => performance.now(),
  ) {
    this.started = clock();
  }
  snapshot(): ChatTiming {
    return structuredClone({
      ...this.timing,
      elapsedMs: this.timing.phase === 'done' ? this.timing.elapsedMs : this.clock() - this.started,
    });
  }
  private state() {
    this.emit({ type: 'state', timing: this.snapshot() });
  }
  private closeThought() {
    const thought = this.timing.thoughts.at(-1);
    if (thought?.endMs === null) thought.endMs = this.clock() - this.started;
  }
  modelStart() {
    this.timing.phase = 'waiting';
    this.state();
  }
  delta(event: ModelDelta) {
    if (!event.reasoning && !event.content && !event.toolCall) return;
    const now = this.clock() - this.started;
    let changed = false;
    if (this.timing.firstResponseMs === null) {
      this.timing.firstResponseMs = now;
      changed = true;
    }
    const phase = event.reasoning ? 'thinking' : 'answering';
    if (this.timing.phase !== phase) {
      this.closeThought();
      this.timing.phase = phase;
      if (phase === 'thinking') {
        if (this.timing.thoughts.length >= 32) throw new Error('模型思考阶段过多');
        this.timing.thoughts.push({ round: event.round, startMs: now, endMs: null });
      }
      changed = true;
    }
    // Emit the meaningful delta first so browser first-response measurement excludes state frames.
    this.emit(event);
    if (changed) this.state();
  }
  modelEnd() {
    this.closeThought();
    this.timing.phase = 'finishing';
    this.state();
  }
  toolStart(round: number, id: string, name: string) {
    this.timing.phase = 'tool';
    this.timing.tools.push({ round, id, name, startMs: this.clock() - this.started, endMs: null });
    this.state();
  }
  toolEnd() {
    const tool = this.timing.tools.at(-1);
    if (tool?.endMs === null) tool.endMs = this.clock() - this.started;
    this.timing.phase = 'finishing';
    this.state();
  }
  finish(): ChatTiming {
    if (this.timing.phase === 'done') return this.snapshot();
    this.closeThought();
    const tool = this.timing.tools.at(-1);
    if (tool?.endMs === null) tool.endMs = this.clock() - this.started;
    this.timing.phase = 'done';
    this.timing.elapsedMs = this.clock() - this.started;
    return this.snapshot();
  }
}
