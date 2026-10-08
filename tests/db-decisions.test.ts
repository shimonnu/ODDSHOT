import assert from "node:assert/strict";
import { after, test } from "node:test";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";
import { ApiError, createPhoto, createProfile, generatePhotoTitles, getPhoto, getState, updatePhotoTitle } from "../lib/db";

const originalDirectory = process.cwd();
const fixture = mkdtempSync(path.join(tmpdir(), "oddshot-db-fixture-"));
mkdirSync(path.join(fixture, "public/images"), { recursive: true });
for (const name of ["forest", "sky"]) {
  copyFileSync(path.join(originalDirectory, `public/images/${name}.jpg`), path.join(fixture, `public/images/${name}.jpg`));
}
// Start with the original schema to verify ALTER migrations preserve real old rows.
mkdirSync(path.join(fixture, "work"));
const legacyDatabase = new DatabaseSync(path.join(fixture, "work/oddshot.sqlite"));
legacyDatabase.exec(`
  CREATE TABLE profiles (id TEXT PRIMARY KEY, nickname TEXT NOT NULL, nickname_key TEXT NOT NULL UNIQUE, color TEXT NOT NULL, created_at TEXT NOT NULL);
  CREATE TABLE photos (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES profiles(id), title TEXT NOT NULL, image_bytes BLOB, mime_type TEXT NOT NULL, sample_key TEXT, created_at TEXT NOT NULL, sync_status TEXT NOT NULL, sync_updated_at TEXT);
  CREATE TABLE evaluations (id TEXT PRIMARY KEY, photo_id TEXT NOT NULL UNIQUE REFERENCES photos(id), evaluation_json TEXT NOT NULL, created_at TEXT NOT NULL);
`);
legacyDatabase.prepare("INSERT INTO profiles VALUES (?, ?, ?, ?, ?)").run("legacy-user", "以前からの参加者", "以前からの参加者", "#D4E97D", "2026-10-01T00:00:00.000Z");
legacyDatabase.prepare("INSERT INTO photos VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run("legacy-photo", "legacy-user", "以前のタイトル", readFileSync(path.join(fixture, "public/images/forest.jpg")), "image/jpeg", "forest", "2026-10-01T01:00:00.000Z", "synced", "2026-10-01T01:00:00.000Z");
legacyDatabase.prepare("INSERT INTO evaluations VALUES (?, ?, ?, ?)").run("legacy-evaluation", "legacy-photo", JSON.stringify({
  id: "legacy-evaluation", score: 96, rank: "S", reason: "以前の採点理由", tags: ["以前のタグ"],
  axes: { atmosphere: 25, light: 23, symbolism: 23, story: 25 }, createdAt: "2026-10-01T01:00:00.000Z", isDemo: true,
}), "2026-10-01T01:00:00.000Z");
legacyDatabase.close();
process.chdir(fixture);
const originalFetch = globalThis.fetch;
after(() => {
  globalThis.fetch = originalFetch;
  (globalThis as { oddshotDatabase?: DatabaseSync }).oddshotDatabase?.close();
  process.chdir(originalDirectory);
  rmSync(fixture, { recursive: true, force: true });
});

test("fresh SQLite keeps sample assets separate from participants, posts and rankings", () => {
  const emptyFixture = mkdtempSync(path.join(tmpdir(), "oddshot-empty-db-fixture-"));
  try {
    const result = spawnSync(process.execPath, ["-e", `
      const assert = require("node:assert/strict");
      const { getState } = require(${JSON.stringify(path.join(__dirname, "../lib/db.js"))});
      getState().then(state => {
        assert.deepEqual(state.profiles, []);
        assert.deepEqual(state.photos, []);
        assert.deepEqual(state.ranking, []);
        assert.equal(state.criteria.version, "decisions-v1");
        globalThis.oddshotDatabase.close();
      }).catch(error => { console.error(error); process.exitCode = 1; });
    `], {
      cwd: emptyFixture,
      encoding: "utf8",
      env: { ...process.env, ODDSHOT_STORAGE_MODE: "sqlite", ODDSHOT_SCORING_MODE: "demo", OPENAI_API_KEY: "" },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    rmSync(emptyFixture, { recursive: true, force: true });
  }
});

test("Decisions result persists with criteria and retries count one photo", async () => {
  const before = await getState();
  assert.equal(before.profiles.length, 1, "schema migration must not recreate demo participants");
  assert.equal(before.photos.length, 1, "schema migration must not recreate demo posts");
  const legacy = before.photos.map(photo => ({ id: photo.id, score: photo.evaluation.score }));
  assert.equal(before.criteria?.version, "decisions-v1");
  assert.equal(before.ai?.mode, "demo");
  assert.equal(before.photos[0].title, "以前のタイトル");
  assert.equal(before.photos[0].titleSuggestions, undefined);
  assert.equal(before.photos[0].evaluation.criteriaVersion, "demo-v1");
  const profile = await createProfile("オフライン検証");
  process.env.ODDSHOT_SCORING_MODE = "decisions";
  process.env.OPENAI_API_KEY = "offline-test-key";
  let calls = 0;
  globalThis.fetch = async (_url, init) => {
    calls++;
    const body = JSON.parse(String(init?.body)) as {
      questions: { type: string; name: string; levels?: { label: string }[] }[];
    };
    return Response.json({
      model: "gpt-6-luna",
      answers: body.questions.map(question => question.type === "score" ? {
        type: "score", name: question.name, score: 4, confidence: 0.98,
        probabilities: question.levels!.map((level, index) => ({ label: level.label, value: index, probability: index === 4 ? 1 : 0 })),
      } : { type: "predicate", name: question.name, probability: 0.9 }),
      usage: { input_tokens: 1500, output_tokens: 0, total_tokens: 1500 },
    });
  };
  const input = { userId: profile.id, title: "保存と再送の検証", image: "", sampleKey: "forest", requestId: "offline-db-request-one" };
  const [first, duplicate] = await Promise.all([createPhoto(input), createPhoto(input)]);
  assert.equal(first.id, duplicate.id);
  assert.equal(first.evaluation.isDemo, false);
  assert.equal(first.evaluation.score, 100);
  assert.equal(first.evaluation.rank, "S");
  assert.equal(first.evaluation.criteriaVersion, "decisions-v1");
  assert.equal(first.evaluation.ai?.provider, "openai-decisions");
  assert.equal(first.evaluation.ai?.usage?.inputTokens, 1500);
  assert.equal(calls, 1);
  const repeated = await createPhoto(input);
  assert.equal(repeated.id, first.id);
  assert.equal(calls, 1);
  const state = await getState();
  assert.equal(state.photos.length, before.photos.length + 1);
  assert.equal(state.ranking.find(entry => entry.id === profile.id)?.highCount, 1);
  assert.deepEqual(state.photos.filter(photo => legacy.some(item => item.id === photo.id)).map(photo => ({ id: photo.id, score: photo.evaluation.score })), legacy);
  await assert.rejects(createPhoto({ ...input, title: "別の内容" }), /同じ|再送|変更|別|一致/);
  assert.equal(calls, 1);

  const count = state.photos.length;
  globalThis.fetch = async () => { calls++; return Response.json({ error: { message: "fake upstream failure" } }, { status: 429 }); };
  await assert.rejects(createPhoto({ ...input, requestId: "offline-db-rate-limit" }));
  assert.equal((await getState()).photos.length, count, "an upstream failure must not create a fake success");
  assert.equal((await getState()).ranking.find(entry => entry.id === profile.id)?.highCount, 1);

  delete process.env.OPENAI_API_KEY;
  const callsBeforeMissingKey = calls;
  await assert.rejects(createPhoto({ ...input, requestId: "offline-db-missing-key" }));
  assert.equal(calls, callsBeforeMissingKey, "missing credentials must not send an HTTP request");
  assert.equal((await getState()).photos.length, count);
  process.env.ODDSHOT_SCORING_MODE = "demo";
});

test("empty demo titles get sample candidates, while manual titles skip generation", async () => {
  process.env.ODDSHOT_SCORING_MODE = "demo";
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error("offline tests never use a network"); };
  const profile = await createProfile("タイトルのデモ検証");
  const auto = await createPhoto({ userId: profile.id, title: "  ", image: "", sampleKey: "forest", requestId: "demo-title-automatic" });
  assert.equal(auto.titleSuggestions?.source, "demo");
  assert.ok(auto.titleSuggestions!.suggestions.length >= 1);
  assert.equal(auto.title, auto.titleSuggestions!.suggestions[0]);
  assert.notEqual(auto.title, "名前のない一枚");
  assert.deepEqual((await getState()).photos.find(photo => photo.id === auto.id)?.titleSuggestions, auto.titleSuggestions);
  const manual = await createPhoto({ userId: profile.id, title: "  わたしのタイトル  ", image: "", sampleKey: "forest", requestId: "demo-title-manual" });
  assert.equal(manual.title, "わたしのタイトル");
  assert.equal(manual.titleSuggestions, undefined);
  assert.equal(calls, 0);
});

function scoredResponse(init?: RequestInit): Response {
  const body = JSON.parse(String(init?.body)) as { questions: { type: string; name: string; levels?: { label: string }[] }[] };
  return Response.json({
    model: "gpt-6-luna",
    answers: body.questions.map(question => question.type === "score" ? {
      type: "score", name: question.name, score: 4, confidence: 0.98,
      probabilities: question.levels!.map((level, index) => ({ label: level.label, value: index, probability: index === 4 ? 1 : 0 })),
    } : { type: "predicate", name: question.name, probability: 0.9 }),
    usage: { input_tokens: 1500, output_tokens: 0, total_tokens: 1500 },
  });
}

function titleResponse(suggestions: string[]): Response {
  const text = JSON.stringify({ titles: suggestions });
  return Response.json({
    id: "resp_offline_titles", object: "response", status: "completed", model: "gpt-6-luna",
    output: [{ type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text }] }],
  });
}

