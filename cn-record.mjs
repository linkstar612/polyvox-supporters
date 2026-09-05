// Record a WeChat Pay or Alipay payment that landed in アたる's personal
// collection code, from the bill she forwards (微信 收款小账本 / 支付宝 账单).
//
// Nothing polls a personal code (README § Recording a WeChat or Alipay
// payment), so this is the whole rail: she sends the bill lines, the owner runs
// one command per batch, the Action rebuilds the goal bars on its next tick.
//
//   node cn-record.mjs <wechat|alipay> <YYYY-MM-DD> <HH:MM> <amount CNY> [--name "显示名"] [--goal living] [--dry-run]
//   node cn-record.mjs --batch <file>        one payment per line, same fields, "#" starts a comment
//
// The `name` is ONLY what the payer typed as the payment memo (付款方备注 / 备注)
// when they want to be credited; the app tells them to. Blank stays anonymous.
// The masked payer name the bill shows ("*饭"), a WeChat ID, a phone number, or
// any memo text that is not the chosen display name never goes in: ledger.json
// is world-readable. The checks below refuse the obvious shapes of that mistake.
//
// Times are as printed in her bill (Asia/Shanghai); they only feed the dedupe
// id, so the zone never matters as long as the same bill line always produces
// the same id. Validation, dedupe and the write are ledger-append.mjs's job,
// so this file builds the entry and hands it over; nothing is duplicated here.

import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APPEND = path.join(HERE, "ledger-append.mjs");
const PLATFORMS = new Set(["wechat", "alipay"]);

function usage(msg) {
  if (msg) console.error(msg);
  console.error(
    'usage: node cn-record.mjs <wechat|alipay> <YYYY-MM-DD> <HH:MM> <amount> [--name "显示名"] [--goal living] [--dry-run]\n' +
      "       node cn-record.mjs --batch <file> [--dry-run]",
  );
  process.exit(2);
}

/** Reject the shapes that are not a chosen display name. */
function checkName(name) {
  if (!name) return "";
  const n = name.trim();
  if (n.startsWith("*")) throw new Error(`"${n}" is the bill's masked payer name, not a chosen display name. Leave --name off.`);
  if (/\d{6,}/.test(n)) throw new Error(`"${n}" contains a long digit run (phone / account number). Refusing.`);
  if (/@|wxid_|微信号|支付宝/.test(n)) throw new Error(`"${n}" looks like an account handle. Refusing.`);
  if (n.length > 48) throw new Error(`"${n}" is longer than 48 characters.`);
  return n;
}

function buildEntry(tokens) {
  const args = [];
  const opts = { name: "", goal: "living", dryRun: false };
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === "--name") opts.name = tokens[++i] ?? "";
    else if (t === "--goal") opts.goal = tokens[++i] ?? "";
    else if (t === "--dry-run") opts.dryRun = true;
    else if (t.startsWith("--")) usage(`unknown option ${t}`);
    else args.push(t);
  }
  const [platform, date, time, amountRaw] = args;
  if (args.length !== 4) usage(`expected 4 positional fields, got ${args.length}: ${args.join(" ")}`);
  if (!PLATFORMS.has(platform)) usage(`platform must be wechat or alipay, got "${platform}"`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) usage(`date must be YYYY-MM-DD, got "${date}"`);
  if (!/^\d{2}:\d{2}$/.test(time)) usage(`time must be HH:MM, got "${time}"`);
  const amount = Number(amountRaw.replace(/^[¥￥]/, ""));
  if (!Number.isFinite(amount) || amount <= 0) usage(`amount must be a positive number of yuan, got "${amountRaw}"`);
  if (!/^[a-z_]+$/.test(opts.goal)) usage(`goal must be a manifest goal id, got "${opts.goal}"`);
  return {
    dryRun: opts.dryRun,
    entry: {
      id: `${platform}:${date}-${time.replace(":", "")}-${amount.toFixed(2)}`,
      platform,
      month: date.slice(0, 7),
      amount,
      currency: "CNY",
      goal: opts.goal,
      name: checkName(opts.name),
      link: "",
      recurring: false,
    },
  };
}

function record({ entry, dryRun }) {
  const json = JSON.stringify(entry);
  if (dryRun) {
    console.log(`[dry-run] ${json}`);
    return 0;
  }
  const r = spawnSync(process.execPath, [APPEND], {
    env: { ...process.env, LEDGER_ENTRY: json },
    cwd: HERE,
    stdio: "inherit",
  });
  return r.status ?? 1;
}

const argv = process.argv.slice(2);
if (argv.length === 0) usage();

let failures = 0;
if (argv[0] === "--batch") {
  const file = argv[1];
  if (!file) usage("--batch needs a file");
  const globalDry = argv.includes("--dry-run");
  const lines = readFileSync(file, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const text = line.replace(/#.*$/, "").trim();
    if (!text) continue;
    // Quoted names: wechat 2026-09-05 16:52 66 --name "some name"
    const tokens = [...text.matchAll(/"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2]);
    if (globalDry) tokens.push("--dry-run");
    try {
      if (record(buildEntry(tokens)) !== 0) failures++;
    } catch (e) {
      console.error(`line "${text}": ${e.message}`);
      failures++;
    }
  }
} else {
  try {
    failures = record(buildEntry(argv)) === 0 ? 0 : 1;
  } catch (e) {
    console.error(e.message);
    failures = 1;
  }
}
process.exitCode = failures ? 1 : 0;
