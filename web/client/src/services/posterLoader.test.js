import test from 'node:test';
import assert from 'node:assert/strict';
import { createPosterLoader, MAX_POSTER_RETRIES } from './posterLoader.js';

const initial = { courseId: 12, videoId: 34, domain: 'media.example.test', path: '/posters/12/34/job-a.jpg', ready: true,
  status: 'worker_transcoding', token: 'token-a', revision: 1 };
function fixture(overrides = {}) {
  const changes = [], timers = new Map();
  let id = 0;
  const loader = createPosterLoader({ onChange: state => changes.push(state),
    schedule(fn, delay) { const key = ++id; timers.set(key, { fn, delay }); return key; },
    cancel(key) { timers.delete(key); },
  });
  let input = { ...initial, ...overrides };
  const update = changes => { input = { ...input, ...changes }; loader.update(input); };
  update({});
  return { loader, changes, timers, update,
    state: () => changes.at(-1),
    requests: () => changes.filter(x => x.phase === 'loading'),
    fail() { loader.failed(changes.at(-1).id); },
    load() { loader.loaded(changes.at(-1).id); },
    runTimer() { const [key, item] = timers.entries().next().value; timers.delete(key); item.fn(); return item.delay; },
  };
}

test('no request is made before the list supplies a ready poster and token', () => {
  for (const ready of [false, undefined, null, 0, 1, 'true']) {
    const waiting = fixture({ ready }); waiting.update({ revision: 2 });
    assert.equal(waiting.requests().length, 0);
    assert.equal(waiting.timers.size, 0);
  }
  const f = fixture({ token: '' });
  f.update({ revision: 2 });
  assert.equal(f.requests().length, 0);
  assert.equal(f.timers.size, 0);
  f.update({ revision: 3, token: 'eligible-token' });
  assert.equal(f.requests().length, 1);
});

test('failed processing poster waits for the next list response and uses its newest token', () => {
  const f = fixture(); f.fail();
  assert.equal(f.timers.size, 0);
  f.update({ token: 'new-token', revision: 1 });
  assert.equal(f.requests().length, 1);
  f.update({ token: 'new-token', revision: 2 });
  assert.equal(f.requests().length, 2);
  const url = new URL(f.state().src);
  assert.equal(url.searchParams.get('verify'), 'new-token');
  assert.equal(url.pathname, initial.path);
  assert.deepEqual([...url.searchParams.keys()], ['verify']);
  f.load(); const loaded = f.state();
  f.update({ token: 'rotated-again', revision: 3 });
  assert.deepEqual(f.state(), loaded);
  assert.equal(f.requests().length, 2);
});

test('a response received before the image failed does not count as its retry trigger', () => {
  const f = fixture(); f.update({ revision: 2, token: 'token-b' }); f.fail();
  f.update({ revision: 2 }); assert.equal(f.requests().length, 1);
  f.update({ revision: 3, token: 'token-c' }); assert.equal(f.requests().length, 2);
});

test('unchanged progress can retry once per accepted response, never repeatedly within it', () => {
  const f = fixture();
  for (let revision = 2; revision <= 20; revision++) {
    f.fail(); f.update({ revision, token: `token-${revision}` });
    const count = f.requests().length;
    f.loader.failed('stale-request'); f.update({ revision });
    assert.equal(f.requests().length, count);
    assert.equal(f.timers.size, 0);
  }
  assert.equal(f.requests().length, 20);
});

for (const status of ['finished', 'error']) test(`${status} poster retains ten bounded short retries`, () => {
  const f = fixture({ status });
  for (let retry = 0; retry < MAX_POSTER_RETRIES; retry++) {
    f.fail(); assert.equal(f.timers.size, 1);
    f.update({ token: `fresh-${retry}`, revision: retry + 2 });
    assert.equal(f.runTimer(), 500 + retry * 500);
    assert.equal(new URL(f.state().src).searchParams.get('verify'), `fresh-${retry}`);
  }
  f.fail();
  assert.equal(f.requests().length, MAX_POSTER_RETRIES + 1);
  assert.equal(f.state().phase, 'exhausted');
  assert.equal(f.timers.size, 0);
  f.update({ revision: 100, token: 'another-token' });
  assert.equal(f.requests().length, MAX_POSTER_RETRIES + 1);
});