test("live automatic titles run alongside scoring, persist, and retry without extra calls", async () => {
  process.env.ODDSHOT_SCORING_MODE = "decisions";
  process.env.OPENAI_API_KEY = "offline-test-key";
  const profile = await createProfile("AIタイトルの保存検証");
  const before = (await getState()).photos.length;
  let calls = 0;
  let release: () => void = () => {};
  const bothStarted = new Promise<void>(resolve => { release = resolve; });
  globalThis.fetch = async (url, init) => {
    calls++;
    if (calls === 2) release();
    await bothStarted;
    return String(url).endsWith("/decisions") ? scoredResponse(init) : titleResponse(["霧の奥の入口", "森に残る静けさ", "向こう側の気配"]);
  };
  const input = { userId: profile.id, title: "", image: "", sampleKey: "forest", requestId: "live-auto-titles-dedupe" };
  const [first, second] = await Promise.all([createPhoto(input), createPhoto(input)]);
  assert.equal(calls, 2, "one scoring call and one title call run in parallel");
  assert.equal(first.id, second.id);
  assert.equal(first.title, "霧の奥の入口");
  assert.deepEqual(first.titleSuggestions, { source: "ai", suggestions: ["霧の奥の入口", "森に残る静けさ", "向こう側の気配"] });
  const repeated = await createPhoto(input);
  assert.equal(repeated.id, first.id);
  assert.equal(calls, 2);
  assert.equal((await getState()).photos.length, before + 1);
  assert.equal((await getState()).ranking.find(entry => entry.id === profile.id)?.highCount, 1);
  assert.deepEqual((await getState()).photos.find(photo => photo.id === first.id)?.titleSuggestions, first.titleSuggestions);
  process.env.ODDSHOT_SCORING_MODE = "demo";
  delete process.env.OPENAI_API_KEY;
});

