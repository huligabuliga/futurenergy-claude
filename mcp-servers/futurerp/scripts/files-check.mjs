#!/usr/bin/env node
// Check the download_file mime sniffing. Run: npm run build && node scripts/files-check.mjs
import assert from "node:assert/strict";
import { sniffMime, INLINE_IMAGE_MIMES, MAX_INLINE_BYTES } from "../dist/files.js";

const b = (hex) => Buffer.from(hex.replace(/\s/g, ""), "hex");
assert.equal(sniffMime(b("ffd8ffe000104a46"), "application/octet-stream"), "image/jpeg");
assert.equal(sniffMime(b("89504e470d0a1a0a"), ""), "image/png");
assert.equal(sniffMime(b("474946383961"), ""), "image/gif");
assert.equal(sniffMime(b("2550444625"), "application/octet-stream"), "application/pdf");
assert.equal(sniffMime(Buffer.concat([b("52494646"), b("00000000"), Buffer.from("WEBP")]), ""), "image/webp");
assert.equal(sniffMime(Buffer.from("hello"), "text/plain"), "text/plain");
assert.equal(sniffMime(Buffer.from("hello"), ""), "application/octet-stream");
assert.ok(INLINE_IMAGE_MIMES.has("image/jpeg") && !INLINE_IMAGE_MIMES.has("image/heic"));
assert.equal(MAX_INLINE_BYTES, 3.5 * 1024 * 1024);
console.log("PASS  files-check");
