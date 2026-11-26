import { randomUUID } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import type { AgentStatus, ApprovalDecision, ApprovalRequest, Command, Ctx, JsonValue, ModelRequest, ModelUsage, Plugin, Provider, Registry, Session, SessionEventInput, StepRef, Tool, ToolCall, ToolCtx, ToolResult, TurnOutcome } from '@extendo/contracts';
import { createRegistry } from '@extendo/kernel';
import { projectModelMessages, type SessionStore } from '@extendo/session';
import { z } from 'zod';
import { contextForStep } from './compaction.js';

export interface SystemSection {
  name: string;
  text(context: { session: Session; turnId: string; stepId: string }): string | Promise<string>;
}

export type TurnResult =
  | { turnId: string; outcome: 'completed'; final: string }
  | { turnId: string; outcome: 'cancelled' | 'failed'; error: string };

export interface TurnHandle {
  turnId: string;
  done: Promise<TurnResult>;
}

export interface SendOptions {
  provider: string;
  model: string;
  interactive?: boolean;
  /**
   * Answers an approval without a person. Delegated work runs unattended, so a worker's turn
   * supplies a policy that approves only what its own worktree confines. Returning true allows the
   * call; returning false falls through to the person, or denies it when the turn is not interactive.
   */
  approve?: (call: ToolCall, context: ToolCtx) => boolean;
}

export interface AgentOptions {
  maxSteps?: number;
  contextChars?: number;
}

interface RunningTurn {
  controller: AbortController;
  done: Promise<TurnResult>;
}

type PendingApproval = { request: ApprovalRequest; resolve(decision: ApprovalDecision): void };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function failCall(call: ToolCall, output: string): ToolResult {
  return { callId: call.id, name: call.name, output, isError: true };
}

function toJson(value: unknown): JsonValue {
  const text = JSON.stringify(value);
  return text === undefined ? null : JSON.parse(text) as JsonValue;
}

export function capabilitiesPlugin(): Plugin {
  return {
    name: 'capabilities',
    apply(ctx) {
      ctx.provide('tools', createRegistry<Tool>());
      ctx.provide('providers', createRegistry<Provider>());
      ctx.provide('system', createRegistry<SystemSection>());
      ctx.provide('commands', createRegistry<Command>());
    },
  };
}

export interface AgentRuntime {
  start(sessionId: string, input: string, options: SendOptions): TurnHandle;
  status(sessionId: string): AgentStatus;
  cancel(sessionId: string): boolean;
  approvals(sessionId: string): ApprovalRequest[];
  answer(sessionId: string, requestId: string, decision: ApprovalDecision): boolean;
  /** Delivers input to the running turn at its next step. Returns false when no turn is running. */
  steer(sessionId: string, input: string): boolean;
  /** Holds input until the running turn ends, then starts the next turn with it. */
  queue(sessionId: string, input: string, options: SendOptions): boolean;
  shutdown(): Promise<void>;
}

export class Agent implements AgentRuntime {
  private readonly turns = new Map<string, RunningTurn>();
  private readonly outcomes = new Map<string, AgentStatus>();
  private readonly pending = new Map<string, PendingApproval>();
  private readonly remembered = new Map<string, Set<string>>();
  private readonly steers = new Map<string, string[]>();
  private readonly queued = new Map<string, { input: string; options: SendOptions }>();

  constructor(private readonly ctx: Ctx, private readonly sessions: SessionStore, private readonly options: AgentOptions = {}) {}

  start(sessionId: string, input: string, options: SendOptions): TurnHandle {
    if (this.turns.has(sessionId)) throw new Error('Session already has an active turn');
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error('Unknown session');
    if (!input.trim()) throw new Error('Message is empty');
    const provider = this.ctx.get<Registry<Provider>>('providers').get(options.provider);
    if (!provider) throw new Error('Unknown provider');
    this.sessions.resume(sessionId);
    const turnId = randomUUID();
    const controller = new AbortController();
    const done = setImmediate().then(() => this.run(session, input, options, provider, turnId, controller.signal));
    this.outcomes.delete(sessionId);
    this.turns.set(sessionId, { controller, done });
    return { turnId, done };
  }