test("title service failure keeps a successful score and permits a later candidate retry", async () => {
  process.env.ODDSHOT_SCORING_MODE = "decisions";
  process.env.OPENAI_API_KEY = "offline-test-key";
  const profile = await createProfile("タイトル失敗の検証");
  let calls = 0;
  globalThis.fetch = async (url, init) => {
    calls++;
    return String(url).endsWith("/decisions") ? scoredResponse(init) : Response.json({ error: { message: "offline title failure" } }, { status: 429 });
  };
  const photo = await createPhoto({ userId: profile.id, title: "", image: "", sampleKey: "sky", requestId: "title-service-failure" });
  assert.equal(photo.title, "名前のない一枚");
  assert.deepEqual(photo.titleSuggestions, { source: "unavailable", suggestions: [] });
  assert.equal(photo.evaluation.rank, "S");
  assert.equal(calls, 2);
  assert.equal((await getState()).ranking.find(entry => entry.id === profile.id)?.highCount, 1);
  globalThis.fetch = async () => { calls++; return titleResponse(["空に残る余韻", "夕暮れのサイン", "雲の向こう側"]); };
  const updated = await generatePhotoTitles(photo.id, profile.id);
  assert.equal(updated.title, photo.title, "regeneration must not overwrite the user's current title");
  assert.equal(updated.titleSuggestions?.source, "ai");
  assert.equal(updated.evaluation.id, photo.evaluation.id);
  assert.equal(calls, 3, "regeneration must not re-score the photo");
  process.env.ODDSHOT_SCORING_MODE = "demo";
  delete process.env.OPENAI_API_KEY;
});

