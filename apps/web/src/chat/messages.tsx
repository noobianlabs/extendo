import { Asterisk, Check, ChevronRight, CircleAlert, FilePenLine, FileText, Globe, Search, ShieldCheck, Terminal, Wrench } from 'lucide-react';
import { lazy, memo, Suspense, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import type { Components } from 'react-markdown';
import type { ApprovalDecision, ApprovalRequest, JsonValue, Message, ToolCall, ToolResult } from '@extendo/contracts';
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

export const AssistantStep = memo(function AssistantStep({
  message, startsReply, streaming, active, approvalByCall, onApproval, connected,
}: {
  message: AssistantMessage;
  startsReply: boolean;
  streaming: boolean;
  active: boolean;
  approvalByCall?: Map<string, ApprovalRequest>;
  onApproval: OnApproval;
  connected: boolean;
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
            <ToolCard
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
  const test = name === 'test' || name === 'runtests';
  const read = name === 'read' || name === 'readfile';
  const write = name === 'write' || name === 'writefile' || name === 'edit' || name === 'editfile' || name === 'applypatch';
  const search = name === 'search' || name === 'grep' || name === 'glob' || name === 'find';
  const shell = name === 'shell' || name === 'bash' || name === 'exec' || name === 'runcommand';
  const fetch = name === 'webfetch';
  const Icon = diff || write ? FilePenLine : read ? FileText : search ? Search : shell || test ? Terminal : fetch ? Globe : Wrench;
  const label = call.name === 'demo_edit' ? 'Preview edit' : call.name === 'demo_test' ? 'Run demo checks'
    : diff || write ? 'Edit file' : read ? 'Read file' : search ? 'Search' : test ? 'Run tests' : shell ? 'Run command' : fetch ? 'Fetch URL' : call.name;
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
