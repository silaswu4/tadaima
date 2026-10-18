import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** Parse one literal assignment; never execute or load the rest of the environment file. */
export function captureToken(env, contents) {
  if (env.TADAIMA_LOCAL_CAPTURE_TOKEN !== undefined) return env.TADAIMA_LOCAL_CAPTURE_TOKEN;
  const line = contents.split(/\r?\n/).find((value) => /^\s*(?:export\s+)?TADAIMA_LOCAL_CAPTURE_TOKEN\s*=/.test(value));
  const value = line?.replace(/^\s*(?:export\s+)?TADAIMA_LOCAL_CAPTURE_TOKEN\s*=\s*/, "").trim();
  if (!value) return undefined;
  const quoted = value.match(/^(["'])(.*?)\1\s*(?:#.*)?$/);
  return quoted ? quoted[2] : value.replace(/\s+#.*$/, "").trim();
}

const defaultAdb = (args) => spawnSync("adb", args, { encoding: "utf8", timeout: 10000, maxBuffer: 1024 * 1024 });

/** Injectable so device selection, failure handling and secret redaction can be tested without hardware. */
export function openQuest({ argv = [], env = process.env,
  readEnvFile = () => readFileSync(resolve(".env.local"), "utf8"), runAdb = defaultAdb } = {}) {
  const fail = (message) => ({ ok: false, message });
  let serial;
  if (argv.length) {
    if (argv.length !== 2 || argv[0] !== "--serial" || !/^[A-Za-z0-9_.:-]+$/.test(argv[1])) {
      return fail("Usage: npm run quest:open [-- --serial <Quest serial>]");
    }
    serial = argv[1];
  }
  let contents = "";
  if (env.TADAIMA_LOCAL_CAPTURE_TOKEN === undefined) {
    try { contents = readEnvFile(); } catch { /* Missing file is reported as missing configuration below. */ }
  }
  const token = captureToken(env, contents);
  if (!token) return fail("Configure TADAIMA_LOCAL_CAPTURE_TOKEN in this shell or .env.local, using the same token as the local preview server.");
  if (token.length !== 64 || !/^[a-f0-9]+$/.test(token)) return fail("TADAIMA_LOCAL_CAPTURE_TOKEN must be exactly 64 lowercase hexadecimal characters. Its value has not been printed.");
  // ADB may echo the full intent URL, including the secret. Never forward its
  // raw stdout/stderr or thrown errors to the terminal, on success or failure.
  const adb = (args) => {
    try { return runAdb(args); }
    catch { return { status: null, error: true, stdout: "", stderr: "" }; }
  };
  const listing = adb(["devices", "-l"]);
  if (listing.error || listing.status !== 0) return fail("ADB is unavailable. Install Android Platform Tools, then connect the Quest with a USB data cable and retry.");
  const devices = new Map();
  for (const line of (listing.stdout ?? "").split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z0-9_.:-]+)\s+(device|unauthorized|offline)(?:\s|$)/);
    if (match) devices.set(match[1], match[2]);
  }
  const selectedStatus = serial ? devices.get(serial) : undefined;
  if (serial && selectedStatus !== "device") {
    return fail(selectedStatus === "unauthorized"
      ? "The selected headset is unauthorized. Put it on, unlock it, and accept Allow USB debugging."
      : "The selected headset is not available. Power it on, reconnect a USB data cable, and check adb devices -l.");
  }
  const candidates = serial ? [serial] : [...devices].filter(([, status]) => status === "device").map(([id]) => id);
  const quests = [];
  for (const id of candidates) {
    const model = adb(["-s", id, "shell", "getprop", "ro.product.model"]);
    if (!model.error && model.status === 0 && /\b(?:Quest|Meta|Oculus)\b/i.test(model.stdout ?? "")) quests.push(id);
  }
  if (!quests.length) {
    if ([...devices.values()].includes("unauthorized")) return fail("A connected device is unauthorized. Put on the Quest and accept Allow USB debugging, then retry.");
    if ([...devices.values()].includes("offline")) return fail("The headset connection is offline. Wake it, reconnect the USB data cable, and retry.");
    return fail("No authorized Quest headset found. Enable Developer Mode, power it on, connect a USB data cable, and accept USB debugging. Other Android devices are not opened.");
  }
  if (quests.length > 1) return fail("Multiple authorized Quest headsets found. Choose one with npm run quest:open -- --serial <Quest serial> (see adb devices -l).");
  const target = quests[0];
  const reverse = adb(["-s", target, "reverse", "tcp:3017", "tcp:3017"]);
  if (reverse.error || reverse.status !== 0) return fail("Could not forward port 3017 to the Quest. Check the USB connection and debugging permission, then retry.");
  const started = adb(["-s", target, "shell", "am", "start", "-a", "android.intent.action.VIEW", "-d",
    `http://localhost:3017/room#local-scan=${token}`]);
  if (started.error || started.status !== 0 || /(?:^|\n)\s*(?:Error:|Exception)/i.test(`${started.stdout ?? ""}\n${started.stderr ?? ""}`)) {
    return fail("Could not open the Quest browser. Put on the headset and retry; the private scan URL has not been printed.");
  }
  return { ok: true, message: "Opened the private room preview on the Quest through USB port 3017. Keep the local server running, then choose Enter VR in the headset. The token has not been printed." };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = openQuest({ argv: process.argv.slice(2) });
  (result.ok ? console.log : console.error)(result.message);
  process.exitCode = result.ok ? 0 : 1;
}