test("title editing is owner matched, validated, and preserves score, ranking and candidates", async () => {
  process.env.ODDSHOT_SCORING_MODE = "demo";
  const profile = await createProfile("名前変更の検証");
  const another = await createProfile("別の参加者");
  const photo = await createPhoto({ userId: profile.id, title: "", image: "", sampleKey: "sky", requestId: "title-owner-validation" });
  const ranking = (await getState()).ranking;
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error("title edit must not call AI"); };
  for (const title of ["", " ", "あ".repeat(61)]) {
    await assert.rejects(updatePhotoTitle(photo.id, profile.id, title), (error: unknown) => error instanceof ApiError && error.status === 400);
  }
  await assert.rejects(updatePhotoTitle(photo.id, another.id, "別の名前"), (error: unknown) => error instanceof ApiError && error.status === 403);
  await assert.rejects(generatePhotoTitles(photo.id, another.id), (error: unknown) => error instanceof ApiError && error.status === 403);
  const updated = await updatePhotoTitle(photo.id, profile.id, "  わたしが見つけた結界  ");
  assert.equal(updated.title, "わたしが見つけた結界");
  assert.deepEqual(updated.evaluation, photo.evaluation);
  assert.deepEqual(updated.titleSuggestions, photo.titleSuggestions);
  assert.deepEqual((await getState()).ranking, ranking);
  assert.equal((await getState()).photos.find(item => item.id === photo.id)?.title, updated.title);
  assert.equal(calls, 0);
});

test("concurrent regeneration shares one title call and preserves edits made in flight", async () => {
  process.env.ODDSHOT_SCORING_MODE = "demo";
  const profile = await createProfile("同時候補生成の検証");
  const photo = await createPhoto({ userId: profile.id, title: "最初のタイトル", image: "", sampleKey: "forest", requestId: "concurrent-title-generation" });
  process.env.ODDSHOT_SCORING_MODE = "decisions";
  process.env.OPENAI_API_KEY = "offline-test-key";
  let calls = 0;
  let release: () => void = () => {};
  const wait = new Promise<void>(resolve => { release = resolve; });
  globalThis.fetch = async () => {
    calls++;
    await wait;
    return titleResponse(["新しい候補", "別の候補", "もう一つの候補"]);
  };
  const first = generatePhotoTitles(photo.id, profile.id);
  const second = generatePhotoTitles(photo.id, profile.id);
  await updatePhotoTitle(photo.id, profile.id, "生成中に編集したタイトル");
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(calls, 1);
  assert.equal(a.title, "生成中に編集したタイトル");
  assert.deepEqual(a, b);
  assert.equal(a.evaluation.id, photo.evaluation.id);
  process.env.ODDSHOT_SCORING_MODE = "demo";
  delete process.env.OPENAI_API_KEY;
});

