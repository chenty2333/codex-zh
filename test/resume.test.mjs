import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { ResumeTracker, resumeCommand } from '../src/resume.mjs';

test('exit hint follows successful session selections, not reads or background threads', () => {
  const tracker = new ResumeTracker('/default');
  tracker.fromClient({ id: 1, method: 'thread/start', params: { cwd: '/project' } });
  tracker.fromServer({ id: 1, result: { thread: { id: 'first', cwd: '/project' } } });
  tracker.fromClient({ id: 2, method: 'thread/read', params: { threadId: 'background' } });
  tracker.fromServer({ id: 2, result: { thread: { id: 'background', cwd: '/other' } } });
  tracker.fromServer({ method: 'thread/started', params: { thread: { id: 'subagent', cwd: '/other' } } });
  tracker.fromClient({ id: 'temporary-structured', method: 'thread/start', params: { ephemeral: true } });
  tracker.fromServer({ id: 'temporary-structured', result: { thread: { id: 'background' } } });
  assert.deepEqual(tracker.session, { id: 'first', cwd: '/project' });
  tracker.fromClient({ id: 3, method: 'thread/resume', params: { threadId: 'missing' } });
  tracker.fromServer({ id: 3, error: { code: -1, message: 'Not found' } });
  assert.equal(tracker.session.id, 'first');
  tracker.fromClient({ id: 4, method: 'thread/resume', params: { threadId: 'second' } });
  tracker.fromServer({ id: 4, result: { thread: { id: 'second', cwd: '/saved-directory' } } });
  tracker.disconnect();
  assert.equal(tracker.pending.size, 0);
  assert.equal(resumeCommand(tracker.session), 'codex-zh resume second');
});

test('forks select the new session and archive/delete clear it; ephemeral sessions are not resumable', () => {
  const tracker = new ResumeTracker('/default');
  tracker.fromClient({ id: 1, method: 'thread/fork', params: { threadId: 'parent' } });
  tracker.fromServer({ id: 1, result: { thread: { id: 'fork' } } });
  assert.deepEqual(tracker.session, { id: 'fork', cwd: '/default' });
  tracker.fromClient({ id: 2, method: 'thread/archive', params: { threadId: 'other' } });
  tracker.fromServer({ id: 2, result: {} });
  assert.equal(tracker.session.id, 'fork');
  tracker.fromClient({ id: 3, method: 'thread/delete', params: { threadId: 'fork' } });
  tracker.fromServer({ id: 3, result: {} });
  assert.equal(tracker.session, null);
  tracker.fromClient({ id: 4, method: 'thread/start', params: { ephemeral: true } });
  tracker.fromServer({ id: 4, result: { thread: { id: 'temporary' } } });
  assert.equal(resumeCommand(tracker.session), 'codex-zh resume --all');
});

test('resume command omits the directory and quotes profiles containing shell metacharacters', () => {
  const directory = "/project with 'quotes' $(false) `false` 中文";
  const profileArgs = ['--profile', "profile with 'quotes'"];
  const command = resumeCommand({ id: 'saved-thread', cwd: directory }, { passthrough: true, profileArgs });
  const result = spawnSync('sh', ['-c', 'codex-zh() { printf "%s\\000" "$@"; }; ' + command], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  assert.deepEqual(result.stdout.split('\0').slice(0, -1), ['--passthrough', ...profileArgs, 'resume', 'saved-thread']);
});

test('simultaneous picker and main connections isolate request IDs and pending cleanup', () => {
  const state = { session: null };
  const main = new ResumeTracker('/main', state), picker = new ResumeTracker('/picker', state);
  main.fromClient({ id: 1, method: 'thread/start', params: {} });
  picker.fromClient({ id: 1, method: 'thread/read', params: { threadId: 'other' } });
  picker.fromServer({ id: 1, result: { thread: { id: 'other' } } });
  picker.disconnect();
  main.fromServer({ id: 1, result: { thread: { id: 'main' } } });
  assert.deepEqual(main.session, { id: 'main', cwd: '/main' });
  assert.equal(picker.session, main.session);
});
