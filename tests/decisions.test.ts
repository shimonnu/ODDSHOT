import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDecisionsRequest, DecisionsError, getScoringConfig, parseDecisionsEvaluation, scoreImage } from "../lib/decisions";
import { decisionsScoringCriteria, type ScoringCriteria } from "../lib/demo";

const criteria = decisionsScoringCriteria;

function scoreAnswer(axis: ScoringCriteria["axes"][number], score: number) {
  const floor = Math.floor(score);
  return {
    name: axis.key, type: "score", score, confidence: 0.7,
    probabilities: axis.levels!.map((level, value) => ({
      label: level.label, value,
      probability: value === floor ? 1 - (score - floor) : value === floor + 1 ? score - floor : 0,
    })),
  };
}

function response(scores = [2.49, 2.49, 2.49, 2.49]) {
  return {
    model: "gpt-6-luna",
    answers: [
      ...criteria.axes.map((axis, index) => scoreAnswer(axis, scores[index])),
      ...criteria.predicates!.map((predicate, index) => ({ name: predicate.name, type: "predicate", probability: index === 0 ? 0.9 : 0.1 })),
    ] as Record<string, unknown>[],
    usage: { input_tokens: 100, output_tokens: 0, total_tokens: 100 },
  };
}

function assertError(action: () => unknown, code: DecisionsError["code"], status?: number) {
  assert.throws(action, (error: unknown) => error instanceof DecisionsError && error.code === code && (status === undefined || error.status === status));
}

test("one image request uses four ordered score questions and finite predicates", () => {
  const bytes = Buffer.from("test-image");
  const request = buildDecisionsRequest(bytes, "image/jpeg", criteria);
  assert.equal(request.model, "gpt-6-luna");
  assert.equal(request.input[0].role, "user");
  assert.equal(request.input[0].content[1].type, "input_image");
  assert.equal((request.input[0].content[1] as { image_url: string }).image_url, `data:image/jpeg;base64,${bytes.toString("base64")}`);
  assert.equal(request.questions.filter((question) => question.type === "score").length, 4);
  for (const question of request.questions.filter((question) => question.type === "score")) assert.equal(question.levels.length, 5);
  assert.equal(request.questions.length, 4 + criteria.predicates!.length);
});

test("level-index scores map to 25 points each and total is rounded only once", () => {
  const evaluation = parseDecisionsEvaluation(response(), criteria, "2026-10-07T00:00:00.000Z");
  assert.equal(evaluation.score, 62);
  assert.equal(evaluation.rank, "B");
  assert.equal(evaluation.axes.atmosphere, 15.56);
  assert.equal(evaluation.ai?.rawScores.atmosphere.score, 2.49);
  assert.deepEqual(evaluation.tags, ["霧の気配"]);
  assert.equal(evaluation.isDemo, false);
  assert.equal(evaluation.criteriaVersion, "decisions-v1");
  assert.deepEqual(evaluation.ai?.usage, { inputTokens: 100, outputTokens: 0, totalTokens: 100 });
});

test("rank boundaries use the displayed rounded total", () => {
  const thresholds = [[0, "F"], [39, "F"], [40, "C"], [59, "C"], [60, "B"], [74, "B"], [75, "A"], [89, "A"], [90, "S"], [100, "S"]] as const;
  for (const [score, rank] of thresholds) {
    const evaluation = parseDecisionsEvaluation(response(Array(4).fill(score / 25)), criteria);
    assert.equal(evaluation.score, score);
    assert.equal(evaluation.rank, rank);
  }
  assert.equal(parseDecisionsEvaluation(response(Array(4).fill(59.51 / 25)), criteria).rank, "B");
});

test("axis explanations do not invent fog or another unconfirmed visual feature", () => {
  const payload = response([4, 1, 1, 1]);
  for (const answer of payload.answers) if (answer.type === "predicate") answer.probability = 0;
  const evaluation = parseDecisionsEvaluation(payload, criteria);
  assert.match(evaluation.reason, /神秘的な雰囲気/);
  assert.doesNotMatch(evaluation.reason, /霧|円盤|光の輪|三角形/);
  assert.ok(!evaluation.tags.includes("霧の気配"));
});

test("answer order and probability order are matched using names and level indices", () => {
  const payload = response();
  payload.answers.reverse();
  for (const answer of payload.answers) if (Array.isArray(answer.probabilities)) answer.probabilities.reverse();
  assert.equal(parseDecisionsEvaluation(payload, criteria).score, 62);
});

test("missing and duplicate axes and unexpected names fail rather than awarding a rank", () => {
  const missing = response(); missing.answers.pop();
  assertError(() => parseDecisionsEvaluation(missing, criteria), "invalid_response");
  const duplicate = response(); duplicate.answers[1] = duplicate.answers[0];
  assertError(() => parseDecisionsEvaluation(duplicate, criteria), "invalid_response");
  const unknown = response(); unknown.answers[0].name = "unknown";
  assertError(() => parseDecisionsEvaluation(unknown, criteria), "invalid_response");
});

test("refusals are 判定不可 and never become an F result", () => {
  const payload = response(); payload.answers[0] = { name: "atmosphere", type: "refusal" };
  assertError(() => parseDecisionsEvaluation(payload, criteria), "refusal", 422);
  const predicateRefusal = response(); predicateRefusal.answers[4] = { name: criteria.predicates![0].name, type: "refusal" };
  assertError(() => parseDecisionsEvaluation(predicateRefusal, criteria), "refusal", 422);
});

