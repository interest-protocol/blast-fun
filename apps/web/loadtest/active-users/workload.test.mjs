import assert from 'node:assert/strict';
import test from 'node:test';
import { isolatedDatabase, requestsFor, percentile, takeScheduled } from './workload.mjs';

test('load fixture refuses production, remote, alternate databases and connection options', () => {
  assert.equal(isolatedDatabase('postgres://postgres:test@127.0.0.1:5432/mission_control_test').port, '5432');
  for (const url of [
    'postgres://postgres:test@production.example:5432/mission_control_test',
    'postgres://postgres:test@127.0.0.1:5432/neondb',
    'postgres://postgres:test@127.0.0.1:5432/mission_control_test?host=production.example',
    'postgres://app:test@127.0.0.1:5432/mission_control_test',
  ]) assert.throws(() => isolatedDatabase(url));
});

test('all 2000 identities have private reads and the mix covers each foreground journey', () => {
  const foreground = new Map();
  for (let user = 1; user <= 2000; user++) {
    const jobs = requestsFor(user);
    assert(jobs.some(job => job.path === '/api/social/me'));
    assert.equal(new Set(jobs.map(job => job.path)).size, jobs.length);
    for (const job of jobs) assert(job.interval > 0 && job.interval <= 66_000);
    foreground.set(jobs[3].path, (foreground.get(jobs[3].path) ?? 0) + 1);
  }
  assert.equal(foreground.size, 4);
  assert.deepEqual([...foreground.values()], [500, 500, 500, 500]);
  assert.equal(percentile(new Map([[10, 90], [500, 5], [1500, 5]]), 0.95), 500);
  assert.equal(percentile(new Map([[10, 90], [500, 5], [1500, 5]]), 0.99), 1500);
});

test('users first admitted after a ramp boundary have no phantom drops; active users retain missed work', () => {
  const job = { next: 10_000, interval: 30_000 };
  assert.equal(takeScheduled(job, 5_000), null);
  assert.deepEqual(takeScheduled(job, 300_000), { due: 300_000, missed: 0 });
  assert.equal(takeScheduled(job, 320_000), null);
  assert.deepEqual(takeScheduled(job, 400_000), { due: 330_000, missed: 2 });
  assert.equal(job.next, 420_000);
});
