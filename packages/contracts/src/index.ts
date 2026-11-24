import { z } from 'zod';

export type Disposable = () => void;
export type Listener<T> = (payload: T) => void | Promise<void>;
export type WaterfallListener<T> = (payload: T, next: (payload: T) => Promise<T>) => T | Promise<T>;

export interface Logger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface Plugin {
  name: string;
  apply(ctx: Ctx): void | Disposable | Promise<void | Disposable>;
}

export interface Ctx {
  provide<T>(key: string, value: T): Disposable;
  get<T>(key: string): T;
  has(key: string): boolean;
  inject(keys: readonly string[], apply: (ctx: Ctx) => void | Disposable): Disposable;
  on<K extends keyof Events>(key: K, listener: Listener<Events[K]>): Disposable;
  emit<K extends keyof Events>(key: K, payload: Events[K]): void;
  serial<K extends keyof Events>(key: K, payload: Events[K]): Promise<void>;
  onWaterfall<K extends keyof Waterfalls>(key: K, listener: WaterfallListener<Waterfalls[K]>): Disposable;
  waterfall<K extends keyof Waterfalls>(key: K, payload: Waterfalls[K], fallback?: (payload: Waterfalls[K]) => Waterfalls[K] | Promise<Waterfalls[K]>): Promise<Waterfalls[K]>;
  effect(apply: () => void | Disposable): Disposable;
  fork(name: string): Ctx;
  dispose(): void;
  logger: Logger;
}

export interface PluginManifest {
  name: string;
  version: string;
  description?: string;
  server?: string;
  ui?: string;
  skills?: string[];
}

export interface Registry<T> {
  register(owner: Ctx, key: string, value: T): Disposable;
  get(key: string): T | undefined;
  list(): T[];
}

export interface Command {
  name: string;
  description: string;
  run(args: readonly string[]): void | Promise<void>;
}

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface ToolCtx {
  ctx: Ctx;
  sessionId: string;
  turnId: string;
  stepId: string;
  provider: string;
  model: string;
  interactive: boolean;
  cwd: string;
  signal: AbortSignal;
}

export interface Tool<I = unknown, O = unknown> {
  name: string;
  description: string;
  input: z.ZodType<I>;
  readOnly?: boolean;
  needsApproval?: boolean;
  execute(input: I, ctx: ToolCtx): Promise<O>;
}

export interface ModelTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  input: JsonValue;
}

export interface ToolResult {
  callId: string;
  name: string;
  output: JsonValue;
  isError: boolean;
}

export type ModelMessage =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; reasoning?: string; toolCalls?: ToolCall[] }
  | { role: 'tool'; result: ToolResult };

export interface ModelRequest {
  model: string;
  system: string[];
  messages: ModelMessage[];
  tools: ModelTool[];
  signal: AbortSignal;
}

export interface ModelUsage {
  inputTokens?: number;
  outputTokens?: number;
}

export type ModelChunk =
  | { type: 'text-delta' | 'reasoning-delta'; delta: string }
  | { type: 'tool-call'; call: ToolCall }
  | { type: 'usage'; usage: ModelUsage }
  | { type: 'done' }
  | { type: 'error'; message: string };

export interface Provider {
  id: string;
  stream(request: ModelRequest): AsyncIterable<ModelChunk>;
}

export interface Session {
  id: string;
  title: string;
  cwd: string;
  createdAt: string;
}

export type AgentStatus = 'idle' | 'working' | 'waiting' | 'failed';
export type TurnOutcome = 'completed' | 'cancelled' | 'failed' | 'interrupted';
export type StepRef = { turnId: string; stepId: string };

/** What a thread needs from a person, derived from durable state. */
export type ThreadState = 'idle' | 'working' | 'queued' | 'waiting-approval' | 'waiting-review' | 'done' | 'failed';

export type SubagentState = 'queued' | 'running' | 'waiting-approval' | 'done' | 'failed' | 'stopped';

export type ActivityKind = 'read' | 'search' | 'patch' | 'run' | 'tool' | 'note';

export interface SubagentActivity {
  id: string;
  kind: ActivityKind;
  label: string;
  detail?: string;
  state: 'running' | 'done' | 'failed';
  startedAt: string;
  durationMs?: number;
}

export interface SubagentApproval {
  requestId: string;
  call: ToolCall;
}

