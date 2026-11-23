import type { ModelTurn } from './model-api';
import type { ModelDelta } from './chat-progress';
import type { ToolResult } from './web-tools.service';

export interface ChatRecording {
  replyStart(round: number): Promise<void>;
  delta(event: ModelDelta): void;
  replyEnd(round: number, turn: ModelTurn): Promise<void>;
  replyError(round: number, error: unknown): Promise<void>;
  toolStart(round: number, call: NonNullable<ModelTurn['tool_calls']>[number]): Promise<string>;
  toolEnd(id: string, result: ToolResult): Promise<void>;
  toolError(id: string, error: unknown): Promise<void>;
}
