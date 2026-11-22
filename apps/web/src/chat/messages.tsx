import { Asterisk, Check, ChevronRight, CircleAlert, FilePenLine, FileText, Globe, Search, ShieldCheck, Terminal, Wrench } from 'lucide-react';
import { lazy, memo, Suspense, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import type { Components } from 'react-markdown';
import type { ApprovalDecision, ApprovalRequest, JsonValue, Message, Subagent, ToolCall, ToolResult } from '@extendo/contracts';
import type { FileDiff } from './diff';
import styles from './chat.module.css';

const DiffView = lazy(() => import('./diff'));
const number = new Intl.NumberFormat();
const markdownComponents: Components = {
  img: ({ alt }) => alt ? <span>{alt}</span> : null,
  a: ({ children, href, title }) => href ? <a href={href} title={title} target="_blank" rel="noopener noreferrer">{children}</a> : <span>{children}</span>,
  pre: ({ children }) => <pre tabIndex={0}>{children}</pre>,
};

type AssistantMessage = Extract<Message, { role: 'assistant' }>;
type OnApproval = (id: string, decision: ApprovalDecision) => Promise<void>;

const toolLabels: Record<string, string> = {
  read: 'Read file',
  readfile: 'Read file',
  search: 'Search',
  grep: 'Search',
  glob: 'Find files',
  find: 'Find files',
  edit: 'Edit file',
  editfile: 'Edit file',
  write: 'Write file',
  writefile: 'Write file',
  patch: 'Edit file',
  applypatch: 'Edit file',
  shell: 'Run command',
  bash: 'Run command',
  exec: 'Run command',
  run: 'Run command',
  check: 'Run checks',
  test: 'Run tests',
  runtests: 'Run tests',
  webfetch: 'Fetch URL',
  delegate: 'Delegate',
};

/** Tool ids are machine names; the console shows the action they perform. */
export function humanizeTool(name: string): string {
  const key = name.split(/[.:/]/).at(-1)?.replace(/^demo_/, '').replace(/[-_]/g, '').toLowerCase() ?? name;
  const label = toolLabels[key];
  if (label) return label;
  const words = name.replace(/^demo_/, '').replace(/[-_.]+/g, ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : name;
}

const DelegateCard = memo(function DelegateCard({
  call, subagents, onOpenSubagents, onSubagentApproval, connected,
}: {
  call: ToolCall;
  subagents: Subagent[];
  onOpenSubagents: () => void;
  onSubagentApproval: (sessionId: string, requestId: string, decision: ApprovalDecision) => Promise<void>;
  connected: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const input = object(call.input) ?? {};
  const tasks = Array.isArray(input.tasks) ? input.tasks.filter((task): task is Record<string, JsonValue> => Boolean(task) && typeof task === 'object' && !Array.isArray(task)) : [];
  const roles = tasks.map((task) => typeof task.role === 'string' ? task.role : undefined).filter(Boolean) as string[];
  const waiting = subagents.filter((subagent) => subagent.approval);
  const states = subagents.reduce<Record<string, number>>((tally, subagent) => {
    tally[subagent.state] = (tally[subagent.state] ?? 0) + 1;
    return tally;
  }, {});
  const summary = [
    states.running ? `${states.running} running` : undefined,
    states['waiting-approval'] ? `${states['waiting-approval']} waiting on you` : undefined,
    states.queued ? `${states.queued} queued` : undefined,
    states.failed ? `${states.failed} failed` : undefined,
    states.done ? `${states.done} done` : undefined,
  ].filter(Boolean).join(' · ');
  return (
    <div className={styles.tool} data-approval={waiting.length > 0 || undefined}>
      <div className={styles.delegate}>
        <button type="button" className={styles.delegateHeader} aria-expanded={expanded}
          title={`${tasks.length || subagents.length} subagents${roles.length ? `: ${roles.join(', ')}` : ''}`}
          onClick={() => setExpanded((value) => !value)}>
          <Asterisk size={15} className={styles.toolIcon} aria-hidden="true" />
          <span className={styles.toolLabel}>Delegated {tasks.length || subagents.length} subagents</span>
          {roles.length > 0 && <code className={styles.toolArgument} dir="ltr">{roles.join(', ')}</code>}
          {summary && <span className={styles.delegateState}>{summary}</span>}
          <ChevronRight className={styles.disclosure} size={14} aria-hidden="true" data-open={expanded} />
        </button>
        {expanded && <ul className={styles.delegateTasks}>
          {tasks.map((task, index) => (
            <li key={index}>
              <bdi dir="auto">{typeof task.title === 'string' ? task.title : `Track ${index + 1}`}</bdi>
              {typeof task.role === 'string' && <span className={styles.delegateRole}>{task.role}</span>}
            </li>
          ))}
          {tasks.length === 0 && <li>No track details were recorded.</li>}
        </ul>}
        <button type="button" className={styles.delegateLink} onClick={onOpenSubagents}>
          View subagents<ChevronRight size={12} aria-hidden="true" />
        </button>
      </div>
      {waiting.map((subagent) => <SubagentApproval key={subagent.id} subagent={subagent}
        onApprove={onSubagentApproval} connected={connected} />)}
    </div>
  );
});

const SubagentApproval = memo(function SubagentApproval({
  subagent, onApprove, connected,
}: {
  subagent: Subagent;
  onApprove: (sessionId: string, requestId: string, decision: ApprovalDecision) => Promise<void>;
  connected: boolean;
}) {
  const [pending, setPending] = useState<ApprovalDecision>();
  const [failed, setFailed] = useState(false);
  const request = subagent.approval;
  if (!request) return null;
  const target = typeof request.call.input === 'object' && request.call.input && 'path' in request.call.input
    ? String((request.call.input as { path: unknown }).path) : undefined;
  async function answer(decision: ApprovalDecision) {
    if (pending || !connected) return;
    setPending(decision);
    setFailed(false);
    try {
      await onApprove(subagent.sessionId, request!.requestId, decision);
    } catch {
      setFailed(true);
    } finally {
      setPending(undefined);
    }
  }
  return (
    <div className={styles.approval} aria-busy={Boolean(pending)}>
      <div className={styles.approvalCopy}>
        <strong>{subagent.title}</strong>
        <span>
          Wants to run {humanizeTool(request.call.name)}{target ? <> on <code>{target}</code></> : null} before it continues.
        </span>
      </div>
      <div className={styles.approvalActions}>
        <button type="button" className={styles.quietButton} disabled={Boolean(pending) || !connected}
          onClick={() => void answer('always')} title="Always allow this exact action in this session">Always</button>
        <button type="button" className={styles.quietButton} disabled={Boolean(pending) || !connected}
          onClick={() => void answer('deny')}>Deny</button>
        <button type="button" className={styles.primaryButton} disabled={Boolean(pending) || !connected}
          onClick={() => void answer('allow')}>Allow</button>
      </div>
      {failed && <div className={styles.localError} role="alert">Couldn’t send the decision. Try again.</div>}
    </div>
  );
});

export const AssistantStep = memo(function AssistantStep({
  message, startsReply, streaming, active, approvalByCall, onApproval, connected, subagents, onOpenSubagents, onSubagentApproval,
}: {
  message: AssistantMessage;
  startsReply: boolean;
  streaming: boolean;
  active: boolean;
  approvalByCall?: Map<string, ApprovalRequest>;
  onApproval: OnApproval;
  connected: boolean;
  subagents: Subagent[];
  onOpenSubagents: () => void;
  onSubagentApproval: (sessionId: string, requestId: string, decision: ApprovalDecision) => Promise<void>;
}) {
  if (!message.content && !message.reasoning && !message.tools.length && !streaming) return null;
  return (
    <article className={styles.assistant} data-start={startsReply || undefined} aria-label={startsReply ? 'Extendo reply' : undefined}>
      {startsReply && (
        <div className={styles.assistantByline}><span><Asterisk size={16} aria-hidden="true" /></span> Extendo</div>
      )}
      {message.reasoning && (
        <details className={styles.reasoning}>
          <summary><ChevronRight size={13} aria-hidden="true" /> Reasoning</summary>
          <div dir="auto" tabIndex={0}>{message.reasoning}</div>
        </details>
      )}
      {message.content ? (
        <div className={streaming ? `${styles.prose} ${styles.streaming}` : styles.prose} dir="auto">
          <Markdown skipHtml components={markdownComponents}>{message.content}</Markdown>
        </div>
      ) : streaming && !message.tools.length ? (
        <div className={styles.working}><span className={styles.workDot} />{message.reasoning ? 'Thinking' : 'Working'}</div>
      ) : null}
      {message.tools.length > 0 && (
        <div className={styles.tools}>
          {message.tools.map(({ call, result }) => (
            humanizeTool(call.name) === 'Delegate'
              ? <DelegateCard key={call.id} call={call} subagents={subagents} onOpenSubagents={onOpenSubagents}
                onSubagentApproval={onSubagentApproval} connected={connected} />
              : <ToolCard
                key={call.id}
                call={call}
                result={result}
                approval={approvalByCall?.get(call.id)}
                onApproval={onApproval}
                active={active}
                connected={connected}
              />
          ))}
        </div>
      )}
    </article>
  );
});

function object(value: JsonValue | undefined): Record<string, JsonValue> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
}

function fileDiff(output?: JsonValue): FileDiff | undefined {
  const root = object(output);
  const value = object(root?.diff) ?? root;
  if (
    typeof value?.path !== 'string' || typeof value.before !== 'string' || typeof value.after !== 'string' ||
    typeof value.additions !== 'number' || typeof value.deletions !== 'number' ||
    !Number.isSafeInteger(value.additions) || !Number.isSafeInteger(value.deletions) || value.additions < 0 || value.deletions < 0
  ) return;
  return {
    path: value.path, before: value.before, after: value.after, additions: value.additions,
    deletions: value.deletions, summary: typeof value.summary === 'string' ? value.summary : undefined,
  };
}

function print(value: JsonValue) {
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

function ToolOutput({ output }: { output: JsonValue }) {
  const value = object(output);
  if (typeof value?.content === 'string') {
    return (
      <>
        <pre className={styles.toolOutput} tabIndex={0}>{value.content || 'Empty file'}</pre>
        {value.truncated === true && <div className={styles.outputNote}>Only part of the file was returned.</div>}
      </>
    );
  }
  if (typeof value?.stdout === 'string' || typeof value?.stderr === 'string') {
    return (
      <>
        {(value.stdout || value.stderr) && (
          <pre className={styles.toolOutput} tabIndex={0}>{[value.stdout, value.stderr].filter(Boolean).join('\n')}</pre>
        )}
        {typeof value.exitCode === 'number' && <div className={styles.outputNote}>Exit code {value.exitCode}</div>}
        {value.timedOut === true && <div className={styles.outputNote}>The command timed out.</div>}
        {value.truncated === true && <div className={styles.outputNote}>Only part of the output was returned.</div>}
        {!value.stdout && !value.stderr && typeof value.exitCode !== 'number' && !value.timedOut && <div className={styles.outputNote}>No output.</div>}
      </>
    );
  }
  return <pre className={styles.toolOutput} tabIndex={0}>{print(output) || 'No output.'}</pre>;
}

export const ToolCard = memo(function ToolCard({ call, result, approval, onApproval, active, connected }: {
  call: ToolCall;
  result?: ToolResult;
  approval?: ApprovalRequest;
  onApproval: OnApproval;
  active: boolean;
  connected: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const diff = fileDiff(result?.output);
  const input = object(call.input);
  const output = object(result?.output);
  const name = (call.name.split(/[.:/]/).at(-1) ?? call.name).replace(/^demo_/, '').replace(/[-_]/g, '').toLowerCase();
  const test = name === 'test' || name === 'runtests' || name === 'check';
  const read = name === 'read' || name === 'readfile';
  const write = name === 'write' || name === 'writefile' || name === 'edit' || name === 'editfile' || name === 'applypatch';
  const search = name === 'search' || name === 'grep' || name === 'glob' || name === 'find';
  const shell = name === 'shell' || name === 'bash' || name === 'exec' || name === 'runcommand';
  const fetch = name === 'webfetch';
  const Icon = diff || write ? FilePenLine : read ? FileText : search ? Search : shell || test ? Terminal : fetch ? Globe : Wrench;
  const label = humanizeTool(call.name);
  const path = diff?.path ?? input?.path ?? input?.filePath ?? input?.file;
  const summary = [path, input?.command, input?.cmd, input?.query, input?.pattern, input?.url, output?.path, call.input]
    .find((value): value is string => typeof value === 'string' && Boolean(value.trim()));
  const pathEnd = summary && summary === path ? Math.max(summary.lastIndexOf('/'), summary.lastIndexOf('\\')) + 1 : 0;
  const status = approval ? 'Approval required' : result?.isError ? 'Failed' : result ? 'Completed' : active ? 'In progress' : 'No result';

  return (
    <div className={styles.tool} data-approval={Boolean(approval) || undefined}>
      <details onToggle={event => setExpanded(event.currentTarget.open)}>
        <summary className={styles.toolSummary} title={summary ? `${call.name}: ${summary}` : call.name}>
          <Icon size={15} className={styles.toolIcon} aria-hidden="true" />
          <span className={styles.toolLabel}>{label}</span>
          {summary && (
            <code className={styles.toolArgument} data-path={Boolean(pathEnd) || undefined} dir="ltr" title={summary}>
              {pathEnd ? <><span>{summary.slice(0, pathEnd)}</span><span>{summary.slice(pathEnd)}</span></> : summary}
            </code>
          )}
          <span className={styles.toolEnd}>
            {diff && (
              <span className={styles.diffCounts} aria-label={`${number.format(diff.additions)} additions, ${number.format(diff.deletions)} deletions`}>
                <span>+{number.format(diff.additions)}</span><span>−{number.format(diff.deletions)}</span>
              </span>
            )}
            <span className={styles.toolStatus} data-status={status} aria-label={status} role="img" title={status}>
              {approval ? <ShieldCheck size={13} /> : result?.isError ? <CircleAlert size={13} /> : result ? <Check size={13} /> : <span className={styles.workDot} />}
            </span>
            <ChevronRight className={styles.disclosure} size={14} aria-hidden="true" />
          </span>
        </summary>
        {expanded && (
          <div className={styles.toolDetails}>
            {diff ? (
              <>
                {diff.summary && <p className={styles.diffSummary} dir="auto">{diff.summary}</p>}
                <Suspense fallback={<p className={styles.outputNote} role="status">Loading diff…</p>}>
                  <DiffView diff={diff} />
                </Suspense>
              </>
            ) : result ? <ToolOutput output={result.output} /> : null}
            {result ? (
              <details className={styles.toolInput}>
                <summary><ChevronRight size={12} aria-hidden="true" /> Tool input</summary>
                <pre className={styles.toolOutput} tabIndex={0}>{print(call.input) || 'No input.'}</pre>
              </details>
            ) : <pre className={styles.toolOutput} tabIndex={0}>{print(call.input) || 'No input.'}</pre>}
          </div>
        )}
      </details>
      {approval && <ApprovalActions key={approval.requestId} approval={approval} onApproval={onApproval} connected={connected} />}
    </div>
  );
});

function ApprovalActions({ approval, onApproval, connected }: { approval: ApprovalRequest; onApproval: OnApproval; connected: boolean }) {
  const submitting = useRef(false);
  const [pending, setPending] = useState<ApprovalDecision>();
  const [failed, setFailed] = useState(false);

  async function answer(decision: ApprovalDecision) {
    if (submitting.current || !connected) return;
    submitting.current = true;
    setPending(decision);
    setFailed(false);
    try {
      await onApproval(approval.requestId, decision);
    } catch {
      setFailed(true);
    } finally {
      submitting.current = false;
      setPending(undefined);
    }
  }

  return (
    <div className={styles.approval} aria-busy={Boolean(pending)}>
      <div className={styles.approvalCopy}>
        <strong>Approval required</strong>
        <span>{connected ? 'Review the tool input before it runs.' : 'Reconnect to respond.'}</span>
      </div>
      <div className={styles.approvalActions}>
        <button type="button" className={styles.quietButton} disabled={Boolean(pending) || !connected} title="Always allow this exact action in this session" onClick={() => void answer('always')}>Always</button>
        <button type="button" className={styles.quietButton} disabled={Boolean(pending) || !connected} onClick={() => void answer('deny')}>Deny</button>
        <button type="button" className={styles.primaryButton} disabled={Boolean(pending) || !connected} onClick={() => void answer('allow')}>Allow</button>
      </div>
      {failed && <div className={styles.localError} role="alert">Couldn’t send the decision. Try again.</div>}
    </div>
  );
}