test("regeneration failure preserves existing title candidates and allows retry", async () => {
  process.env.ODDSHOT_SCORING_MODE = "demo";
  const profile = await createProfile("候補を消さない検証");
  const photo = await createPhoto({ userId: profile.id, title: "", image: "", sampleKey: "forest", requestId: "preserve-existing-titles" });
  process.env.ODDSHOT_SCORING_MODE = "decisions";
  process.env.OPENAI_API_KEY = "offline-test-key";
  globalThis.fetch = async () => Response.json({ error: { message: "offline failure" } }, { status: 429 });
  await assert.rejects(generatePhotoTitles(photo.id, profile.id), (error: unknown) => error instanceof ApiError && error.status === 502);
  assert.deepEqual((await getState()).photos.find(item => item.id === photo.id), photo);
  globalThis.fetch = async () => titleResponse(["再取得したタイトル", "再取得した別案", "再取得した三案目"]);
  const retried = await generatePhotoTitles(photo.id, profile.id);
  assert.equal(retried.title, photo.title);
  assert.equal(retried.titleSuggestions?.source, "ai");
  assert.equal(retried.titleSuggestions?.suggestions[0], "再取得したタイトル");
  process.env.ODDSHOT_SCORING_MODE = "demo";
  delete process.env.OPENAI_API_KEY;
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

async function beforeTimeout<T>(promise: Promise<T>): Promise<T> {
  let timeout: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error("scoring waited for the unresolved title API")), 1000); });
  try { return await Promise.race([promise, deadline]); }
  finally { clearTimeout(timeout!); }
}

test("score-first response persists and deduplicates while the title API is still pending", async () => {
  process.env.ODDSHOT_SCORING_MODE = "decisions";
  process.env.OPENAI_API_KEY = "offline-test-key";
  const profile = await createProfile("採点先着の検証");
  const before = (await getState()).photos.length;
  const titles = deferred<Response>();
  const tasks: Promise<void>[] = [];
  const urls: string[] = [];
  globalThis.fetch = async (url, init) => {
    urls.push(String(url));
    return String(url).endsWith("/decisions") ? scoredResponse(init) : titles.promise;
  };
  const input = { userId: profile.id, title: "", image: "", sampleKey: "forest", requestId: "score-before-slow-title" };
  const options = { scheduleBackground: (work: Promise<void>) => { tasks.push(work); } };
  try {
    const [first, duplicate] = await beforeTimeout(Promise.all([createPhoto(input, options), createPhoto(input, options)]));
    assert.equal(first.id, duplicate.id);
    assert.deepEqual(first.titleSuggestions, { source: "pending", suggestions: [] });
    assert.equal(first.evaluation.rank, "S");
    assert.equal(urls.filter(url => url.endsWith("/decisions")).length, 1);
    assert.equal(urls.filter(url => url.endsWith("/responses")).length, 1, "both APIs start before the score response");
    assert.equal(tasks.length, 1, "the request owns one registered completion task");
    assert.equal((await createPhoto(input, options)).id, first.id);
    assert.equal(urls.length, 2, "a retry with pending suggestions must not call either API again");
    assert.equal((await getState()).photos.length, before + 1);
    assert.equal((await getState()).ranking.find(entry => entry.id === profile.id)?.highCount, 1);
    titles.resolve(titleResponse(["先に見つけた光", "森の記憶", "光の向こう側"]));
    await Promise.all(tasks);
    const updated = await getPhoto(first.id);
    assert.equal(updated.title, "先に見つけた光");
    assert.deepEqual(updated.titleSuggestions, { source: "ai", suggestions: ["先に見つけた光", "森の記憶", "光の向こう側"] });
    assert.deepEqual(updated.evaluation, first.evaluation);
    assert.equal((await createPhoto(input, options)).title, updated.title);
    assert.equal(urls.length, 2);
  } finally {
    titles.resolve(titleResponse(["後から届く案", "別の案", "三つ目の案"]));
    await Promise.allSettled(tasks);
    process.env.ODDSHOT_SCORING_MODE = "demo";
    delete process.env.OPENAI_API_KEY;
  }
});

