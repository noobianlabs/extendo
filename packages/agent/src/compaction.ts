import type { SessionEvent, SessionEventData } from '@extendo/contracts';
import { projectMessages } from '@extendo/session';

type Compaction = SessionEventData['context/compacted'];

export function contextForStep(events: readonly SessionEvent[], turnId: string, budget: number): {
  events: SessionEvent[];
  summary?: string;
  compaction?: Compaction;
} {
  const latest = events.findLast((event) => event.type === 'context/compacted');
  const previous = latest?.type === 'context/compacted' ? latest.data : undefined;
  const remaining = events.filter((event) => event.seq > (previous?.throughSeq ?? 0));
  const measured = JSON.stringify(projectMessages(remaining)).length;
  if (measured <= budget) return { events: remaining, summary: previous?.summary };

  const boundary = remaining.findLast((event) => event.type === 'turn/end' && event.data.turnId !== turnId);
  if (!boundary) return { events: remaining, summary: previous?.summary };

  const prefix = remaining.filter(({ seq }) => seq <= boundary.seq);
  const excerpts = projectMessages(prefix).map((message) => {
    const tools = message.role === 'assistant' && message.tools.length
      ? ' [tools: ' + message.tools.map(({ call, result }) => call.name + (result?.isError ? ' (failed)' : '')).join(', ') + ']' : '';
    return `${message.role}: ${message.content.slice(0, 180)}${tools.slice(0, 48)}`;
  });
  const limit = Math.max(512, Math.min(8_000, Math.floor(budget / 4)));
  const lines: string[] = [];
  let size = 0;
  for (const line of [...(previous?.summary?.split('\n') ?? []), ...excerpts].reverse()) {
    if (size + line.length + 1 > limit) break;
    lines.unshift(line);
    size += line.length + 1;
  }
  const summary = lines.join('\n');
  return {
    events: remaining.filter(({ seq }) => seq > boundary.seq),
    summary,
    compaction: { turnId, throughSeq: boundary.seq, summary },
  };
}
