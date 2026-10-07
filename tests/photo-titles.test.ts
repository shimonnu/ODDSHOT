import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { buildPhotoTitleRequest, parsePhotoTitleSuggestions, suggestPhotoTitles } from "../lib/photo-titles";

const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
const titles = ["光が残した森の秘密", "静かな霧の向こう側", "木々の間に浮かぶ気配"];
const originalFetch = globalThis.fetch;
const originalMode = process.env.ODDSHOT_SCORING_MODE;
const originalKey = process.env.OPENAI_API_KEY;
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalMode === undefined) delete process.env.ODDSHOT_SCORING_MODE; else process.env.ODDSHOT_SCORING_MODE = originalMode;
  if (originalKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = originalKey;
});
function payload(candidates: unknown = titles) {
  return { status: "completed", output: [
    { type: "reasoning", summary: [] },
    { type: "message", role: "assistant", content: [{ type: "output_text", text: JSON.stringify({ titles: candidates }) }] },
  ] };
}

test("title request uses the photo, a strict three-title schema and no server-side conversation storage", () => {
  const body = buildPhotoTitleRequest(bytes, "image/jpeg");
  assert.equal(body.model, "gpt-6-luna");
  assert.equal(body.store, false);
  assert.equal(body.reasoning.effort, "none");
  assert.equal(body.input[0].content[1].image_url, `data:image/jpeg;base64,${bytes.toString("base64")}`);
  assert.equal(body.text.format.strict, true);
  assert.equal(body.text.format.schema.properties.titles.minItems, 3);
  assert.match(body.instructions, /画像内の文字/);
  assert.throws(() => buildPhotoTitleRequest(Buffer.alloc(0), "image/jpeg"));
  assert.throws(() => buildPhotoTitleRequest(bytes, "text/html"));
});

test("title parser finds assistant text after reasoning and rejects refusal, truncation and unusable candidates", () => {
  assert.deepEqual(parsePhotoTitleSuggestions(payload()), titles);
  assert.throws(() => parsePhotoTitleSuggestions({ ...payload(), status: "incomplete" }));
  assert.throws(() => parsePhotoTitleSuggestions({ status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "refusal", refusal: "refused" }] }] }));
  for (const invalid of [["一枚", "一枚", "二枚"], ["", "二枚", "三枚"], ["長".repeat(29), "二枚", "三枚"], ["改\n行", "二枚", "三枚"], ["二枚", "三枚"]]) {
    assert.throws(() => parsePhotoTitleSuggestions(payload(invalid)));
  }
});

test("demo suggestions never send photographs externally and distinguish known samples", async () => {
  process.env.ODDSHOT_SCORING_MODE = "demo";
  process.env.OPENAI_API_KEY = "offline-test-key";
  globalThis.fetch = async () => { throw new Error("Demo must not call the network"); };
  const sample = await suggestPhotoTitles(bytes, "image/jpeg", "sky");
  assert.equal(sample.source, "demo");
  assert.match(sample.suggestions[0], /宇宙/);
  assert.equal((await suggestPhotoTitles(bytes, "image/jpeg")).source, "demo");
  assert.equal((await suggestPhotoTitles(bytes, "image/jpeg", "__proto__")).suggestions.length, 3);
});

test("live title generation uses the same OpenAI key and returns validated AI suggestions", async () => {
  process.env.ODDSHOT_SCORING_MODE = "decisions";
  process.env.OPENAI_API_KEY = "offline-test-key";
  let calls = 0;
  globalThis.fetch = async (url, init) => {
    calls++;
    assert.equal(url, "https://api.openai.com/v1/responses");
    assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer offline-test-key");
    assert.equal(init?.cache, "no-store");
    assert.ok(init?.signal);
    assert.equal(JSON.parse(String(init?.body)).input[0].content[1].type, "input_image");
    return Response.json(payload());
  };
  assert.deepEqual(await suggestPhotoTitles(bytes, "image/jpeg"), { suggestions: titles, source: "ai" });
  assert.equal(calls, 1);
});

test("missing credentials, HTTP errors, timeout and invalid output never pretend to be successful AI suggestions", async () => {
  process.env.ODDSHOT_SCORING_MODE = "decisions";
  delete process.env.OPENAI_API_KEY;
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error("must not be called"); };
  assert.deepEqual(await suggestPhotoTitles(bytes, "image/jpeg"), { suggestions: [], source: "unavailable" });
  assert.equal(calls, 0);
  process.env.OPENAI_API_KEY = "offline-test-key";
  for (const status of [401, 429, 500]) {
    globalThis.fetch = async () => Response.json({ error: "offline upstream failure" }, { status });
    assert.equal((await suggestPhotoTitles(bytes, "image/jpeg")).source, "unavailable");
  }
  globalThis.fetch = async () => { throw new DOMException("offline timeout", "TimeoutError"); };
  assert.equal((await suggestPhotoTitles(bytes, "image/jpeg")).source, "unavailable");
  globalThis.fetch = async () => Response.json(payload(["only one"]));
  assert.equal((await suggestPhotoTitles(bytes, "image/jpeg")).source, "unavailable");
});
