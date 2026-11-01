/** Executed by node in Hermes adapter tests; no provider, credentials or real Hermes state. */
import readline from 'node:readline';
import fs from 'node:fs';
const out = (v: unknown) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...v as object })}\n`);
const sessionId = 'hermes-fixture-session';
let promptId: unknown;
const update = (update: object, sid = sessionId) => out({ method: 'session/update', params: { sessionId: sid, update } });
const reply = (id: unknown, result: unknown) => out({ id, result });
const finish = () => {
  update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hello ' } });
  update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hermes.' } });
  reply(promptId, { stopReason: 'end_turn', usage: { inputTokens: 13, outputTokens: 5, cachedReadTokens: 4 } });
};
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  if (process.env.HERMES_TEST_LOG) fs.appendFileSync(process.env.HERMES_TEST_LOG, `${JSON.stringify(m)}\n`);
  if (!m.method) { if (m.id === 'permission') { update({ sessionUpdate: 'tool_call_update', toolCallId: 't1', status: m.result?.outcome?.optionId === 'allow_once' ? 'completed' : 'failed', content: [{ type: 'content', content: { type: 'text', text: 'tool result' } }] }); finish(); } return; }
  switch (m.method) {
    case 'initialize': reply(m.id, { protocolVersion: 1, agentCapabilities: { loadSession: true, promptCapabilities: { image: true } } }); break;
    case 'session/new': reply(m.id, { sessionId }); break;
    case 'session/load':
      if (m.params.sessionId === 'missing') { reply(m.id, null); break; }
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'old replay' } });
      reply(m.id, { modes: { currentModeId: 'default' } }); break;
    case 'session/set_mode': case 'session/set_model': reply(m.id, {}); break;
    case 'session/cancel': reply(promptId, { stopReason: 'cancelled' }); break;
    case 'session/prompt': {
      promptId = m.id;
      const prompt = m.params.prompt[0].text;
      if (prompt === 'crash') { process.stderr.write('api_key=do-not-leak-this-key'); process.exit(2); }
      if (prompt === 'hang') break;
      if (prompt === 'rpc-error') { out({ id: m.id, error: { code: -32000, message: 'token=very-secret-token' } }); break; }
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'wrong session' } }, 'other');
      update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Checking. ' } });
      update({ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Edit file', kind: 'edit', rawInput: { path: 'sample.ts' } });
      out({ id: 'permission', method: 'session/request_permission', params: { sessionId, toolCall: { toolCallId: 't1', kind: 'edit', title: 'Edit file', rawInput: { path: 'sample.ts' } }, options: [{ optionId: 'allow_always', kind: 'allow_always' }, { optionId: 'allow_once', kind: 'allow_once' }, { optionId: 'deny', kind: 'reject_once' }] } });
      if (prompt === 'permission-timeout') setTimeout(finish, 10);
      break;
    }
  }
});