export interface Subagent {
  id: string;
  title: string;
  role?: string;
  sessionId: string;
  state: SubagentState;
  parentTurnId?: string;
  approval?: SubagentApproval;
  position?: number;
  startedAt?: string;
  endedAt?: string;
  activity: SubagentActivity[];
  report?: string;
  error?: string;
}

export type PullRequestCheckState = 'passing' | 'failing' | 'pending' | 'none';
export type PullRequestReviewState = 'approved' | 'changes-requested' | 'pending' | 'none';

export interface PullRequest {
  number: number;
  title: string;
  url: string;
  branch: string;
  base: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  checks: PullRequestCheckState;
  checksSummary?: string;
  review: PullRequestReviewState;
  draft: boolean;
  merged: boolean;
  mergeable?: boolean;
  state: 'open' | 'merged' | 'closed';
}

export interface SwarmTask {
  title: string;
  prompt: string;
  role?: string;
}

export interface SwarmPlan {
  title: string;
  concurrency?: number;
  tasks: SwarmTask[];
}

export interface SessionEventData {
  'session/created': Session;
  'turn/start': { turnId: string; provider: string; model: string };
  'turn/end': { turnId: string; outcome: TurnOutcome; error?: string };
  'step/start': StepRef;
  'step/end': StepRef & { outcome: TurnOutcome; usage?: ModelUsage };
  'user/message': { turnId: string; messageId: string; content: string };
  'assistant/message': StepRef & { messageId: string; content: string; reasoning?: string };
  'assistant/attempt': StepRef & { content: string; reasoning?: string; error: string };
  'tool/call': StepRef & { call: ToolCall };
  'tool/result': StepRef & { result: ToolResult };
  'context/compacted': { turnId: string; throughSeq: number; summary: string };
  'subagent/spawned': { subagentId: string; title: string; role?: string; sessionId: string; parentTurnId: string; position?: number };
  'subagent/queued': { subagentId: string; position: number };
  'subagent/started': { subagentId: string };
  'subagent/activity': { subagentId: string; activity: SubagentActivity };
  'subagent/report': { subagentId: string; outcome: 'completed' | 'failed' | 'stopped'; report: string; error?: string };
  'subagent/steered': { subagentId: string; message: string };
  'subagent/approval': { subagentId: string; request: ApprovalRequest };
  'subagent/approval-answered': { subagentId: string; requestId: string; decision: ApprovalDecision };
}

export type SessionEventType = keyof SessionEventData;
export type SessionEventInput = {
  [K in SessionEventType]: { type: K; data: SessionEventData[K] };
}[SessionEventType];
export type SessionEvent = SessionEventInput & { seq: number; ts: string };

export type ApprovalDecision = 'allow' | 'deny' | 'always';

export interface ApprovalRequest extends StepRef {
  requestId: string;
  sessionId: string;
  call: ToolCall;
}

export interface Events extends Omit<SessionEventData, 'session/created'> {
  'session/created': Session;
  'session/event': { sessionId: string; event: SessionEvent };
  'agent/status': { sessionId: string; status: AgentStatus };
  'agent/error': { sessionId: string; turnId: string; message: string };
  'assistant/delta': StepRef & { sessionId: string; messageId: string; kind: 'text' | 'reasoning'; delta: string };
  'assistant/tool-call': StepRef & { sessionId: string; messageId: string; call: ToolCall };
  'tool/approval': ApprovalRequest;
  'tool/approval-answered': { sessionId: string; requestId: string; decision: ApprovalDecision };
  'pull-request/updated': { sessionId: string; pullRequest: PullRequest };
  'thread/updated': { thread: Thread };
  'fs/read': { sessionId: string; path: string };
  'fs/write': { sessionId: string; path: string };
  'tools/register': { name: string };
  'llm/register': { id: string };
  'telemetry/event': { name: string; data?: JsonValue };
}

export interface Waterfalls {
  'agent/pre-step': StepRef & { sessionId: string; input?: string; skip?: boolean };
  'agent/request': { provider: Provider; request: ModelRequest };
  'llm/stream': { request: ModelRequest; chunks: AsyncIterable<ModelChunk> };
  'tools/pre-execute': { call: ToolCall; context: ToolCtx; denied?: string };
  'tools/execute': { call: ToolCall; context: ToolCtx; result?: ToolResult };
  'tools/post-execute': { call: ToolCall; context: ToolCtx; result: ToolResult };
}

export interface Project {
  id: string;
  name: string;
  path: string;
}

export interface Preview {
  label: string;
  title: string;
  url: string;
  updatedAt?: string;
}

