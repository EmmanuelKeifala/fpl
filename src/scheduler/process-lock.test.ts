import { strict as assert } from 'node:assert';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { acquireExclusiveFileLock, assertNoForeignFileLock, withExclusiveFileLock } from './process-lock.js';

test('exclusive file lock blocks a second owner and releases cleanly', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fpl-lock-'));
  const path = join(directory, 'runner.lock');
  const release = acquireExclusiveFileLock(path, 'test runner');
  assert.throws(() => acquireExclusiveFileLock(path, 'second runner'), /already held/);
  const payload = JSON.parse(await readFile(path, 'utf8')) as { pid: number };
  assert.equal(payload.pid, process.pid);
  release();
  const releaseAgain = acquireExclusiveFileLock(path, 'replacement runner');
  releaseAgain();
});

test('exclusive file lock replaces a stale dead-process lock', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fpl-lock-stale-'));
  const path = join(directory, 'mutation.lock');
  await writeFile(path, JSON.stringify({ token: 'stale', pid: 999_999_999, createdAt: new Date().toISOString() }));
  const value = await withExclusiveFileLock(path, 'test mutation', async () => 42);
  assert.equal(value, 42);
});

test('foreign runner lock blocks another process while same-process ownership is allowed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fpl-lock-owner-'));
  const path = join(directory, 'runner.lock');
  await writeFile(path, JSON.stringify({ token: 'foreign', pid: 1, createdAt: new Date().toISOString() }));
  assert.throws(() => assertNoForeignFileLock(path, 'runner'), /another process/);
  await writeFile(path, JSON.stringify({ token: 'local', pid: process.pid, createdAt: new Date().toISOString() }));
  assert.doesNotThrow(() => assertNoForeignFileLock(path, 'runner'));
});
