import { ArrowUpRight, CircleCheck, CircleDashed, CircleX, Clock3, GitBranch } from 'lucide-react';
import type { CrewMember, Issue, IssueState, Thread } from '@extendo/contracts';
import { boardLabels, relativeTime } from './board';
import styles from './console.module.css';

const number = new Intl.NumberFormat();

const issueLabels: Record<IssueState, string> = {
  open: 'Open',
  'in-progress': 'In progress',
  'needs-you': 'Needs you',
  'in-review': 'In review',
  done: 'Done',
  canceled: 'Canceled',
};

function StateMark({ member }: { member: CrewMember }) {
  const state = member.state;
  const Icon = state === 'done' ? CircleCheck : state === 'failed' ? CircleX
    : state === 'waiting-approval' ? Clock3 : CircleDashed;
  return <Icon size={13} data-state={state} className={styles.stateMark} aria-hidden="true" />;
}

function Worker({ member, now }: { member: CrewMember; now: number }) {
  const state = member.state ?? 'idle';
  const pr = member.pullRequest;
  const seen = relativeTime(member.reportAt, now);
  return <li className={styles.crewMember}>
    <div className={styles.crewTop}>
      <StateMark member={member} />
      <bdi className={styles.crewTitle} dir="auto" title={member.title}>{member.title}</bdi>
      <span className={styles.crewState} data-state={state}>{boardLabels[state] ?? state}</span>
    </div>
    {member.branch && <p className={styles.crewBranch}>
      <GitBranch size={12} aria-hidden="true" /><bdi dir="auto">{member.branch}</bdi>
    </p>}
    {member.report && <blockquote className={styles.crewReport} dir="auto">{member.report}</blockquote>}
    <div className={styles.crewMeta}>
      {pr && <a className={styles.crewLink} href={pr.url} target="_blank" rel="noreferrer"
        data-state={pr.checks === 'failing' ? 'failing' : pr.merged ? 'merged' : 'ready'}>
        #{number.format(pr.number)}<ArrowUpRight size={12} aria-hidden="true" />
      </a>}
      {seen && <span className={styles.crewSeen}>Reported {seen}</span>}
    </div>
  </li>;
}

function IssueRow({ issue }: { issue: Issue }) {
  return <li className={styles.crewIssue} data-state={issue.state}>
    <span className={styles.crewIssueNumber}>#{number.format(issue.number)}</span>
    <div className={styles.crewIssueBody}>
      <bdi className={styles.crewIssueTitle} dir="auto">{issue.title}</bdi>
      {issue.body && <p className={styles.crewIssueText} dir="auto">{issue.body}</p>}
    </div>
    <span className={styles.crewIssueState} data-state={issue.state}>{issueLabels[issue.state]}</span>
  </li>;
}

/** A captain's crew and the issues it filed: what each worker is doing and what needs a person. */
export function CrewPanel({ thread, now }: { thread?: Thread; now: number }) {
  const crew = thread?.crew ?? [];
  const issues = thread?.issues ?? [];
  if (thread?.role !== 'captain') {
    return <p className={styles.empty}>This thread is not a captain. Open a captain to see its crew.</p>;
  }
  const needsYou = issues.filter((issue) => issue.state === 'needs-you').length;
  return <div className={styles.crew}>
    <section className={styles.group} aria-label="Crew">
      <h3 className={styles.groupHeading}>Crew<span>{crew.length ? `${number.format(crew.length)} worker${crew.length === 1 ? '' : 's'}` : 'none'}</span></h3>
      {crew.length ? <ul className={styles.crewList}>
        {crew.map((member) => <Worker key={member.threadId} member={member} now={now} />)}
      </ul> : <p className={styles.empty}>No workers yet. The captain starts one with crew.create.</p>}
    </section>
    <section className={styles.group} aria-label="Issues">
      <h3 className={styles.groupHeading}>Issues<span>{needsYou ? `${number.format(needsYou)} need you` : issues.length ? number.format(issues.length) : 'none'}</span></h3>
      {issues.length ? <ul className={styles.crewIssues}>
        {issues.map((issue) => <IssueRow key={issue.id} issue={issue} />)}
      </ul> : <p className={styles.empty}>No issues filed. A captain files one when work outlives its turn.</p>}
    </section>
  </div>;
}
