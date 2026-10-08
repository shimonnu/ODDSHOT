import assert from "node:assert/strict";
import { test } from "node:test";
import { processPhotoBackground } from "../lib/photo-background";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(complete => { resolve = complete; });
  return { promise, resolve };
}

test("a title completed during the first Drive lease gets its queued filename revision drained after that upload", { timeout: 5000 }, async () => {
  const titleReady = deferred<void>();
  const uploadReady = deferred<void>();
  const uploadStarted = deferred<void>();
  let requestedRevision = 1;
  let completedRevision = 0;
  let leased = false;
  let dispatches = 0;
  const uploadedRevisions: number[] = [];
  const titles = titleReady.promise.then(() => { requestedRevision = 2; });
  const background = processPhotoBackground(titles, async () => {
    dispatches++;
    if (leased || completedRevision === requestedRevision) return { processed: 0 };
    leased = true;
    const revision = requestedRevision;
    if (revision === 1) {
      uploadStarted.resolve();
      await uploadReady.promise;
    }
    uploadedRevisions.push(revision);
    completedRevision = revision;
    leased = false;
    return { processed: 1 };
  }, () => { assert.fail("the controlled upload must not fail"); });
  try {
    await uploadStarted.promise;
    titleReady.resolve();
    await titles;
    // Flush continuations without releasing the first lease or depending on a timed sleep.
    await new Promise<void>(resolve => { setImmediate(resolve); });
    assert.equal(leased, true);
    assert.equal(requestedRevision, 2);
    assert.equal(completedRevision, 0);
    assert.equal(dispatches, 1, "a title callback must not try to claim a job still being uploaded");
    uploadReady.resolve();
    await background;
    assert.deepEqual(uploadedRevisions, [1, 2]);
    assert.equal(completedRevision, requestedRevision, "the new filename must not wait for a future Cron invocation");
    assert.equal(dispatches, 2);
    assert.equal(leased, false);
  } finally {
    titleReady.resolve();
    uploadReady.resolve();
    await background;
  }
});

test("an already-complete or manual title dispatches its initial Drive upload only once", async () => {
  let dispatches = 0;
  let failures = 0;
  await processPhotoBackground(undefined, async () => {
    dispatches++;
    return { processed: 1 };
  }, () => { failures++; });
  assert.equal(dispatches, 1);
  assert.equal(failures, 0);
});

test("initial upload or title failure does not discard the other task or prevent the final queue drain", async () => {
  let dispatches = 0;
  let failures = 0;
  const titles = Promise.reject(new Error("offline title storage failure"));
  await assert.doesNotReject(processPhotoBackground(titles, () => {
    dispatches++;
    if (dispatches === 1) throw new Error("offline initial dispatch failure");
    return Promise.resolve({ processed: 1 });
  }, () => { failures++; }));
  assert.equal(dispatches, 2, "the final drain runs even when the initial dispatch throws synchronously");
  assert.equal(failures, 2, "both independent failures are observed");
});
