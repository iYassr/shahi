/** Regression checks for installed transitive security patches. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
function checkInChild(script) {
  // A missing patch must fail a bounded child, never hang or exhaust the runner.
  const result = spawnSync(process.execPath, ["--max-old-space-size=32", "-e", script], {
    cwd: root,
    timeout: 1500,
    encoding: "utf8",
  });
  assert.deepEqual({ status: result.status, error: result.error?.message, stderr: result.stderr }, {
    status: 0, error: undefined, stderr: "",
  });
}

test("ICNS rejects zero and undersized entry lengths, including later entries", () => {
  checkInChild(`
    const assert = require('node:assert/strict');
    const imageSize = require('image-size');
    for (const length of [0, 1, 7]) {
      const input = Buffer.alloc(24);
      input.write('icns'); input.writeUInt32BE(24, 4);
      input.write('icp4', 8); input.writeUInt32BE(8, 12);
      input.write('icp5', 16); input.writeUInt32BE(length, 20);
      assert.throws(() => imageSize(input), /Invalid ICNS entry length/);
      input.writeUInt32BE(length, 12);
      assert.throws(() => imageSize(input), /Invalid ICNS entry length/);
    }
    const valid = Buffer.alloc(24);
    valid.write('icns'); valid.writeUInt32BE(24, 4);
    valid.write('icp4', 8); valid.writeUInt32BE(8, 12);
    valid.write('icp5', 16); valid.writeUInt32BE(8, 20);
    assert.deepEqual(imageSize(valid).images.map(i => i.width), [16, 32]);
  `);
});

test("JXL/HEIF box iteration always advances, including matching zero-sized boxes", () => {
  checkInChild(`
    const assert = require('node:assert/strict');
    const {findBox} = require('image-size/dist/types/utils');
    const {JXL} = require('image-size/dist/types/jxl');
    const {HEIF} = require('image-size/dist/types/heif');
    const input = Buffer.alloc(16);
    input.write('jxlp', 4);
    // A zero-sized ISO box consumes the remaining file, rather than looping.
    assert.equal(findBox(input, 'jxlp', 0).size, 16);
    assert.equal(findBox(input, 'meta', 0), undefined);
    // If the old matching-box loop returns, its result is immaterial here:
    // both a parse failure and a dimensions result are allowed; a hang is not.
    try { JXL.calculate(input); } catch {}
    assert.throws(() => HEIF.calculate(input), /Invalid HEIF/);
    for (const length of [1, 4, 7, 17]) {
      input.writeUInt32BE(length, 0);
      assert.equal(findBox(input, 'jxlp', 0), undefined);
    }
    assert.equal(findBox(Buffer.alloc(7), 'meta', 0), undefined);
  `);
});

test("query-string retains CommonJS decoding, plus signs and Unicode with bounded malformed input", () => {
  checkInChild(`
    const assert = require('node:assert/strict');
    const decode = require('decode-uri-component');
    const query = require('query-string');
    assert.equal(decode('hello+world'), 'hello world');
    assert.equal(decode('%E4%BD%A0%E5%A5%BD'), '你好');
    assert.equal(decode('%C3%A5%FF'), 'å%FF');
    assert.equal(decode('%FF'.repeat(500)), '%FF'.repeat(500));
    assert.equal(query.parse('name=hello+world').name, 'hello world');
  `);
});

test("xcode still generates project identifiers with the patched uuid release", () => {
  checkInChild(`
    const assert = require('node:assert/strict');
    const project = require('xcode').project('unused.pbxproj');
    project.hash = { project: { objects: {} } };
    assert.match(project.generateUuid(), /^[A-F0-9]{24}$/);
    const uuid = require('uuid');
    assert.throws(() => uuid.v5('name', uuid.v5.DNS, new Uint8Array(1)), RangeError);
  `);
});
