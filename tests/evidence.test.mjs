import { test } from 'node:test';
import assert from 'node:assert/strict';
import { acceptedHumanRequests, latestChildRun, backgroundEvidence } from '../evidence.ts';
const e = (seq, type, data) => ({seq, type, data, createdAt: seq * 100});
const request = (id, extra = {}) => ({requestId: id, initiator:'user', senderThreadId:null, systemMessageKind:'unlabeled', input:[{type:'text'}], ...extra});
test('only an accepted visible human request is an answer', () => {
  const events = [e(1,'client/turn/requested',request('human')),e(2,'turn/input/accepted',{clientRequestId:'human'}),
    e(3,'client/turn/requested',request('hidden',{input:[{visibility:'agent-only'}]})),e(4,'turn/input/accepted',{clientRequestId:'hidden'}),
    e(5,'client/turn/requested',request('child',{initiator:'system',systemMessageKind:'child-completed'})),e(6,'turn/input/accepted',{clientRequestId:'child'}),
    e(7,'client/turn/requested',request('retry',{retryOfRequestId:'old'})),e(8,'turn/input/accepted',{clientRequestId:'retry'}),
    e(9,'client/turn/requested',request('agent',{senderThreadId:'other'})),e(10,'turn/input/accepted',{clientRequestId:'agent'}),
    e(11,'client/turn/requested',request('unaccepted'))];
  assert.deepEqual(acceptedHumanRequests(events), [100]);
});
test('a new child request resets outcome and execution', () => {
  const events = [e(1,'client/turn/requested',{execution:{model:'first'}}), e(2,'turn/completed',{status:'completed'}),
    e(3,'client/turn/requested',{execution:{model:'second'}})];
  assert.deepEqual(latestChildRun(events), {state:'running', execution:{model:'second'}, at:300});
  events.push(e(4,'turn/completed',{status:'failed'}));
  assert.equal(latestChildRun(events).state,'error');
  events.push(e(5,'client/turn/requested',{}), e(6,'turn/completed',{status:'completed'}));
  assert.deepEqual(latestChildRun(events), {state:'done',execution:null,at:500});
});
test('background task item outcomes use stable IDs and never infer success from launch', () => {
  const item = {type:'backgroundTask', id:'task', parentToolCallId:'call', taskType:'local_agent', description:'Task'};
  const event = (n,status) => e(n,'item/backgroundTask/completed',{item:{...item,taskStatus:status}});
  assert.equal(backgroundEvidence([event(1,'running')]).get('call').state,'running');
  assert.equal(backgroundEvidence([event(1,'failed')]).get('call').state,'error');
  assert.equal(backgroundEvidence([event(1,'completed')]).get('call').state,'done');
  assert.equal(backgroundEvidence([event(1,'stopped')]).get('call').state,'unknown');
});