export interface Thread {
  id: string;
  projectId: string;
  sessionId: string;
  title: string;
  cwd: string;
  provider: string;
  model: string;
  status: AgentStatus;
  createdAt: string;
  branch?: string;
  repo?: string;
  state?: ThreadState;
  stateSince?: string;
  updatedAt?: string;
  pullRequest?: PullRequest;
  subagents?: Subagent[];
  preview?: Preview;
}

export interface ProviderInfo {
  id: string;
  name: string;
  model: string;
  configured: boolean;
}

export interface Settings {
  provider: string;
  model?: string;
}

export type Message =
  | { role: 'user'; id: string; turnId: string; content: string }
  | { role: 'assistant'; id: string; turnId: string; stepId: string; content: string; reasoning?: string; tools: { call: ToolCall; result?: ToolResult }[] };

export interface SessionSnapshot {
  session: Session;
  messages: Message[];
  lastSeq: number;
}

const sessionId = z.string().min(1).max(128);
const selection = z.string().min(1).max(256);
const id = z.union([z.string().min(1).max(128), z.number().int()]);
const subagentId = z.string().min(1).max(128);
const messageMode = z.enum(['auto', 'steer', 'queue']);
const methods = {
  'send-message': z.object({
    sessionId, content: z.string().trim().min(1).max(128_000), provider: selection.optional(), model: selection.optional(),
    mode: messageMode.optional(),
  }),
  cancel: z.object({ sessionId }),
  'answer-approval': z.object({ sessionId, requestId: z.string().min(1).max(128), decision: z.enum(['allow', 'deny', 'always']) }),
  subscribe: z.object({ sessionId, afterSeq: z.number().int().nonnegative().optional() }),
  unsubscribe: z.object({ sessionId }),
  'subagent-steer': z.object({ sessionId, subagentId, message: z.string().trim().min(1).max(32_000) }),
  'subagent-stop': z.object({ sessionId, subagentId }),
  'pull-request-merge': z.object({ sessionId }),
} as const;

export const rpcRequestSchema = z.discriminatedUnion('method', [
  z.object({ id, method: z.literal('send-message'), params: methods['send-message'] }),
  z.object({ id, method: z.literal('cancel'), params: methods.cancel }),
  z.object({ id, method: z.literal('answer-approval'), params: methods['answer-approval'] }),
  z.object({ id, method: z.literal('subscribe'), params: methods.subscribe }),
  z.object({ id, method: z.literal('unsubscribe'), params: methods.unsubscribe }),
  z.object({ id, method: z.literal('subagent-steer'), params: methods['subagent-steer'] }),
  z.object({ id, method: z.literal('subagent-stop'), params: methods['subagent-stop'] }),
  z.object({ id, method: z.literal('pull-request-merge'), params: methods['pull-request-merge'] }),
]);

export type RpcRequest = z.infer<typeof rpcRequestSchema>;
export type RpcId = RpcRequest['id'];
export type MessageMode = 'auto' | 'steer' | 'queue';
export type MessageDelivery = 'started' | 'steered' | 'queued';
export interface RpcResults {
  'send-message': { turnId?: string; mode: MessageDelivery };
  cancel: { cancelled: boolean };
  'answer-approval': { accepted: boolean };
  subscribe: { lastSeq: number; status: AgentStatus; approvals: ApprovalRequest[] };
  unsubscribe: { ok: true };
  'subagent-steer': { steered: boolean };
  'subagent-stop': { stopped: boolean };
  'pull-request-merge': { merged: boolean; pullRequest?: PullRequest };
}
export type RpcResponse<M extends keyof RpcResults = keyof RpcResults> =
  | { id: RpcId; result: RpcResults[M] }
  | { id: RpcId | null; error: { code: string; message: string } };

export type RpcEventName = 'session/event' | 'agent/status' | 'agent/error' | 'assistant/delta' | 'assistant/tool-call' | 'tool/approval' | 'tool/approval-answered' | 'pull-request/updated' | 'thread/updated';
export type RpcEvent = { [K in RpcEventName]: { event: K; data: Events[K] } }[RpcEventName];
export type RpcServerFrame = RpcResponse | RpcEvent;

export interface CreateProjectRequest { name?: string; path: string }
export interface CreateThreadRequest { projectId?: string; title?: string; provider?: string; model?: string }
export interface UpdateSettingsRequest { provider: string; model?: string }

export * from './derive.js';
