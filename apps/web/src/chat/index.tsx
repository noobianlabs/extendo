import { ArrowDown, CircleAlert, Plug, Terminal } from 'lucide-react';
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { AgentStatus, ApprovalDecision, ApprovalRequest, LiveTool, Message, Subagent } from '@extendo/contracts';
import { CapabilityStrip } from '../workshop';
import { Composer } from './composer';
import { AssistantStep, ToolCard } from './messages';
import styles from './chat.module.css';

interface ChatSurfaceProps {
  title?: string;
  messages: Message[];
  draft?: Extract<Message, { role: 'assistant' }>;
  approvals: ApprovalRequest[];
  status: AgentStatus;
  loading: boolean;
  error?: string;
  providerLabel: string;
  needsProvider?: boolean;
  connected: boolean;
  subagents: Subagent[];
  waitingSubagents: number;
  onOpenSubagents: () => void;
  onSubagentApproval: (sessionId: string, requestId: string, decision: ApprovalDecision) => Promise<void>;
  onSend: (text: string) => Promise<void>;
  onCancel: () => void;
  onApproval: (id: string, decision: ApprovalDecision) => Promise<void>;
  onOpenSettings: () => void;
  onOpenPalette: () => void;
  onSelectDemo: () => void;
  suggestions?: string[];
  liveTools?: LiveTool[];
  pluginTools?: Map<string, string>;
  pluginCount?: number;
  onOpenWorkshop?: () => void;
}