test("title-first completion is included with the score without another title request", async () => {
  process.env.ODDSHOT_SCORING_MODE = "decisions";
  process.env.OPENAI_API_KEY = "offline-test-key";
  const profile = await createProfile("タイトル先着の検証");
  const score = deferred<Response>();
  const bothStarted = deferred<void>();
  const tasks: Promise<void>[] = [];
  let calls = 0;
  let scoreResponse!: Response;
  globalThis.fetch = async (url, init) => {
    calls++;
    if (calls === 2) bothStarted.resolve();
    if (String(url).endsWith("/decisions")) { scoreResponse = scoredResponse(init); return score.promise; }
    return titleResponse(["星の入口", "夜空の余韻", "宇宙からの気配"]);
  };
  const creating = createPhoto({ userId: profile.id, title: "", image: "", sampleKey: "sky", requestId: "title-before-slow-score" }, { scheduleBackground: work => { tasks.push(work); } });
  try {
    await beforeTimeout(bothStarted.promise);
    await new Promise<void>(resolve => setImmediate(resolve));
    score.resolve(scoreResponse);
    const photo = await beforeTimeout(creating);
    assert.equal(photo.title, "星の入口");
    assert.equal(photo.titleSuggestions?.source, "ai");
    assert.equal(photo.evaluation.rank, "S");
    await Promise.all(tasks);
    assert.equal(calls, 2);
    assert.equal((await getPhoto(photo.id)).title, photo.title);
  } finally {
    score.resolve(scoreResponse);
    await Promise.allSettled([creating, ...tasks]);
    process.env.ODDSHOT_SCORING_MODE = "demo";
    delete process.env.OPENAI_API_KEY;
  }
});

test("a late title failure finishes pending state without losing the successful score", async () => {
  process.env.ODDSHOT_SCORING_MODE = "decisions";
  process.env.OPENAI_API_KEY = "offline-test-key";
  const profile = await createProfile("後追いタイトル失敗の検証");
  const titles = deferred<Response>();
  const tasks: Promise<void>[] = [];
  let calls = 0;
  globalThis.fetch = async (url, init) => {
    calls++;
    return String(url).endsWith("/decisions") ? scoredResponse(init) : titles.promise;
  };
  try {
    const photo = await beforeTimeout(createPhoto({ userId: profile.id, title: "", image: "", sampleKey: "sky", requestId: "score-first-title-fails" }, { scheduleBackground: work => { tasks.push(work); } }));
    assert.equal(photo.titleSuggestions?.source, "pending");
    titles.resolve(Response.json({ error: { message: "offline title failure" } }, { status: 429 }));
    await Promise.all(tasks);
    const updated = await getPhoto(photo.id);
    assert.deepEqual(updated.titleSuggestions, { source: "unavailable", suggestions: [] });
    assert.equal(updated.title, photo.title);
    assert.deepEqual(updated.evaluation, photo.evaluation);
    assert.equal((await getState()).ranking.find(entry => entry.id === profile.id)?.highCount, 1);
    assert.equal(calls, 2);
  } finally {
    titles.resolve(Response.json({}, { status: 429 }));
    await Promise.allSettled(tasks);
    process.env.ODDSHOT_SCORING_MODE = "demo";
    delete process.env.OPENAI_API_KEY;
  }
});

test("late automatic suggestions preserve explicit title edits including the original placeholder", async () => {
  process.env.ODDSHOT_SCORING_MODE = "decisions";
  process.env.OPENAI_API_KEY = "offline-test-key";
  const profile = await createProfile("後追い手編集の検証");
  try {
    for (const [index, manualTitle] of ["手入力した光の記録", "名前のない一枚"].entries()) {
      const titles = deferred<Response>();
      const tasks: Promise<void>[] = [];
      let calls = 0;
      globalThis.fetch = async (url, init) => {
        calls++;
        return String(url).endsWith("/decisions") ? scoredResponse(init) : titles.promise;
      };
      try {
        const photo = await beforeTimeout(createPhoto({ userId: profile.id, title: "", image: "", sampleKey: "forest", requestId: "late-manual-title-" + index }, { scheduleBackground: work => { tasks.push(work); } }));
        await updatePhotoTitle(photo.id, profile.id, manualTitle);
        titles.resolve(titleResponse(["自動で届いた候補", "二つ目の光", "三つ目の気配"]));
        await Promise.all(tasks);
        const updated = await getPhoto(photo.id);
        assert.equal(updated.title, manualTitle);
        assert.deepEqual(updated.titleSuggestions, { source: "ai", suggestions: ["自動で届いた候補", "二つ目の光", "三つ目の気配"] });
        assert.deepEqual(updated.evaluation, photo.evaluation);
        assert.equal(calls, 2);
      } finally {
        titles.resolve(Response.json({}, { status: 429 }));
        await Promise.allSettled(tasks);
      }
    }
  } finally {
    process.env.ODDSHOT_SCORING_MODE = "demo";
    delete process.env.OPENAI_API_KEY;
  }
});

