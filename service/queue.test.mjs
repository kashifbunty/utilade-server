/**
 * Tests for the limit that protects the other site.
 *
 * The queue is the one piece of this service whose correctness cannot be seen
 * by looking at a converted document. If it lets three jobs run, nothing looks
 * wrong — until a busy afternoon, on a box that also serves somebody's
 * customers.
 *
 * Run: node server/service/queue.test.mjs
 */

import assert from "node:assert/strict";

import { createQueue } from "./queue.mjs";

let failures = 0;

async function it(name, fn) {
  try {
    await fn();
    console.log(`  PASS  ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`  FAIL  ${name}`);
    console.log(`        ${error.message}`);
  }
}

/** A job that finishes when you tell it to, so timing is decided not raced. */
function controllable() {
  let release;
  const promise = new Promise((resolve) => {
    release = resolve;
  });
  return { job: () => promise, release: () => release() };
}

console.log("\nthe queue never runs more than it is allowed\n");

await it("only two jobs run at once, however many arrive", async () => {
  const queue = createQueue({ concurrency: 2 });
  const jobs = [controllable(), controllable(), controllable()];

  jobs.forEach((entry) => queue.run(entry.job));
  await Promise.resolve();

  assert.equal(queue.running, 2, "a third job started");
  assert.equal(queue.waiting, 1, "the third job should be waiting");

  jobs[0].release();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(queue.running, 2, "the waiting job should have started");
  assert.equal(queue.waiting, 0);

  jobs.forEach((entry) => entry.release());
});

await it("a finished job frees its slot even when it fails", async () => {
  const queue = createQueue({ concurrency: 1 });

  await queue.run(() => Promise.reject(new Error("boom"))).catch(() => {});
  assert.equal(queue.running, 0, "a failure left the slot occupied");

  const result = await queue.run(() => Promise.resolve("ok"));
  assert.equal(result, "ok", "the queue stopped accepting work after a failure");
});

await it("a job that throws synchronously is still a failure, not a crash", async () => {
  const queue = createQueue({ concurrency: 1 });
  await assert.rejects(
    queue.run(() => {
      throw new Error("thrown, not returned");
    }),
    /thrown, not returned/,
  );
  assert.equal(queue.running, 0);
});

console.log("\nwaiting is bounded, and says so\n");

await it("refuses immediately once the waiting room is full", async () => {
  const queue = createQueue({ concurrency: 1, maxWaiting: 1 });
  const running = controllable();
  const queued = controllable();

  queue.run(running.job);
  queue.run(queued.job);
  await Promise.resolve();

  assert.equal(queue.full, true, "the queue should report itself full");
  await assert.rejects(queue.run(() => Promise.resolve()), /busy/i);

  running.release();
  queued.release();
});

await it("the refusal carries a status the server can use", async () => {
  const queue = createQueue({ concurrency: 1, maxWaiting: 0 });
  const running = controllable();
  queue.run(running.job);
  await Promise.resolve();

  const error = await queue.run(() => Promise.resolve()).catch((e) => e);
  assert.equal(error.status, 503);
  running.release();
});

await it("room becomes available again once jobs drain", async () => {
  const queue = createQueue({ concurrency: 1, maxWaiting: 1 });
  const running = controllable();

  queue.run(running.job);
  const waiting = queue.run(() => Promise.resolve("second"));
  await Promise.resolve();
  assert.equal(queue.full, true);

  running.release();
  assert.equal(await waiting, "second");
  assert.equal(queue.full, false, "the queue stayed full after draining");
});

console.log(failures === 0 ? "\nAll checks passed.\n" : `\n${failures} failed.\n`);
process.exit(failures === 0 ? 0 : 1);