export function ChatSurface({
  title, messages, draft, approvals, status, loading, error, providerLabel, needsProvider = false,
  connected, subagents, waitingSubagents, onOpenSubagents, onSubagentApproval,
  onSend, onCancel, onApproval, onOpenSettings, onOpenPalette, onSelectDemo, suggestions,
  liveTools = [], pluginTools, pluginCount = 0, onOpenWorkshop = () => {},
}: ChatSurfaceProps) {
  const seamed = new Set<string>();
  const scroll = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const [away, setAway] = useState(false);
  const [suggestion, setSuggestion] = useState<{ text: string }>();
  const running = status === 'working' || status === 'waiting' || approvals.length > 0;
  const steering = status === 'working' && approvals.length === 0;
  const loadingEmpty = loading && !messages.length && !draft && !approvals.length;
  const approvalsByStep = useMemo(() => {
    const steps = new Map<string, Map<string, ApprovalRequest>>();
    for (const approval of approvals) {
      const calls = steps.get(approval.stepId) ?? new Map<string, ApprovalRequest>();
      calls.set(approval.call.id, approval);
      steps.set(approval.stepId, calls);
    }
    return steps;
  }, [approvals]);
  const committedDraft = draft && messages.some(message => message.id === draft.id);
  const timeline = draft && !committedDraft ? [...messages, draft] : messages;
  const attachedApprovals = new Set<string>();
  const hasConversation = timeline.length > 0 || approvals.length > 0 || running;
  const latestTurn = timeline.at(-1)?.turnId;
  const tasks = suggestions?.filter(text => text.trim()) ?? [];

  useLayoutEffect(() => {
    const viewport = scroll.current;
    if (viewport && following.current) viewport.scrollTop = viewport.scrollHeight;
  }, [messages, draft, approvals, status, loading, error]);

  useLayoutEffect(() => {
    const viewport = scroll.current;
    if (!viewport) return;
    const observer = new ResizeObserver(() => {
      if (following.current) viewport.scrollTop = viewport.scrollHeight;
    });
    observer.observe(viewport);
    return () => observer.disconnect();
  }, []);

  return (
    <section className={styles.chat} aria-label={title?.trim() || 'Conversation'}>
      <div className={styles.history}>
        <div
          ref={scroll}
          className={styles.scroll}
          role="region"
          tabIndex={0}
          aria-label="Message history"
          onScroll={event => {
            const viewport = event.currentTarget;
            const atBottom = viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop < 48;
            following.current = atBottom;
            setAway(!atBottom);
          }}
        >
          <div className={styles.lane}>
            {loadingEmpty ? (
              <div className={styles.skeleton} role="status">
                <span className={styles.srOnly}>Loading conversation</span>
                <div aria-hidden="true" /><div aria-hidden="true" /><div aria-hidden="true" />
              </div>
            ) : hasConversation ? (
              <>
                {timeline.map((message, index) => {
                  if (message.role === 'user') {
                    return (
                      <article key={message.id} className={styles.userMessage} aria-label="Your message">
                        <div dir="auto">{message.content}</div>
                      </article>
                    );
                  }
                  const previous = timeline[index - 1];
                  const startsReply = previous?.role !== 'assistant' || previous.turnId !== message.turnId;
                  const joined = message.tools
                    .map(({ call }) => pluginTools?.get(call.name))
                    .find((plugin) => plugin && !seamed.has(plugin));
                  if (joined) seamed.add(joined);
                  const messageApprovals = approvalsByStep.get(message.stepId);
                  if (messageApprovals) {
                    for (const { call } of message.tools) {
                      const request = messageApprovals.get(call.id);
                      if (request) attachedApprovals.add(request.requestId);
                    }
                  }
                  const joinedTool = message.tools.find(({ call }) => pluginTools?.get(call.name) === joined)?.call.name;
                  return (
                    <AssistantStep
                      key={message.id}
                      message={message}
                      startsReply={startsReply}
                      streaming={message === draft && status === 'working' && !approvals.length}
                      active={running && message.turnId === latestTurn}
                      approvalByCall={messageApprovals}
                      onApproval={onApproval}
                      connected={connected}
                      subagents={subagents}
                      onOpenSubagents={onOpenSubagents}
                      onSubagentApproval={onSubagentApproval}
                      seam={joined && joinedTool ? { plugin: joined, tool: joinedTool } : undefined}
                      pluginTools={pluginTools}
                      onOpenPlugin={onOpenWorkshop}
                    />
                  );
                })}
                {approvals.filter(request => !attachedApprovals.has(request.requestId)).map(request => (
                  <div className={styles.orphanTool} key={request.requestId}>
                    <ToolCard call={request.call} approval={request} onApproval={onApproval} connected={connected} active />
                  </div>
                ))}
                {status === 'working' && !draft && !approvals.length && (
                  <div className={styles.working}><span className={styles.workDot} />Working</div>
                )}
              </>
            ) : !error && (
              <div className={styles.empty}>
                <span className={styles.emptyIcon} aria-hidden="true">
                  {needsProvider ? <Plug size={22} /> : <Terminal size={22} />}
                </span>
                <h1>{needsProvider ? 'Connect a provider' : 'What should we work on?'}</h1>
                <p>{needsProvider ? 'Configure the provider on your local server or try the demo without a key.' : 'Ask Extendo to explore, edit, or test your project.'}</p>
                {needsProvider ? (
                  <div className={styles.emptyActions}>
                    <button type="button" className={styles.primaryButton} onClick={onOpenSettings}>Open settings</button>
                    <button type="button" className={styles.quietButton} onClick={onSelectDemo}>Try demo</button>
                  </div>
                ) : tasks.length > 0 && (
                  <ul className={styles.suggestions} aria-label="Suggested tasks">
                    {tasks.map((text, index) => (
                      <li key={index}><button type="button" onClick={() => setSuggestion({ text })} dir="auto">{text}</button></li>
                    ))}
                  </ul>
                )}
              </div>
            )}
            {error && (
              <div className={styles.threadError} role="alert">
                <CircleAlert size={16} aria-hidden="true" />
                <div><strong>{hasConversation ? 'Something went wrong' : 'Conversation unavailable'}</strong><div dir="auto">{error}</div></div>
              </div>
            )}
          </div>
        </div>
        {away && hasConversation && (
          <button
            type="button"
            className={styles.latest}
            onClick={() => {
              following.current = true;
              setAway(false);
              if (scroll.current) {
                scroll.current.scrollTop = scroll.current.scrollHeight;
                scroll.current.focus({ preventScroll: true });
              }
            }}
          ><ArrowDown size={13} aria-hidden="true" /> Jump to latest</button>
        )}
      </div>
      {waitingSubagents > 0 && (
        <div className={styles.subagentWaiting} role="alert">
          <span>
            {waitingSubagents === 1 ? 'A subagent needs' : `${waitingSubagents} subagents need`} your approval to continue.
          </span>
          <button type="button" onClick={onOpenSubagents}>Review</button>
        </div>
      )}
      <span role="status" className={styles.srOnly}>
        {approvals.length || status === 'waiting' ? 'Waiting for tool approval' : status === 'working' ? 'Extendo is working' : status === 'failed' ? 'The turn failed' : ''}
      </span>
      <CapabilityStrip tools={liveTools} plugins={pluginCount} onOpen={onOpenWorkshop} />
      <Composer
        running={running}
        steering={steering}
        waiting={status === 'waiting' || Boolean(approvals.length)}
        loading={loading}
        needsProvider={needsProvider}
        connected={connected}
        providerLabel={providerLabel}
        suggestion={suggestion}
        onSend={onSend}
        onCancel={onCancel}
        onOpenSettings={onOpenSettings}
        onOpenPalette={onOpenPalette}
      />
    </section>
  );
}
