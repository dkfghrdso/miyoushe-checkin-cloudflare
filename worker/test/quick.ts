import { verifyTotp, base32Decode, base32Encode, hashPassword, verifyPassword, generateTotpSecret, hmacSha256Base64 } from "../src/crypto";
import { computeNextPlanned, zonedTimeToUtc, localDateString, timeZoneParts } from "../src/schedule";

let failures = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`);
}

// RFC 6238 test vector: secret "12345678901234567890", T=59s, SHA1 -> 94287082 (8 digits) -> 287082 (6 digits)
const rfcSecret = base32Encode(new TextEncoder().encode("12345678901234567890"));
check("base32 encode RFC secret", rfcSecret, "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
check("base32 roundtrip", new TextDecoder().decode(base32Decode(rfcSecret)), "12345678901234567890");
check("totp T=59 -> 287082", await verifyTotp(rfcSecret, "287082", 59), true);
check("totp T=59 rejects 287083", await verifyTotp(rfcSecret, "287083", 59), false);
check("totp T=1111111109 -> 081804", await verifyTotp(rfcSecret, "081804", 1111111109), true);

const hash = await hashPassword("hunter2", 1000);
check("pbkdf2 verify ok", await verifyPassword("hunter2", hash), true);
check("pbkdf2 verify bad", await verifyPassword("hunter3", hash), false);
check("pbkdf2 format", hash.split("$")[0], "pbkdf2_sha256");
check("generated totp secret decodes", base32Decode(generateTotpSecret()).length, 20);

// DingTalk sign vector from docs: timestamp=1700000000000, secret "SEC0d4d1b5e..." example is not official; just check it is stable/deterministic.
const sig1 = await hmacSha256Base64("secret", "1700000000000\nsecret");
const sig2 = await hmacSha256Base64("secret", "1700000000000\nsecret");
check("hmac deterministic", sig1 === sig2 && sig1.length > 0, true);

// Shanghai has no DST: 2026-09-21 10:00 local -> 02:00 UTC
const d = zonedTimeToUtc(2026, 9, 21, 10, 0, 0, "Asia/Shanghai");
check("shanghai 10:00 -> 02:00Z", d.toISOString(), "2026-09-21T02:00:00.000Z");
const now = new Date("2026-09-21T00:00:00.000Z"); // 08:00 Shanghai
check("local date string", localDateString(now, "Asia/Shanghai"), "2026-09-21");
const planned = computeNextPlanned(now, { enabled: true, start_time: "10:00", jitter_seconds: 0 }, "Asia/Shanghai");
check("planned = today 10:00 SH", planned.toISOString(), "2026-09-21T02:00:00.000Z");
const late = new Date("2026-09-21T05:00:00.000Z"); // 13:00 Shanghai, past 10:00
const next = computeNextPlanned(late, { enabled: true, start_time: "10:00", jitter_seconds: 0 }, "Asia/Shanghai");
check("planned rolls to tomorrow", next.toISOString(), "2026-09-22T02:00:00.000Z");
const parts = timeZoneParts(new Date("2026-09-21T16:30:00.000Z"), "Asia/Shanghai");
check("tz parts 00:30 next day", [parts.day, parts.hour, parts.minute], [22, 0, 30]);

console.log(failures ? `\n${failures} test(s) failed` : "\nall tests passed");
process.exit(failures ? 1 : 0);
