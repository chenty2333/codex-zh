import { createInterface } from 'node:readline';
const send = value => process.stdout.write(`${JSON.stringify(value)}\n`);
const input = createInterface({ input: process.stdin });
input.on('line', line => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') send({ id: message.id, result: { userAgent: 'test-backend' } });
  else if (message.method === 'turn/start') {
    const threadId = message.params.threadId;
    send({ id: message.id, result: { turn: { id: 'turn', status: 'inProgress', items: [] } } });
    send({ method: 'item/completed', params: { threadId, turnId: 'turn', item: { type: 'userMessage', id: 'user', clientId: message.params.clientUserMessageId, content: message.params.input } } });
    send({ method: 'item/started', params: { threadId, turnId: 'turn', item: { type: 'agentMessage', id: 'agent', text: '', phase: 'final_answer' } } });
    send({ method: 'item/agentMessage/delta', params: { threadId, turnId: 'turn', itemId: 'agent', delta: 'Hello draft' } });
    send({ method: 'item/completed', params: { threadId, turnId: 'turn', item: { type: 'agentMessage', id: 'agent', text: 'Hello', phase: 'final_answer' } } });
    send({ method: 'turn/completed', params: { threadId, turn: { id: 'turn', status: 'completed', items: [{ type: 'agentMessage', id: 'agent', text: 'Hello' }] } } });
  } else if (message.id !== undefined) send({ id: message.id, result: { echoed: message.params } });
});
