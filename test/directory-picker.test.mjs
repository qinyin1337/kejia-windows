import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { chooseNativeDirectory } from "../disk-files.mjs";

function fakeProcess() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.kill = () => { child.killed = true; queueMicrotask(() => child.emit("close", null)); };
  return child;
}

test("native picker returns Unicode paths and treats cancel as an empty selection", async () => {
  for (const selected of ["E:\\课程资料\\英语", ""]) {
    const child = fakeProcess();
    const result = chooseNativeDirectory("选择", { platform: "win32", spawnProcess: (_command, args, options) => {
      assert.ok(args.includes("-STA"));
      assert.equal(options.env.COURSE_ARCHIVE_PICKER_DESCRIPTION, "选择");
      queueMicrotask(() => { child.stdout.write(selected); child.emit("close", 0); });
      return child;
    } });
    assert.equal(await result, selected);
  }
});

test("closing the page dialog terminates the native picker and allows another attempt", async () => {
  const controller = new AbortController();
  const child = fakeProcess();
  const result = chooseNativeDirectory("", { platform: "win32", signal: controller.signal, spawnProcess: () => child });
  controller.abort();
  await assert.rejects(result, /已取消/);
  assert.equal(child.killed, true);
});

test("hung picker times out and terminates its process", async () => {
  const child = fakeProcess();
  await assert.rejects(chooseNativeDirectory("", { platform: "win32", timeoutMs: 10, spawnProcess: () => child }), /超时.*粘贴/);
  assert.equal(child.killed, true);
});

test("startup errors and unsupported platforms explain the direct path alternative", async () => {
  const child = fakeProcess();
  const result = chooseNativeDirectory("", { platform: "win32", spawnProcess: () => {
    queueMicrotask(() => child.emit("error", new Error("not available")));
    return child;
  } });
  await assert.rejects(result, /粘贴/);
  await assert.rejects(chooseNativeDirectory("", { platform: "darwin" }), /粘贴/);
});
