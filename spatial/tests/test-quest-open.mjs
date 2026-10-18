import assert from "node:assert/strict";
import test from "node:test";
import { captureToken, openQuest } from "../../scripts/quest-open.mjs";

const token = "a".repeat(64);
function fakeAdb(listing, models = { QUEST_A: "Meta Quest 3S" }, overrides = {}) {
  const calls = [];
  const run = (args) => {
    calls.push([...args]);
    if (args[0] === "devices") return { status: 0, stdout: `List of devices attached\n${listing}\n`, stderr: "" };
    if (args.includes("getprop")) return { status: 0, stdout: models[args[1]] ?? "Pixel 9", stderr: "" };
    if (args.includes("reverse")) return overrides.reverse ?? { status: 0, stdout: "3017", stderr: "" };
    if (args.includes("start")) return overrides.start ?? { status: 0, stdout: `Starting: Intent { dat=http://localhost:3017/rooms#local-scan=${token} }`, stderr: "" };
    throw new Error("Unexpected ADB command");
  };
  return { calls, run };
}
function run(fake, extra = {}) {
  const result = openQuest({ env: { TADAIMA_LOCAL_CAPTURE_TOKEN: token }, runAdb: fake.run, ...extra });
  assert.ok(!JSON.stringify(result).includes(token), "never expose a private scan token");
  return result;
}

test("token reads only its literal assignment, respects environment precedence, and does not execute content", () => {
  assert.equal(captureToken({}, `API_SECRET=never-print\nexport TADAIMA_LOCAL_CAPTURE_TOKEN="${token}" # test`), token);
  assert.equal(captureToken({}, `TADAIMA_LOCAL_CAPTURE_TOKEN='${token}'`), token);
  assert.equal(captureToken({}, `TADAIMA_LOCAL_CAPTURE_TOKEN=${token} # test`), token);
  assert.equal(captureToken({ TADAIMA_LOCAL_CAPTURE_TOKEN: "env-wins" }, `TADAIMA_LOCAL_CAPTURE_TOKEN=${token}`), "env-wins");
  assert.equal(captureToken({}, "UNRELATED=value"), undefined);
  const result = openQuest({ env: {}, readEnvFile: () => "TADAIMA_LOCAL_CAPTURE_TOKEN=$(touch dangerous)", runAdb: () => assert.fail("must not call ADB") });
  assert.equal(result.ok, false); assert.match(result.message, /64 lowercase hexadecimal/);
});

test("missing or malformed tokens fail without calling ADB or printing environment secrets", () => {
  for (const value of [undefined, "", "x".repeat(64), "A".repeat(64), `${token}\n`, "short"]) {
    let adbCalls = 0;
    const result = openQuest({ env: value === undefined ? { PRIVATE_KEY: "do-not-print" } : { TADAIMA_LOCAL_CAPTURE_TOKEN: value },
      readEnvFile: () => { throw new Error("missing file"); }, runAdb: () => { adbCalls++; return { status: 1 }; } });
    assert.equal(adbCalls, 0); assert.equal(result.ok, false); assert.ok(!result.message.includes("do-not-print"));
  }
});

test("no headset, unauthorized and offline devices produce actionable cable and permission guidance", () => {
  assert.match(run(fakeAdb("")).message, /USB data cable/);
  assert.match(run(fakeAdb("QUEST_A unauthorized")).message, /Allow USB debugging/);
  assert.match(run(fakeAdb("QUEST_A offline")).message, /offline/);
});

test("non-Quest Android devices are not opened", () => {
  const fake = fakeAdb("PHONE device", { PHONE: "Pixel 9" });
  assert.equal(run(fake).ok, false);
  assert.ok(!fake.calls.some((args) => args.includes("reverse") || args.includes("start")));
});

test("one authorized Quest is verified, forwarded and opened without exposing ADB's echoed token", () => {
  const fake = fakeAdb("PHONE device\nQUEST_A device", { PHONE: "Pixel 9", QUEST_A: "Quest 3S" });
  const result = run(fake);
  assert.equal(result.ok, true);
  assert.deepEqual(fake.calls.at(-2), ["-s", "QUEST_A", "reverse", "tcp:3017", "tcp:3017"]);
  assert.deepEqual(fake.calls.at(-1), ["-s", "QUEST_A", "shell", "am", "start", "-a", "android.intent.action.VIEW", "-d", `http://localhost:3017/rooms#local-scan=${token}`]);
});

test("duplicate device listing rows count as one Quest", () => {
  const fake = fakeAdb("QUEST_A device\nQUEST_A device");
  assert.equal(run(fake).ok, true);
  assert.equal(fake.calls.filter((args) => args.includes("getprop")).length, 1);
});

test("multiple headsets require a deterministic serial, which is itself verified as Quest", () => {
  const fake = fakeAdb("QUEST_A device\nQUEST_B device\nPHONE device", { QUEST_A: "Quest 3S", QUEST_B: "Oculus Quest 2", PHONE: "Pixel" });
  const ambiguous = run(fake);
  assert.equal(ambiguous.ok, false); assert.match(ambiguous.message, /--serial/);
  assert.ok(!fake.calls.some((args) => args.includes("reverse")));
  assert.equal(run(fake, { argv: ["--serial", "QUEST_B"] }).ok, true);
  assert.equal(fake.calls.at(-1)[1], "QUEST_B");
  assert.equal(run(fake, { argv: ["--serial", "PHONE"] }).ok, false);
  assert.equal(run(fake, { argv: ["--serial", "MISSING"] }).ok, false);
  assert.match(run(fakeAdb("QUEST_A unauthorized"), { argv: ["--serial", "QUEST_A"] }).message, /unauthorized/);
});

test("configuration file fallback works without loading unrelated assignments", () => {
  const fake = fakeAdb("QUEST_A device");
  const result = run(fake, { env: {}, readEnvFile: () => `STRIPE_KEY=never-print\nTADAIMA_LOCAL_CAPTURE_TOKEN=${token}\n` });
  assert.equal(result.ok, true); assert.ok(!result.message.includes("never-print"));
});

test("ADB failures and echoed intent errors are captured without leaking the private URL", () => {
  const missing = openQuest({ env: { TADAIMA_LOCAL_CAPTURE_TOKEN: token }, runAdb: () => { throw new Error(token); } });
  assert.equal(missing.ok, false); assert.ok(!missing.message.includes(token)); assert.match(missing.message, /Platform Tools/);
  const reverse = fakeAdb("QUEST_A device", undefined, { reverse: { status: 1, stderr: token } });
  assert.match(run(reverse).message, /forward port/);
  assert.ok(!reverse.calls.some((args) => args.includes("start")));
  const badStart = fakeAdb("QUEST_A device", undefined, { start: { status: 0, stdout: `Starting intent ${token}\nError: Activity not started` } });
  assert.match(run(badStart).message, /Could not open/);
});

test("argument parsing rejects unsupported options without reflecting their values", () => {
  for (const argv of [["--url", token], ["--serial"], ["--serial", "bad serial"], ["--serial", "Q", "extra"]]) {
    const result = openQuest({ argv, env: {}, runAdb: () => assert.fail("must not call ADB") });
    assert.equal(result.ok, false); assert.match(result.message, /Usage:/); assert.ok(!result.message.includes(token));
  }
});