test("score failure never saves a pending photo or schedules a late title write", async () => {
  process.env.ODDSHOT_SCORING_MODE = "decisions";
  process.env.OPENAI_API_KEY = "offline-test-key";
  const profile = await createProfile("採点失敗の後追い検証");
  const before = (await getState()).photos.length;
  const titles = deferred<Response>();
  const tasks: Promise<void>[] = [];
  globalThis.fetch = async url => String(url).endsWith("/decisions") ? Response.json({}, { status: 503 }) : titles.promise;
  try {
    await assert.rejects(beforeTimeout(createPhoto({ userId: profile.id, title: "", image: "", sampleKey: "forest", requestId: "failed-score-no-background" }, { scheduleBackground: work => { tasks.push(work); } })));
    titles.resolve(titleResponse(["保存されない候補", "保存されない別案", "保存されない三案目"]));
    await Promise.all(tasks);
    assert.equal(tasks.length, 0);
    assert.equal((await getState()).photos.length, before);
  } finally {
    titles.resolve(Response.json({}, { status: 429 }));
    await Promise.allSettled(tasks);
    process.env.ODDSHOT_SCORING_MODE = "demo";
    delete process.env.OPENAI_API_KEY;
  }
});

test("an abandoned title task can be retried without allowing its late result to overwrite the retry", async () => {
  process.env.ODDSHOT_SCORING_MODE = "decisions";
  process.env.OPENAI_API_KEY = "offline-test-key";
  const profile = await createProfile("候補待機からの復旧検証");
  const abandoned = deferred<Response>();
  const tasks: Promise<void>[] = [];
  let titleCalls = 0;
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith("/decisions")) return scoredResponse(init);
    titleCalls++;
    return titleCalls === 1 ? abandoned.promise : titleResponse(["再取得で届いた候補", "再取得の光", "再取得の森"]);
  };
  try {
    const photo = await beforeTimeout(createPhoto({ userId: profile.id, title: "", image: "", sampleKey: "forest", requestId: "abandoned-title-task-retry" }, { scheduleBackground: work => { tasks.push(work); } }));
    await updatePhotoTitle(photo.id, profile.id, "候補を待ちながら付けた名前");
    const database = (globalThis as { oddshotDatabase?: DatabaseSync }).oddshotDatabase!;
    database.prepare("UPDATE photos SET created_at = ? WHERE id = ?").run(new Date(Date.now() - 120_001).toISOString(), photo.id);
    assert.equal((await getPhoto(photo.id)).titleSuggestions?.source, "unavailable");
    assert.equal((await getState()).photos.find(item => item.id === photo.id)?.titleSuggestions?.source, "unavailable");
    const stored = database.prepare("SELECT title_suggestions_json FROM photos WHERE id = ?").get(photo.id) as { title_suggestions_json: string };
    assert.equal(JSON.parse(stored.title_suggestions_json).source, "pending", "GET does not mutate the stored task");
    const retried = await beforeTimeout(generatePhotoTitles(photo.id, profile.id));
    assert.equal(retried.title, "候補を待ちながら付けた名前");
    assert.equal(retried.titleSuggestions?.suggestions[0], "再取得で届いた候補");
    abandoned.resolve(titleResponse(["古い処理から遅れて届いた案", "古い別案", "古い三案目"]));
    await Promise.all(tasks);
    const final = await getPhoto(photo.id);
    assert.equal(final.title, retried.title);
    assert.deepEqual(final.titleSuggestions, retried.titleSuggestions);
    assert.deepEqual(final.evaluation, photo.evaluation);
    assert.equal(titleCalls, 2);
  } finally {
    abandoned.resolve(Response.json({}, { status: 429 }));
    await Promise.allSettled(tasks);
    process.env.ODDSHOT_SCORING_MODE = "demo";
    delete process.env.OPENAI_API_KEY;
  }
});