test("non-finite and out-of-range scores, invalid confidence, and predicates are rejected", () => {
  for (const score of [-0.1, 4.1, NaN, Infinity, "2"] as unknown[]) {
    const payload = response(); payload.answers[0].score = score;
    assertError(() => parseDecisionsEvaluation(payload, criteria), "invalid_response");
  }
  for (const confidence of [-0.1, 1.1, NaN]) {
    const payload = response(); payload.answers[0].confidence = confidence;
    assertError(() => parseDecisionsEvaluation(payload, criteria), "invalid_response");
  }
  const predicate = response(); predicate.answers[4].probability = 1.1;
  assertError(() => parseDecisionsEvaluation(predicate, criteria), "invalid_response");
});

test("probabilities must have distinct valid levels, sum to one, and explain the score", () => {
  for (const mutate of [
    (items: Record<string, unknown>[]) => { items[0].probability = 0.5; },
    (items: Record<string, unknown>[]) => { items[0].value = 9; },
    (items: Record<string, unknown>[]) => { items[0].label = "unknown"; },
    (items: Record<string, unknown>[]) => { items[1].value = 0; },
    (items: Record<string, unknown>[]) => { items[0].probability = NaN; },
  ]) {
    const payload = response(); mutate(payload.answers[0].probabilities as Record<string, unknown>[]);
    assertError(() => parseDecisionsEvaluation(payload, criteria), "invalid_response");
  }
  const mismatch = response(); mismatch.answers[0].score = 3;
  assertError(() => parseDecisionsEvaluation(mismatch, criteria), "invalid_response");
});

test("invalid persisted criteria and unsupported image types fail before a request", () => {
  assertError(() => buildDecisionsRequest(Buffer.from("x"), "image/heic", criteria), "image", 422);
  assertError(() => buildDecisionsRequest(Buffer.alloc(0), "image/jpeg", criteria), "image", 422);
  assertError(() => buildDecisionsRequest(Buffer.alloc(1.5 * 1024 * 1024 + 1), "image/jpeg", criteria), "image", 422);
  const bad = structuredClone(criteria); bad.axes[0].maxPoints = 100;
  assertError(() => buildDecisionsRequest(Buffer.from("x"), "image/jpeg", bad), "configuration", 503);
});

test("mode is explicit, live configuration exposes no secret, and errors never fall back to demo", async () => {
  const savedMode = process.env.ODDSHOT_SCORING_MODE;
  const savedKey = process.env.OPENAI_API_KEY;
  const savedFetch = globalThis.fetch;
  try {
    delete process.env.ODDSHOT_SCORING_MODE;
    process.env.OPENAI_API_KEY = "test-key-not-a-real-secret";
    assert.deepEqual(getScoringConfig(), { mode: "demo", provider: "OpenAI Decisions API", model: "gpt-6-luna", ready: true });
    process.env.ODDSHOT_SCORING_MODE = "invalid";
    assert.equal(getScoringConfig().ready, false);
    await assert.rejects(scoreImage(Buffer.from("x"), "image/jpeg", criteria), (error: unknown) => error instanceof DecisionsError && error.code === "configuration");
    process.env.ODDSHOT_SCORING_MODE = "decisions";
    delete process.env.OPENAI_API_KEY;
    assert.equal(getScoringConfig().ready, false);
    await assert.rejects(scoreImage(Buffer.from("x"), "image/jpeg", criteria), (error: unknown) => error instanceof DecisionsError && error.status === 503);
    process.env.OPENAI_API_KEY = "test-key-not-a-real-secret";
    let calls = 0;
    globalThis.fetch = async (url, init) => {
      calls++;
      assert.equal(url, "https://api.openai.com/v1/decisions");
      assert.equal(init?.cache, "no-store");
      assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer test-key-not-a-real-secret");
      return Response.json(response());
    };
    assert.equal((await scoreImage(Buffer.from("x"), "image/jpeg", criteria)).isDemo, false);
    assert.equal(calls, 1);
    for (const [status, expected] of [[429, 429], [401, 503], [403, 503], [404, 503], [500, 502]] as const) {
      globalThis.fetch = async () => new Response("private upstream detail", { status });
      await assert.rejects(scoreImage(Buffer.from("x"), "image/jpeg", criteria), (error: unknown) => error instanceof DecisionsError && error.status === expected && !error.message.includes("private"));
    }
    globalThis.fetch = async () => { throw new DOMException("timed out", "TimeoutError"); };
    await assert.rejects(scoreImage(Buffer.from("x"), "image/jpeg", criteria), (error: unknown) => error instanceof DecisionsError && error.status === 504);
    globalThis.fetch = async () => { throw new Error("secret upstream network info"); };
    await assert.rejects(scoreImage(Buffer.from("x"), "image/jpeg", criteria), (error: unknown) => error instanceof DecisionsError && error.status === 502 && !error.message.includes("secret"));
    globalThis.fetch = async () => new Response("not JSON");
    await assert.rejects(scoreImage(Buffer.from("x"), "image/jpeg", criteria), (error: unknown) => error instanceof DecisionsError && error.code === "invalid_response");
    globalThis.fetch = async () => {
      const result = Response.json(response());
      result.json = async () => { throw new DOMException("body timed out", "AbortError"); };
      return result;
    };
    await assert.rejects(scoreImage(Buffer.from("x"), "image/jpeg", criteria), (error: unknown) => error instanceof DecisionsError && error.status === 504);
  } finally {
    if (savedMode === undefined) delete process.env.ODDSHOT_SCORING_MODE; else process.env.ODDSHOT_SCORING_MODE = savedMode;
    if (savedKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = savedKey;
    globalThis.fetch = savedFetch;
  }
});
