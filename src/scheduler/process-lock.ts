import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

interface LockPayload {
  token: string;
  pid: number;
  createdAt: string;
  label: string;
}

export function acquireExclusiveFileLock(path: string, label: string): () => void {
  mkdirSync(dirname(path), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = randomUUID();
    try {
      const descriptor = openSync(path, 'wx', 0o600);
      const payload: LockPayload = { token, pid: process.pid, createdAt: new Date().toISOString(), label };
      try {
        writeFileSync(descriptor, JSON.stringify(payload));
        fsyncSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
      let released = false;
      return () => {
        if (released) return;
        released = true;
        try {
          const current = JSON.parse(readFileSync(path, 'utf8')) as Partial<LockPayload>;
          if (current.token === token) unlinkSync(path);
        } catch {
          // A missing lock is already released; a replaced lock belongs to another process.
        }
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST' || attempt > 0 || !removeStaleLock(path)) {
        throw new Error(`${label} lock is already held at ${path}`);
      }
    }
  }
  throw new Error(`Could not acquire ${label} lock at ${path}`);
}

export async function withExclusiveFileLock<T>(path: string, label: string, action: () => Promise<T>): Promise<T> {
  const release = acquireExclusiveFileLock(path, label);
  try {
    return await action();
  } finally {
    release();
  }
}

export function assertNoForeignFileLock(path: string, label: string): void {
  if (!existsSync(path)) return;
  try {
    const payload = JSON.parse(readFileSync(path, 'utf8')) as Partial<LockPayload>;
    if (payload.pid === process.pid) return;
    if (payload.pid !== undefined && Number.isInteger(payload.pid) && !processAlive(payload.pid)) {
      unlinkSync(path);
      return;
    }
  } catch {
    // A malformed lock is treated as held because ownership cannot be proven.
  }
  throw new Error(`${label} lock is held by another process at ${path}`);
}

function removeStaleLock(path: string): boolean {
  if (!existsSync(path)) return true;
  try {
    const payload = JSON.parse(readFileSync(path, 'utf8')) as Partial<LockPayload>;
    if (!Number.isInteger(payload.pid) || payload.pid === undefined || processAlive(payload.pid)) return false;
    unlinkSync(path);
    return true;
  } catch {
    return false;
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}
