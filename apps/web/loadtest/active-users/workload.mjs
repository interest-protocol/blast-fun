import assert from 'node:assert/strict';

export function isolatedDatabase(raw) {
  const url = new URL(raw);
  assert(["postgres:", "postgresql:"].includes(url.protocol));
  assert.equal(url.hostname, '127.0.0.1', 'Only the disposable loopback database is allowed');
  assert.equal(url.pathname, '/mission_control_test');
  assert.equal(url.username, 'postgres');
  assert(url.port && !url.search && !url.hash);
  return url;
}

// One foreground journey plus the shell requests, all under one persistent identity.
export function requestsFor(user) {
  const shell = [
    { path: '/api/social/me', interval: 60_000 },
    { path: '/api/social/me/presales', interval: 66_000 },
    { path: '/api/social/me/notifications', interval: 66_000 },
  ];
  switch (user % 4) {
    case 0: return [...shell, { path: '/api/social/home', interval: 30_000 }, { path: '/api/social/home/traders?window=24h', interval: 30_000 }];
    case 1: return [...shell, { path: '/api/social/me/portfolio?view=summary', interval: 66_000 }, { path: '/api/social/me/portfolio/coins?page=1', interval: 66_000 }];
    case 2: return [...shell, { path: '/api/social/presales?status=live&limit=20', interval: 30_000 }];
    default: return [...shell, { path: '/api/social/feed?limit=20', interval: 30_000 }];
  }
}

export function percentile(histogram, fraction) {
  const count = [...histogram.values()].reduce((sum, n) => sum + n, 0);
  let seen = 0;
  for (const [ms, n] of [...histogram].sort((a, b) => a[0] - b[0])) {
    seen += n;
    if (seen >= Math.ceil(count * fraction)) return ms;
  }
  return null;
}

/** First admission starts a user's clock; later overdue intervals are real drops. */
export function takeScheduled(job, now) {
  if (job.next > now) return null;
  if (!job.activated) { job.next = now; job.activated = true; }
  const missed = Math.max(0, Math.floor((now - job.next) / job.interval));
  const due = job.next;
  job.next += (missed + 1) * job.interval;
  return { due, missed };
}
