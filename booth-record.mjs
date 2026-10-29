// Record paid BOOTH orders from the order mail BOOTH sends the shop.
//
// BOOTH has no read API and no webhook (README § Recording a donation by hand),
// and its seller pages never name a digital buyer: an order shows only an
// identification code. So the shop's own mail is the whole rail. Each
// "Someone placed an order on your shop (Order Number: N) [BOOTH]" mail with a
// total above 0 JPY becomes `booth:<N>`, anonymous, and goes to
// ledger-append.mjs, which validates, dedupes on `id` and writes. Nothing is
// duplicated here.
//
//   node booth-record.mjs --mbox <file> [--state <in.json>] [--next-state <out.json>] [--goal living] [--dry-run]
//   node booth-record.mjs <message.eml> ... [--goal living] [--dry-run]
//
// Run it from the folder whose ledger.json it should write. `--mbox` is a local
// mbox such as Thunderbird's offline copy of the inbox; it is streamed, and only
// messages that mention noreply@booth.pm are decoded. `--state` resumes from the
// byte offset an earlier run stopped at, but only while the bytes there still
// match, because compaction rewrites the file and forces a full rescan.
// `--next-state` is where this run writes its own offset, so a caller can keep
// the old one until its push lands. A rescan costs only time: an id already in
// the ledger is skipped.
//
// A mail counts only with the receiving server's `dkim=pass header.i=@booth.pm`,
// so a message that merely claims BOOTH's address cannot add money to the goal.
//
// `name` is always blank. A buyer is named only once they ask, which is a hand
// edit of `name` on their entry (README § Naming someone later). The order
// number is the id because the buyer sees it in their own purchase history,
// which is how they can say which entry is theirs. BOOTH's buyer code is never
// written: it is a standing identifier for that person and this file is public.
//
// `at` is the mail's Date header on Japan time (+09:00), the clock BOOTH's order
// pages use, and `month` is its first seven characters, the same rule
// cn-record.mjs follows for China time and ledger-append.mjs enforces.

import { closeSync, createReadStream, openSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APPEND = path.join(HERE, "ledger-append.mjs");
const SENDER = "noreply@booth.pm";
const FINGERPRINT_BYTES = 64;
const JST_MS = 9 * 60 * 60 * 1000;

function usage(msg) {
  if (msg) console.error(msg);
  console.error(
    "usage: node booth-record.mjs --mbox <file> [--state <in.json>] [--next-state <out.json>] [--goal living] [--dry-run]\n" +
      "       node booth-record.mjs <message.eml> ... [--goal living] [--dry-run]",
  );
  process.exit(2);
}

function decode(bytes, charset) {
  try {
    return new TextDecoder(charset.toLowerCase()).decode(bytes);
  } catch {
    return Buffer.from(bytes).toString("utf8");
  }
}

/** Quoted-printable escapes (=E3=81=82) to bytes. Works on bytes, so raw UTF-8 passes through. */
function qpBytes(text) {
  const src = Buffer.from(text, "utf8");
  const out = Buffer.alloc(src.length);
  const isHex = (b) => (b >= 48 && b <= 57) || (b >= 65 && b <= 70) || (b >= 97 && b <= 102);
  let n = 0;
  for (let i = 0; i < src.length; i++) {
    if (src[i] === 0x3d && i + 2 < src.length && isHex(src[i + 1]) && isHex(src[i + 2])) {
      out[n++] = parseInt(String.fromCharCode(src[i + 1], src[i + 2]), 16);
      i += 2;
    } else {
      out[n++] = src[i];
    }
  }
  return out.subarray(0, n);
}

/** A quoted-printable body to text, soft line breaks removed. */
export function decodeQuotedPrintable(text, charset = "utf-8") {
  return decode(qpBytes(text.replace(/=\r?\n/g, "")), charset);
}

/** RFC 2047 encoded words in a header (=?UTF-8?B?...?=) to text. */
export function decodeWords(value) {
  return value.replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (_, charset, enc, text) =>
    decode(enc.toUpperCase() === "B" ? Buffer.from(text, "base64") : qpBytes(text.replace(/_/g, " ")), charset),
  );
}

