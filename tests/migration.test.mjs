import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, writeFileSync, mkdtempSync, rmSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const schema = readFileSync(path.join(root, "cloudflare/migrations/0001_initial.sql"), "utf8");

test("migration preserves binary/JSON, resumes without duplicates, and rejects differing existing data", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "oddshot-migration-"));
  const sourcePath = path.join(directory, "source.sqlite");
  const targetPath = path.join(directory, "target.sqlite");
  const image = Buffer.alloc(643_558, 42);
  const evaluationJson = JSON.stringify({ score: 91, rank: "S", explanation: "光の向こうに、静かな気配。", nested: { original: [1, 2, 3] } });
  const criteriaJson = JSON.stringify({ version: "test-v1", description: "画像の雰囲気を評価\n二行目" });
  const suggestionsJson = JSON.stringify({ candidates: ["星の向こう", "夜空の記憶", "光の輪"], status: "available" });
  try {
    const source = new DatabaseSync(sourcePath);
    source.exec(schema);
    source.prepare("INSERT INTO profiles VALUES (?,?,?,?,?)").run("person", "ミオ", "ミオ", "#purple", "2026-10-08T00:00:00Z");
    source.prepare("INSERT INTO scoring_criteria VALUES (?,?,?,?,?)").run("criteria", "test-v1", criteriaJson, "2026-10-08T00:00:00Z", 1);
    source.prepare("INSERT INTO photos VALUES (?,?,?,?,?,?,?,?,?,?,?,?)").run("photo", "person", "星空", image, "image/jpeg", null, "2026-10-08T00:00:00Z", "pending", null, "request", "fingerprint", suggestionsJson);
    source.prepare("INSERT INTO evaluations VALUES (?,?,?,?,?)").run("evaluation", "photo", evaluationJson, "2026-10-08T00:00:00Z", "test-v1");
    source.close();
    const target = new DatabaseSync(targetPath);
    target.exec(schema);
    target.close();

    // Intercept every fetch in the child process: no request can reach a real cloud service.
    const harnessPath = path.join(directory, "mock-fetch.mjs");
    writeFileSync(harnessPath, `
import { DatabaseSync } from "node:sqlite";
import { timingSafeEqual } from "node:crypto";
import worker from ${JSON.stringify(pathToFileURL(path.join(root, "cloudflare/worker.mjs")).href)};
Object.defineProperty(crypto.subtle, "timingSafeEqual", {value:(a,b)=>timingSafeEqual(Buffer.from(a),Buffer.from(b)),configurable:true});
const database = new DatabaseSync(${JSON.stringify(targetPath)});
database.exec("PRAGMA foreign_keys=ON");
const DB={
 prepare(sql){return {bind(...params){return {sql,params};},async first(){return database.prepare(sql).get();}};},
 async batch(statements){
  database.exec("BEGIN");
  try {
   const result=statements.map(({sql,params})=>{
    const args=params.map(x=>x instanceof ArrayBuffer?Buffer.from(x):x);
    const results=database.prepare(sql).all(...args);
    return {success:true,results,meta:{changes:/^(INSERT|UPDATE)/i.test(sql)?database.prepare("SELECT changes() AS count").get().count:0}};
   });
   database.exec("COMMIT");return result;
  }catch(error){database.exec("ROLLBACK");throw error;}
 }
};
globalThis.fetch=async (url,options)=>{
 if(!String(url).startsWith("https://migration.test/"))throw new Error("External requests prohibited");
 return worker.fetch(new Request(url,options),{DB,ODDSHOT_D1_WORKER_TOKEN:"migration-test-token"});
};
`);
    function run(copy) {
      return spawnSync(process.execPath, ["--import", harnessPath, path.join(root, "scripts/migrate-cloudflare.mjs"), ...(copy ? ["--copy"] : [])], {
        cwd: root, encoding: "utf8", timeout: 30_000,
        env: { ...process.env, OPENAI_API_KEY: "", ODDSHOT_D1_WORKER_URL: "https://migration.test", ODDSHOT_D1_WORKER_TOKEN: "migration-test-token", ODDSHOT_MIGRATION_SOURCE: sourcePath, ODDSHOT_MIGRATION_BACKUP_DIR: path.join(directory, "backups") },
      });
    }
    const first = run(true);
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, /"insertedRows":4/);
    assert.match(first.stdout, /"imageHashes":"matched"/);
    assert.equal(readdirSync(path.join(directory, "backups")).length, 1);
    const repeated = run(true);
    assert.equal(repeated.status, 0, repeated.stderr);
    assert.match(repeated.stdout, /"insertedRows":0/);
    const verified = run(false);
    assert.equal(verified.status, 0, verified.stderr);
    const stored = new DatabaseSync(targetPath);
    const photo = stored.prepare("SELECT * FROM photos").get();
    assert.ok(Buffer.from(photo.image_bytes).equals(image));
    assert.equal(photo.title_suggestions_json, suggestionsJson);
    assert.equal(stored.prepare("SELECT evaluation_json FROM evaluations").get().evaluation_json, evaluationJson);
    assert.equal(stored.prepare("SELECT criteria_json FROM scoring_criteria").get().criteria_json, criteriaJson);
    stored.prepare("UPDATE photos SET title=? WHERE id='photo'").run("別のタイトル");
    stored.close();
    const rejected = run(true);
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, /同じ ID の内容が一致しない/);
    const unchanged = new DatabaseSync(targetPath, {readOnly:true});
    assert.equal(unchanged.prepare("SELECT title FROM photos").get().title, "別のタイトル");
    assert.equal(unchanged.prepare("SELECT COUNT(*) AS count FROM photos").get().count, 1);
    unchanged.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