test('finishing the same poster keeps its loaded URL, while error ready=false removes it', () => {
  const loaded = fixture(); loaded.load(); const image = loaded.state();
  loaded.update({ status: 'finished', token: 'new-token', revision: 2 });
  assert.deepEqual(loaded.state(), image);
  assert.equal(loaded.requests().length, 1);
  loaded.update({ status: 'error', ready: false, token: '', revision: 3 });
  assert.equal(loaded.state().phase, 'idle');
  assert.equal(loaded.state().src, null);
  loaded.loader.loaded(image.id);
  assert.equal(loaded.state().phase, 'idle');
});

test('a ready error poster has a fresh bounded budget after processing failures', () => {
  const failed = fixture();
  for (let i = 2; i <= 15; i++) { failed.fail(); failed.update({ revision: i }); }
  failed.fail(); failed.update({ status: 'error', revision: 16 });
  assert.equal(failed.timers.size, 1);
  const oldId = failed.state().id;
  const oldUrl = failed.state().src;
  assert.equal(failed.runTimer(), 500);
  assert.notEqual(failed.state().id, oldId);
  assert.equal(failed.state().src, oldUrl);
});

test('a new server path cancels timers and rejects stale image events without query nonces', () => {
  const f = fixture({ status: 'finished' }); f.fail();
  const oldId = f.state().id;
  const oldTimer = [...f.timers.values()][0].fn;
  f.update({ path: '/posters/12/34/job-b.jpg', status: 'worker_transcoding', token: 'job-b-token', revision: 2 });
  const next = f.state(); assert.equal(f.timers.size, 0);
  oldTimer(); f.loader.loaded(oldId); f.loader.failed(oldId);
  assert.deepEqual(f.state(), next);
  f.load();
  f.update({ status: 'finished', token: 'final-token', revision: 3 });
  assert.equal(f.requests().length, 2);
  assert.equal(new URL(f.state().src).pathname, '/posters/12/34/job-b.jpg');
  assert.deepEqual([...new URL(f.state().src).searchParams.keys()], ['verify']);
});

test('ready reset cancels ordinary retries and late loads cannot restore a removed poster', () => {
  const f = fixture({ status: 'finished' }); f.fail();
  const oldId = f.state().id, oldTimer = [...f.timers.values()][0].fn;
  f.update({ ready: false, revision: 2 });
  assert.equal(f.state().src, null);
  assert.equal(f.timers.size, 0);
  oldTimer(); f.loader.loaded(oldId); f.loader.failed(oldId);
  assert.equal(f.requests().length, 1);
  assert.equal(f.state().phase, 'idle');
  f.update({ ready: true, token: 'new-token', revision: 3 });
  assert.equal(f.requests().length, 2);
  assert.notEqual(f.state().id, oldId);
  f.loader.loaded(oldId);
  assert.equal(f.state().phase, 'loading');
});

test('a missing server path is never reconstructed, and legacy paths use verify-only queries', () => {
  const waiting = fixture({ path: undefined });
  assert.equal(waiting.requests().length, 0);
  waiting.update({ path: '/posters/12/34.jpg' });
  assert.equal(waiting.requests().length, 1);
  assert.equal(waiting.state().src, 'https://media.example.test/posters/12/34.jpg?verify=token-a');
  for (const path of ['/posters/12/34.jpg?r=1', '/posters/12/34.jpg#fragment', 'https://other.example.test/file.jpg']) {
    const invalid = fixture({ path }); assert.equal(invalid.requests().length, 0);
  }
});

test('changing course or media host never retains the previous image URL', () => {
  const f = fixture(); f.load();
  f.update({ courseId: 98, domain: 'new-media.example.test', path: '/posters/98/34/job-b.jpg', token: 'next-token' });
  const url = new URL(f.state().src);
  assert.equal(url.host, 'new-media.example.test');
  assert.equal(url.pathname, '/posters/98/34/job-b.jpg');
  assert.equal(f.state().phase, 'loading');
});

test('unmount disposes timers and ignores late callbacks or updates', () => {
  const f = fixture({ status: 'finished' }); f.fail();
  const request = f.state().id, timer = [...f.timers.values()][0].fn;
  f.loader.dispose(); const count = f.changes.length;
  timer(); f.loader.loaded(request); f.loader.failed(request); f.update({ path: '/posters/12/34/job-b.jpg' });
  assert.equal(f.timers.size, 0);
  assert.equal(f.changes.length, count);
});