/** A raw message to lower-cased, unfolded headers (first one wins) and its body. */
export function splitMessage(raw) {
  const gap = /\r?\n\r?\n/.exec(raw);
  const head = gap ? raw.slice(0, gap.index) : raw;
  const body = gap ? raw.slice(gap.index + gap[0].length) : "";
  const headers = {};
  for (const line of head.replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    if (!(key in headers)) headers[key] = line.slice(colon + 1).trim();
  }
  return { headers, body };
}

/** The first text/plain part of a message, decoded. */
function bodyText(headers, body) {
  const type = headers["content-type"] || "text/plain";
  const boundary = /boundary="?([^";]+)"?/i.exec(type)?.[1];
  if (/^multipart\//i.test(type) && boundary) {
    for (const part of body.split(`--${boundary}`).slice(1)) {
      if (part.startsWith("--")) break;
      const sub = splitMessage(part.replace(/^\r?\n/, ""));
      const subType = sub.headers["content-type"] || "text/plain";
      if (!/^(multipart\/|text\/plain)/i.test(subType)) continue;
      const text = bodyText(sub.headers, sub.body);
      if (text) return text;
    }
    return "";
  }
  const charset = /charset="?([^";\s]+)"?/i.exec(type)?.[1] || "utf-8";
  const encoding = (headers["content-transfer-encoding"] || "").toLowerCase();
  if (encoding === "quoted-printable") return decodeQuotedPrintable(body, charset);
  if (encoding === "base64") return decode(Buffer.from(body.replace(/\s+/g, ""), "base64"), charset);
  return body;
}

const jst = (ms) => new Date(ms + JST_MS).toISOString().replace(/\.\d{3}Z$/, "+09:00");

/** One raw message to `{ order, amount, entry }`, or null when it is not a BOOTH order notice.
 *  `entry` is null for a 0 JPY order. Throws when an order notice does not read the way BOOTH
 *  writes one, so a format change is loud instead of a silently missed donation. */
export function parseOrderMail(raw, { goal = "living" } = {}) {
  const { headers, body } = splitMessage(raw);
  if (!(headers.from || "").toLowerCase().includes(`<${SENDER}>`)) return null;
  const order = /Order Number:\s*(\d+)/.exec(decodeWords(headers.subject || ""))?.[1];
  if (!order) return null;
  // The receiving server's verdict: its Authentication-Results sits above any a sender wrote,
  // and splitMessage keeps the first. Anyone can type BOOTH's address into a From line.
  if (!/\bdkim=pass\s+header\.i=@booth\.pm\b/i.test(headers["authentication-results"] || "")) {
    throw new Error(`order ${order}: no DKIM pass for booth.pm, refusing a mail that only claims to be BOOTH`);
  }
  const text = bodyText(headers, body).replace(/\r\n/g, "\n");
  if (!text.includes(`manage.booth.pm/orders/${order}`)) {
    throw new Error(`order ${order}: the body does not link manage.booth.pm/orders/${order}`);
  }
  const total = /^Total:\s*([\d,]+)\s*JPY\s*$/m.exec(text)?.[1];
  if (total === undefined) throw new Error(`order ${order}: no "Total: N JPY" line`);
  const amount = Number(total.replace(/,/g, ""));
  const sent = Date.parse((headers.date || "").replace(/\s*\([^)]*\)\s*$/, ""));
  if (Number.isNaN(sent)) throw new Error(`order ${order}: no usable Date header`);
  const at = jst(sent);
  if (amount <= 0) return { order, amount, entry: null };
  return {
    order,
    amount,
    entry: {
      id: `booth:${order}`,
      platform: "booth",
      month: at.slice(0, 7),
      at,
      amount,
      currency: "JPY",
      goal,
      name: "",
      link: "",
      recurring: false,
    },
  };
}

/** Messages of an mbox from byte `start` on, as `{ offset, raw }`, split on "From " lines. */
export async function* mboxMessages(file, start = 0) {
  const separator = Buffer.from("\nFrom ");
  let carry = Buffer.alloc(0);
  let base = start;
  for await (const chunk of createReadStream(file, { start, highWaterMark: 1 << 22 })) {
    const buf = carry.length ? Buffer.concat([carry, chunk]) : chunk;
    let from = 0;
    for (let i = buf.indexOf(separator); i !== -1; i = buf.indexOf(separator, from)) {
      yield { offset: base + from, raw: buf.subarray(from, i + 1) };
      from = i + 1;
    }
    carry = buf.subarray(from);
    base += from;
  }
  if (carry.length) yield { offset: base, raw: carry };
}