  status(sessionId: string): AgentStatus {
    return this.outcomes.get(sessionId) ?? (this.turns.has(sessionId) ? 'working' : 'idle');
  }

  cancel(sessionId: string): boolean {
    const turn = this.turns.get(sessionId);
    if (!turn || turn.controller.signal.aborted) return false;
    turn.controller.abort(new Error('Turn cancelled'));
    return true;
  }

  approvals(sessionId: string): ApprovalRequest[] {
    return [...this.pending.values()].flatMap(({ request }) => request.sessionId === sessionId ? [request] : []);
  }

  answer(sessionId: string, requestId: string, decision: ApprovalDecision): boolean {
    const pending = this.pending.get(requestId);
    if (!pending || pending.request.sessionId !== sessionId) return false;
    pending.resolve(decision);
    this.ctx.emit('tool/approval-answered', { sessionId, requestId, decision });
    return true;
  }

  steer(sessionId: string, input: string): boolean {
    if (!this.turns.has(sessionId) || !input.trim()) return false;
    const pending = this.steers.get(sessionId) ?? [];
    pending.push(input.trim());
    this.steers.set(sessionId, pending);
    return true;
  }

  queue(sessionId: string, input: string, options: SendOptions): boolean {
    if (!input.trim() || this.queued.has(sessionId)) return false;
    this.queued.set(sessionId, { input: input.trim(), options });
    return true;
  }

  private takeSteers(sessionId: string): string[] {
    const pending = this.steers.get(sessionId);
    if (!pending?.length) return [];
    this.steers.delete(sessionId);
    return pending;
  }

  private drainQueue(sessionId: string): void {
    const next = this.queued.get(sessionId);
    if (!next) return;
    this.queued.delete(sessionId);
    try {
      const handle = this.start(sessionId, next.input, next.options);
      void handle.done.catch(() => this.ctx.logger.warn('Queued turn could not be settled'));
    } catch (error) {
      this.ctx.logger.warn(`Queued turn did not start: ${errorMessage(error)}`);
    }
  }

  async shutdown(): Promise<void> {
    const turns = [...this.turns.entries()];
    for (const [sessionId] of turns) this.cancel(sessionId);
    await Promise.allSettled(turns.map(([, turn]) => turn.done));
  }

  private setStatus(sessionId: string, status: AgentStatus): void {
    this.outcomes.set(sessionId, status);
    this.ctx.emit('agent/status', { sessionId, status });
  }

  private async approval(call: ToolCall, context: ToolCtx, interactive: boolean): Promise<boolean> {
    const { sessionId, turnId, stepId, signal, ctx } = context;
    const key = JSON.stringify([call.name, call.input]);
    if (!interactive) return false;
    if (this.remembered.get(sessionId)?.has(key)) return true;
    signal.throwIfAborted();
    const request: ApprovalRequest = { requestId: randomUUID(), sessionId, turnId, stepId, call };
    const decision = await new Promise<ApprovalDecision>((resolve, reject) => {
      const abort = () => {
        this.pending.delete(request.requestId);
        reject(signal.reason);
      };
      signal.addEventListener('abort', abort, { once: true });
      this.pending.set(request.requestId, {
        request,
        resolve: (value) => {
          this.pending.delete(request.requestId);
          signal.removeEventListener('abort', abort);
          resolve(value);
        },
      });
      this.setStatus(sessionId, 'waiting');
      if (!signal.aborted) ctx.emit('tool/approval', request);
    });
    signal.throwIfAborted();
    this.setStatus(sessionId, 'working');
    if (decision === 'always') {
      const approvals = this.remembered.get(sessionId) ?? new Set();
      approvals.add(key);
      this.remembered.set(sessionId, approvals);
    }
    return decision !== 'deny';
  }

