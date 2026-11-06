import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { type BaseMessage, ToolMessage } from '@langchain/core/messages';
import type { ToolCall } from '@langchain/core/messages/tool';
import type { StructuredToolInterface } from '@langchain/core/tools';
import {
  Annotation,
  type BaseCheckpointSaver,
  END,
  interrupt,
  messagesStateReducer,
  Send,
  START,
  StateGraph,
} from '@langchain/langgraph';
import { tokensUsed } from '../models/provider.ts';
import { requiresApproval } from '../skills/policy.ts';
import { ASK_USER } from '../skills/tools/ask.ts';

export interface ApprovalRequest {
  tool: string;
  args: Record<string, unknown>;
}

export interface ApprovalDecision {
  approved: boolean;
  /** ask_user: what the user answered. */
  answer?: string | null;
}

export const MAX_MODEL_TURNS = 25; // the runner sets recursionLimit = 2 × turns + 1

const StepState = Annotation.Root({
  messages: Annotation<BaseMessage[]>({ reducer: messagesStateReducer, default: () => [] }),
});

export interface StepAgentOptions {
  model: BaseChatModel;
  tools: StructuredToolInterface[];
  autoApprove: ReadonlySet<string>;
  /** God mode: run every tool call without asking. */
  approveAll?: boolean;
  checkpointer: BaseCheckpointSaver;
  /**
   * Runs before each model turn; throws to stop the step (e.g. the task was cancelled).
   * Returns notes from the user to add to the conversation, and a callback that marks them
   * delivered once the model has answered.
   */
  beforeTurn: () => Promise<{ notes: BaseMessage[]; delivered: () => Promise<void> } | undefined>;
  /** Runs once per tool execution, after any approval; used for the step.tool_call event. */
  onToolCall: (tool: string, args: Record<string, unknown>, autoApproved: boolean) => Promise<void>;
}

export function buildStepAgent(o: StepAgentOptions) {
  const byName = new Map(o.tools.map((t) => [t.name, t]));
  const model = o.tools.length && o.model.bindTools ? o.model.bindTools(o.tools) : o.model;

  async function runToolCall(call: ToolCall): Promise<string> {
    const tool = byName.get(call.name);
    if (!tool) {
      return `Error: unknown tool "${call.name}". Available: ${[...byName.keys()].join(', ')}.`;
    }
    // ask_user always waits for the user, whatever the approval setting.
    if (call.name === ASK_USER) {
      const decision = interrupt<ApprovalRequest, ApprovalDecision>({
        tool: call.name,
        args: call.args,
      });
      await o.onToolCall(call.name, call.args, false);
      return decision.approved && decision.answer
        ? `The user answered: ${decision.answer}`
        : 'The user skipped this question. Make a sensible assumption, say what you assumed, and go on.';
    }
    const gated = requiresApproval(call.name, o.autoApprove);
    if (gated && !o.approveAll) {
      // Everything above this line re-runs on resume, so it must have no side effects.
      const decision = interrupt<ApprovalRequest, ApprovalDecision>({
        tool: call.name,
        args: call.args,
      });
      if (!decision.approved) {
        return 'The user denied this tool call. Continue without it, or say what you need.';
      }
    }
    await o.onToolCall(call.name, call.args, gated);
    try {
      const result = await tool.invoke(call.args);
      return typeof result === 'string' ? result : JSON.stringify(result);
    } catch (error) {
      return `Error: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  return (
    new StateGraph(StepState)
      .addNode('model', async (s) => {
        const inbox = await o.beforeTurn();
        const notes = inbox?.notes ?? [];
        const reply = await model.invoke([...s.messages, ...notes]);
        await inbox?.delivered();
        return { messages: [...notes, reply] };
      })
      // One task per tool call: after an approval LangGraph re-runs only the interrupted call
      // (verified on LangGraph.js 1.7, 2026-11-05).
      .addNode('tool', async (call: ToolCall) => ({
        messages: [
          new ToolMessage({
            tool_call_id: call.id ?? '',
            name: call.name,
            content: await runToolCall(call),
          }),
        ],
      }))
      .addEdge(START, 'model')
      .addConditionalEdges(
        'model',
        (s) => {
          const calls = (s.messages.at(-1) as { tool_calls?: ToolCall[] }).tool_calls ?? [];
          return calls.length ? calls.map((c) => new Send('tool', c)) : END;
        },
        ['tool', END],
      )
      .addEdge('tool', 'model')
      .compile({ checkpointer: o.checkpointer })
  );
}

const textOf = (content: BaseMessage['content']): string =>
  typeof content === 'string'
    ? content
    : content
        .map((part) => (typeof part === 'object' && 'text' in part ? String(part.text) : ''))
        .join('');

/** Text of the final AI message, and total tokens across every model turn (including before a pause). */
export function summarize(messages: readonly BaseMessage[]): { output: string; tokens: number } {
  const ai = messages.filter((m) => m.getType() === 'ai');
  const tokens = ai.reduce((sum, m) => sum + tokensUsed(m as Parameters<typeof tokensUsed>[0]), 0);
  const last = ai.at(-1);
  return { output: last ? textOf(last.content).trim() : '', tokens };
}