function fingerprint(file, offset) {
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(FINGERPRINT_BYTES);
    return buf.subarray(0, readSync(fd, buf, 0, FINGERPRINT_BYTES, offset)).toString("hex");
  } finally {
    closeSync(fd);
  }
}

/** Where to start reading `file`: the saved offset while its bytes still match, else 0. */
export function resumeOffset(file, state) {
  const saved = state?.[path.resolve(file)];
  if (!saved || !Number.isInteger(saved.offset) || saved.offset <= 0) return 0;
  if (saved.offset >= statSync(file).size) return 0;
  return fingerprint(file, saved.offset) === saved.fingerprint ? saved.offset : 0;
}

/** Every BOOTH-looking message in an mbox from where the last run stopped, plus the next offset. */
export async function scanMbox(file, state) {
  const start = resumeOffset(file, state);
  let last = start;
  const messages = [];
  for await (const { offset, raw } of mboxMessages(file, start)) {
    last = offset;
    if (raw.includes(SENDER)) messages.push(raw.toString("utf8"));
  }
  return { start, last, fingerprint: fingerprint(file, last), messages };
}

function readJson(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

async function main(argv) {
  const opts = { mbox: [], files: [], state: null, nextState: null, goal: "living", dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === "--mbox") opts.mbox.push(argv[++i] ?? usage("--mbox needs a file"));
    else if (t === "--state") opts.state = argv[++i] ?? usage("--state needs a file");
    else if (t === "--next-state") opts.nextState = argv[++i] ?? usage("--next-state needs a file");
    else if (t === "--goal") opts.goal = argv[++i] ?? "";
    else if (t === "--dry-run") opts.dryRun = true;
    else if (t.startsWith("--")) usage(`unknown option ${t}`);
    else opts.files.push(t);
  }
  if (!opts.mbox.length && !opts.files.length) usage();
  if (!/^[a-z_]+$/.test(opts.goal)) usage(`goal must be a manifest goal id, got "${opts.goal}"`);

  const state = opts.state ? readJson(opts.state, {}) : {};
  const nextState = { ...state };
  const messages = opts.files.map((f) => readFileSync(f, "utf8"));
  for (const file of opts.mbox) {
    const scan = await scanMbox(file, state);
    console.log(
      `${file}: ${scan.start ? `resumed at byte ${scan.start}` : "full scan"}, ${scan.messages.length} candidate message(s)`,
    );
    messages.push(...scan.messages);
    nextState[path.resolve(file)] = { offset: scan.last, fingerprint: scan.fingerprint };
  }

  const known = new Set(readJson("ledger.json", { entries: [] }).entries.map((e) => e.id));
  let failures = 0;
  let recorded = 0;
  for (const raw of messages) {
    let parsed;
    try {
      parsed = parseOrderMail(raw, { goal: opts.goal });
    } catch (e) {
      console.error(e.message);
      failures++;
      continue;
    }
    if (!parsed) continue;
    const { order, amount, entry } = parsed;
    if (!entry) {
      console.log(`booth:${order} is ${amount} JPY, nothing to record`);
    } else if (known.has(entry.id)) {
      console.log(`${entry.id} ${amount} JPY ${entry.at} already in the ledger`);
    } else if (opts.dryRun) {
      console.log(`[dry-run] would record ${JSON.stringify(entry)}`);
      known.add(entry.id);
    } else {
      const r = spawnSync(process.execPath, [APPEND], {
        env: { ...process.env, LEDGER_ENTRY: JSON.stringify(entry) },
        stdio: "inherit",
      });
      if (r.status === 0) {
        known.add(entry.id);
        recorded++;
      } else {
        failures++;
      }
    }
  }
  console.log(`${recorded} new BOOTH order(s) recorded${failures ? `, ${failures} failure(s)` : ""}`);
  // A failed run keeps the old offset, so the next run reads the same mail again.
  if (opts.nextState && !failures && !opts.dryRun) writeFileSync(opts.nextState, `${JSON.stringify(nextState, null, 2)}\n`);
  return failures ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
