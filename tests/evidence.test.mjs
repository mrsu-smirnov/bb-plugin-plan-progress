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
test('only the root turn accepting the latest request can finish the child run', () => {
  const turn = (seq,type,turnId,data={}) => ({...e(seq,type,data),scope:{kind:'turn',turnId}});
  const events = [e(1,'client/turn/requested',{requestId:'req1',execution:{model:'first'}}),
    turn(2,'turn/started','main'),turn(3,'turn/input/accepted','main',{clientRequestId:'req1'}),
    turn(4,'turn/started','nested',{parentToolCallId:'delegate'}),turn(5,'turn/completed','nested',{status:'failed'})];
  assert.equal(latestChildRun(events).state,'running');
  events.push(turn(6,'turn/completed','main',{status:'completed'}));
  assert.deepEqual(latestChildRun(events), {state:'done',execution:{model:'first'},at:100});
  events.push(e(7,'client/turn/requested',{requestId:'req2',execution:{model:'second'}}),
    turn(8,'turn/started','next'),turn(9,'turn/input/accepted','next',{clientRequestId:'req2'}));
  assert.deepEqual(latestChildRun(events), {state:'running',execution:{model:'second'},at:700});
  events.push(turn(10,'turn/completed','main',{status:'completed'}),turn(11,'turn/completed','next',{status:'failed'}));
  assert.equal(latestChildRun(events).state,'error');
  events.push(e(12,'client/turn/requested',{requestId:'req3'}),turn(13,'turn/completed','next',{status:'completed'}));
  assert.deepEqual(latestChildRun(events), {state:'running',execution:null,at:1200});
});
test('background task item outcomes use stable IDs and never infer success from launch', () => {
  const item = {type:'backgroundTask', id:'task', parentToolCallId:'call', taskType:'local_agent', description:'Task'};
  const event = (n,status) => e(n,'item/backgroundTask/completed',{item:{...item,taskStatus:status}});
  assert.equal(backgroundEvidence([event(1,'running')]).get('call').state,'running');
  assert.equal(backgroundEvidence([event(1,'failed')]).get('call').state,'error');
  assert.equal(backgroundEvidence([event(1,'completed')]).get('call').state,'done');
  assert.equal(backgroundEvidence([event(1,'stopped')]).get('call').state,'unknown');
});