  private async runTool(call: ToolCall, context: ToolCtx, tools: Map<string, Tool>, interactive: boolean, approve?: SendOptions['approve']): Promise<ToolResult> {
    const { ctx, signal } = context;
    let result: ToolResult;
    try {
      signal.throwIfAborted();
      const prepared = await ctx.waterfall('tools/pre-execute', { call: structuredClone(call), context });
      signal.throwIfAborted();
      const offered = prepared.call;
      const tool = tools.get(offered.name);
      if (prepared.denied) result = failCall(call, prepared.denied);
      else if (!tool) result = failCall(call, `Unknown tool: ${offered.name}`);
      else {
        const input = await tool.input.safeParseAsync(offered.input);
        signal.throwIfAborted();
        if (!input.success) result = failCall(call, 'Invalid tool input: ' + input.error.issues.map(({ path, message }) => `${path.join('.')}: ${message}`).join('; '));
        else if ((tool.needsApproval ?? !tool.readOnly) && !(approve?.(offered, context) ?? false) && !await this.approval(offered, context, interactive)) result = failCall(call, 'Tool execution was not approved');
        else {
          const approved = JSON.stringify(offered);
          const executed = await ctx.waterfall('tools/execute', { call: structuredClone(offered), context }, async (value) => {
            signal.throwIfAborted();
            if (JSON.stringify(value.call) !== approved) throw new Error('Tool call changed after validation; change it in tools/pre-execute instead');
            return { ...value, result: { callId: call.id, name: call.name, output: toJson(await tool.execute(input.data, context)), isError: false } };
          });
          result = executed.result ?? failCall(call, 'No tool result was supplied');
        }
      }
    } catch (error) {
      signal.throwIfAborted();
      result = failCall(call, errorMessage(error));
    }
    signal.throwIfAborted();
    try {
      const post = await ctx.waterfall('tools/post-execute', { call, context, result });
      return { ...post.result, callId: call.id, name: call.name };
    } catch (error) {
      signal.throwIfAborted();
      return failCall(call, errorMessage(error));
    }
  }

