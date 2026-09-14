import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestDb, closeTestDb } from './helpers.js';

test('old database migration preserves rows and stores manipulation answers with one formal session', async () => {
  const fixture = createTestDb();
  const originalCount = fixture.db.prepare('SELECT count(*) AS n FROM sessions').get().n;
  const socket = net.createServer();
  socket.listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  const child = spawn(process.execPath, ['index.js'], {
    cwd: fileURLToPath(new URL('../', import.meta.url)),
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), DB_PATH: path.join(fixture.dir, 'test.db') },
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
  });
  try {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(Error('API startup timeout')), 10000);
      child.stdout.on('data', chunk => {
        if (String(chunk).includes('[api] listening')) { clearTimeout(timeout); resolve(); }
      });
      child.once('exit', code => { clearTimeout(timeout); reject(Error(`API exited ${code}`)); });
    });
    const answers = JSON.stringify(['材料主旨', '关键信息']);
    const body = {
      clientSessionId: 'manipulation-test', participantId: 'test',
      startedAtIso: new Date().toISOString(), submittedAtIso: new Date().toISOString(),
      runKind: 'formal', revealMode: 'full', comprehensionAnswer: 'q1=less;q2=wait',
      treatment: 'C1', interventionMs: 15000, manipulationAnswers: answers,
      summary: { elapsedSec: 8, money: 84, violations: 1 },
      device: { screenWidth: 1280, screenHeight: 720, viewportWidth: 1280, viewportHeight: 720 }, events: []
    };
    const submit = body => fetch(`http://127.0.0.1:${port}/api/submissions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:5173' },
      body: JSON.stringify(body)
    });
    const response = await submit(body);
    assert.equal(response.status, 200, await response.text());
    assert.equal(fixture.db.prepare('SELECT manipulation_answers FROM sessions WHERE client_session_id=?').get(body.clientSessionId).manipulation_answers, answers);
    assert.equal((await submit(body)).status, 200);
    assert.equal(fixture.db.prepare('SELECT count(*) AS n FROM sessions').get().n, originalCount + 1);
    assert.equal((await submit({ ...body, clientSessionId: 'invalid', manipulationAnswers: '[""]' })).status, 400);
    assert.equal((await submit({ ...body, clientSessionId: 'legacy', manipulationAnswers: undefined })).status, 200);
  } finally {
    if (child.exitCode === null) { const stopped = once(child, 'exit'); child.kill(); await stopped; }
    closeTestDb(fixture);
  }
});
