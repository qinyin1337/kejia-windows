import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { matchFilename } from "../public/filename-classifier.js";

test("classified delivery writes correct content, preserves collisions and rejects unsafe paths", { timeout: 15000 }, async (t) => {
  const temporary = await realpath(await mkdtemp(path.join(os.tmpdir(), "kejia-delivery-")));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const app = path.join(temporary, "app");
  const drive = path.join(temporary, "drive");
  const outside = path.join(temporary, "outside");
  await mkdir(app);
  await mkdir(outside);
  await mkdir(path.join(drive, "数学资料"), { recursive: true });
  await mkdir(path.join(drive, "英语课件"));
  const source = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  for (const name of ["server.mjs", "disk-files.mjs", "windows-folder-picker.ps1", "public"]) await cp(path.join(source, name), path.join(app, name), { recursive: true });
  const child = spawn(process.execPath, [path.join(app, "server.mjs")], { env: { ...process.env, HOST: "127.0.0.1", PORT: "0", DRIVE_PATH: drive }, stdio: ["ignore", "pipe", "pipe"] });
  t.after(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, "exit");
    child.kill();
    await exited;
  });
  const base = await new Promise((resolve, reject) => {
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
      const match = output.match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match) resolve(match[0]);
    });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.on("error", reject);
    child.once("exit", (code) => reject(new Error(`Server exited before readiness (${code}): ${output}`)));
  });
  const libraryResponse = await fetch(`${base}/api/library?${new URLSearchParams({ browseRoot: drive })}`);
  assert.equal(libraryResponse.status, 200);
  const library = await libraryResponse.json();
  const target = matchFilename("数学_期中试卷.pdf", library.folders);
  assert.equal(target.directory, "数学资料");
  const deliver = (directory, root = drive, origin = base) => fetch(`${base}/api/disk/upload?${new URLSearchParams({ path: directory, browseRoot: root })}`, {
    method: "POST", headers: { "x-file-name": encodeURIComponent("数学_期中试卷.pdf"), "content-type": "application/octet-stream", origin }, body: "sample-content"
  });
  assert.equal((await deliver(target.directory)).status, 201);
  assert.equal(await readFile(path.join(drive, "数学资料", "数学_期中试卷.pdf"), "utf8"), "sample-content");
  assert.deepEqual(await readdir(path.join(drive, "英语课件")), []);
  assert.equal((await deliver(target.directory)).status, 201);
  assert.equal(await readFile(path.join(drive, "数学资料", "数学_期中试卷 (1).pdf"), "utf8"), "sample-content");
  assert.equal((await deliver("../outside")).status, 403);
  assert.equal((await deliver(target.directory, outside)).status, 409);
  assert.equal((await deliver("不存在的栏目")).status, 404);
  assert.equal((await deliver(target.directory, drive, "https://example.invalid")).status, 403);
  if (process.platform !== "win32") {
    await symlink(outside, path.join(drive, "外部链接"));
    assert.equal((await deliver("外部链接")).status, 403);
  }
  assert.deepEqual(await readdir(outside), []);
  // Saving either location is immediate and never starts indexing implicitly.
  const configure = (endpoint, selected, origin = base) => fetch(`${base}${endpoint}`, {
    method: "POST", headers: { "content-type": "application/json", origin }, body: JSON.stringify({ path: selected })
  });
  assert.equal((await configure("/api/browse-path", outside, "https://example.invalid")).status, 403);
  assert.equal((await configure("/api/browse-path", "relative/path")).status, 400);
  assert.equal((await configure("/api/browse-path", path.join(temporary, "missing"))).status, 404);
  assert.equal((await configure("/api/browse-path", outside)).status, 200);
  let status = await (await fetch(`${base}/api/status`)).json();
  assert.equal(status.browseRoot, outside);
  assert.equal(status.drivePath, drive);
  assert.equal((await configure("/api/drive-path", path.join(drive, "英语课件"))).status, 200);
  status = await (await fetch(`${base}/api/status`)).json();
  assert.equal(status.browseRoot, outside);
  assert.equal(status.drivePath, path.join(drive, "英语课件"));
  const scan = await (await fetch(`${base}/api/scan-status`)).json();
  assert.equal(scan.running, false);
  assert.equal(scan.startedAt, null);
  assert.equal((await configure("/api/browse-archive")).status, 200);
  status = await (await fetch(`${base}/api/status`)).json();
  assert.equal(status.browseRoot, path.join(drive, "英语课件"));
  if (process.platform !== "win32") {
    assert.equal((await configure("/api/pick-directory")).status, 501);
    assert.equal((await configure("/api/pick-directory")).status, 501); // failure releases picker lock
  }
  const js = await fetch(`${base}/filename-classifier.js`);
  assert.equal(js.status, 200);
  assert.match(js.headers.get("content-type"), /javascript/);
});
