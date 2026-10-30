// Read-only reductions of BB's normalized event envelopes. No message text is retained.
export interface EvidenceEvent { seq: number; createdAt: number; type: string; data: any; scope?: { kind: string; turnId?: string } }

export function acceptedHumanRequests(events: readonly EvidenceEvent[]): number[] {
  const requests = new Map<string, number>();
  const accepted: number[] = [];
  for (const event of [...events].sort((a, b) => a.seq - b.seq)) {
    const d = event.data ?? {};
    if (event.type === 'client/turn/requested' && typeof d.requestId === 'string' &&
        d.initiator === 'user' && d.senderThreadId == null && !d.retryOfRequestId &&
        (!d.systemMessageKind || d.systemMessageKind === 'unlabeled') && Array.isArray(d.input) &&
        d.input.length > 0 && d.input.every((part: any) => part && part.visibility !== 'agent-only')) {
      requests.set(d.requestId, event.createdAt);
    } else if (event.type === 'turn/input/accepted' && typeof d.clientRequestId === 'string') {
      const at = requests.get(d.clientRequestId);
      if (at !== undefined) { accepted.push(at); requests.delete(d.clientRequestId); }
    }
  }
  return accepted;
}

/** An outcome belongs to the last request only when BB confirms which root turn accepted it. */
export function latestChildRun(events: readonly EvidenceEvent[]): { state: 'done' | 'error' | 'running' | 'unknown'; execution: any; at: number | null } {
  let execution: any = null, at: number | null = null, requestId: string | null = null, rootTurn: string | null = null;
  let state: 'done' | 'error' | 'running' | 'unknown' = 'unknown';
  const rootTurns = new Set<string>();
  for (const event of [...events].sort((a,b) => a.seq - b.seq)) {
    const d = event.data ?? {};
    const turnId = event.scope?.kind === 'turn' && typeof event.scope.turnId === 'string' ? event.scope.turnId : null;
    if (event.type === 'turn/started' && turnId && !d.parentToolCallId) rootTurns.add(turnId);
    if (event.type === 'client/turn/requested') {
      execution = d.execution ?? null; at = event.createdAt; requestId = typeof d.requestId === 'string' ? d.requestId : null;
      rootTurn = null; state = 'running';
    } else if (at !== null && event.type === 'turn/input/accepted' && requestId && d.clientRequestId === requestId && turnId && rootTurns.has(turnId)) {
      rootTurn = turnId;
    } else if (at !== null && rootTurn && turnId === rootTurn && event.type === 'turn/completed') {
      state = d.status === 'completed' ? 'done' : d.status === 'failed' ? 'error' : 'unknown';
    } else if (at !== null && rootTurn && turnId === rootTurn && event.type === 'turn/mainRun/updated' && d.state === 'running') state = 'running';
  }
  return {state, execution, at};
}

/** Background task items carry the outcome; correlate only through a public item/tool ID. */
export function backgroundEvidence(events: readonly EvidenceEvent[]): Map<string, { id: string; itemId: string; aliases: string[]; name: string; state: 'running' | 'done' | 'error' | 'unknown'; at: number; observedAt: number; end: number | null }> {
  const out = new Map<string, { id: string; itemId: string; aliases: string[]; name: string; state: 'running' | 'done' | 'error' | 'unknown'; at: number; observedAt: number; end: number | null }>();
  const itemIds = new Map<string, string>();
  for (const event of [...events].sort((a,b) => a.seq-b.seq)) {
    const item = event.data?.item;
    if (!item || item.type !== 'backgroundTask' || item.taskType !== 'local_agent' || typeof item.id !== 'string') continue;
    const id = typeof item.parentToolCallId === 'string' && item.parentToolCallId ? item.parentToolCallId : item.id;
    const state = item.taskStatus === 'completed' ? 'done' : item.taskStatus === 'failed' ? 'error' :
      item.taskStatus === 'running' || item.taskStatus === 'pending' ? 'running' : 'unknown';
    const old = out.get(id);
    const previousItem = itemIds.get(id);
    itemIds.set(id, item.id);
    out.set(id, { id, itemId: item.id, aliases: [item.id, id], observedAt: event.createdAt, name: typeof item.description === 'string' ? item.description : 'Background agent', state,
      at: previousItem === item.id ? (old?.at ?? event.createdAt) : event.createdAt, end: state === 'running' ? null : event.createdAt });
  }
  return out;
}