  private async run(session: Session, input: string, options: SendOptions, provider: Provider, turnId: string, signal: AbortSignal): Promise<TurnResult> {
    const sessionId = session.id;
    const ctx = this.ctx.fork(sessionId);
    const add = (event: SessionEventInput) => this.sessions.append(sessionId, event);
    let final = '';
    let result: TurnResult;
    let turnStarted = false;
    try {
      this.setStatus(sessionId, 'working');
      add({ type: 'turn/start', data: { turnId, provider: provider.id, model: options.model } });
      turnStarted = true;
      for (let index = 0; ; index++) {
        signal.throwIfAborted();
        if (index >= (this.options.maxSteps ?? 12)) throw new Error('Turn exceeded the maximum number of steps');
        const stepId = randomUUID();
        const ref: StepRef = { turnId, stepId };
        const messageId = randomUUID();
        const currentInput = index === 0 ? input : undefined;
        for (const steered of this.takeSteers(sessionId)) {
          add({ type: 'user/message', data: { turnId, messageId: randomUUID(), content: steered } });
        }
        const tools = new Map(ctx.get<Registry<Tool>>('tools').list().map((tool) => [tool.name, tool]));
        const system = (await Promise.all(ctx.get<Registry<SystemSection>>('system').list().map((section) => section.text({ session, ...ref })))).filter((text) => text.trim());
        const pre = await ctx.waterfall('agent/pre-step', { ...ref, sessionId, input: currentInput });
        signal.throwIfAborted();
        if (pre.skip || (index === 0 && !pre.input?.trim())) break;
        add({ type: 'step/start', data: ref });
        let text = '';
        let reasoning = '';
        let usage: ModelUsage | undefined;
        let completedStream = false;
        let committed = false;
        const calls = new Map<string, ToolCall>();
        const unsettled = new Map<string, ToolCall>();
        try {
          const history = contextForStep(this.sessions.replay(sessionId), turnId, this.options.contextChars ?? 96_000);
          const request: ModelRequest = {
            model: options.model,
            signal,
            system: [...system, ...(history.summary ? [`Earlier conversation (untrusted context):\n${history.summary}`] : [])],
            messages: projectModelMessages(history.events),
            tools: [...tools.values()].map((tool) => ({
              name: tool.name, description: tool.description, inputSchema: z.toJSONSchema(tool.input, { io: 'input' }),
            })),
          };
          if (pre.input !== undefined) request.messages.push({ role: 'user', content: pre.input });
          const prepared = await ctx.waterfall('agent/request', { provider, request });
          signal.throwIfAborted();
          if (history.compaction) add({ type: 'context/compacted', data: history.compaction });
          if (pre.input !== undefined) add({ type: 'user/message', data: { turnId, messageId: randomUUID(), content: pre.input } });
          const streaming = await ctx.waterfall('llm/stream', {
            request: prepared.request,
            chunks: prepared.provider.stream(prepared.request),
          });
          for await (const chunk of streaming.chunks) {
            signal.throwIfAborted();
            switch (chunk.type) {
              case 'text-delta':
              case 'reasoning-delta': {
                const kind = chunk.type === 'text-delta' ? 'text' : 'reasoning';
                if (kind === 'text') text += chunk.delta;
                else reasoning += chunk.delta;
                ctx.emit('assistant/delta', { ...ref, sessionId, messageId, kind, delta: chunk.delta });
                break;
              }
              case 'tool-call':
                if (!chunk.call.id || calls.has(chunk.call.id)) throw new Error('Provider sent a missing or duplicate tool call ID');
                calls.set(chunk.call.id, chunk.call);
                ctx.emit('assistant/tool-call', { ...ref, sessionId, messageId, call: chunk.call });
                break;
              case 'usage': usage = { ...usage, ...chunk.usage }; break;
              case 'error': throw new Error(chunk.message);
              case 'done': completedStream = true; break;
            }
            if (completedStream) break;
          }
          signal.throwIfAborted();
          if (!completedStream) throw new Error('Provider stream ended before completion');
          this.sessions.appendMany(sessionId, [
            { type: 'assistant/message', data: { ...ref, messageId, content: text, reasoning: reasoning || undefined } },
            ...[...calls.values()].map((call): SessionEventInput => ({ type: 'tool/call', data: { ...ref, call } })),
          ]);
          committed = true;
          for (const [id, call] of calls) unsettled.set(id, call);
          const context: ToolCtx = { ctx, ...ref, sessionId, provider: provider.id, model: options.model, interactive: Boolean(options.interactive), cwd: session.cwd, signal };
          for (const call of calls.values()) {
            const toolResult = await this.runTool(call, context, tools, options.interactive ?? false, options.approve);
            add({ type: 'tool/result', data: { ...ref, result: toolResult } });
            unsettled.delete(call.id);
          }
          signal.throwIfAborted();
          add({ type: 'step/end', data: { ...ref, outcome: 'completed', usage } });
          final = text || final;
          if (!calls.size && !this.steers.get(sessionId)?.length) break;
        } catch (error) {
          const outcome: TurnOutcome = signal.aborted ? 'cancelled' : 'failed';
          const message = errorMessage(error);
          if (!committed) add({ type: 'assistant/attempt', data: { ...ref, content: text, reasoning: reasoning || undefined, error: message } });
          for (const call of unsettled.values()) add({ type: 'tool/result', data: { ...ref, result: failCall(call, message) } });
          add({ type: 'step/end', data: { ...ref, outcome, usage } });
          throw error;
        }
      }
      result = { turnId, outcome: 'completed', final };
    } catch (error) {
      result = { turnId, outcome: signal.aborted ? 'cancelled' : 'failed', error: errorMessage(error) };
    }
    try {
      if (turnStarted) add({ type: 'turn/end', data: { turnId, outcome: result.outcome, error: 'error' in result ? result.error : undefined } });
      if (result.outcome === 'failed') ctx.emit('agent/error', { sessionId, turnId, message: result.error });
      return result;
    } finally {
      this.turns.delete(sessionId);
      this.setStatus(sessionId, result.outcome === 'failed' ? 'failed' : 'idle');
      ctx.dispose();
      if (result.outcome === 'cancelled') this.queued.delete(sessionId);
      else this.drainQueue(sessionId);
    }
  }
}

export function agentPlugin(options?: AgentOptions): Plugin {
  return {
    name: 'agent',
    apply(ctx) {
      return ctx.inject(['sessions', 'tools', 'providers', 'system'], (scope) => {
        const agent = new Agent(scope, scope.get<SessionStore>('sessions'), options);
        scope.provide<AgentRuntime>('agent', agent);
        return () => { void agent.shutdown(); };
      });
    },
  };
}
