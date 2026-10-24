import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { constants, readFileSync } from "node:fs";
import { access, mkdir, open as openFile, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { randomUUID, createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { pipeline } from "node:stream/promises";
import { chooseNativeDirectory, createDiskFolder, diskRootFor, insideRoot, listDiskDirectory, listDiskFolders, renameDiskEntry, resolveDiskEntry, toBrowserPath, validateArchiveDirectory, validateBrowseDirectory } from "./disk-files.mjs";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, "public");
const DATA_DIR = path.join(ROOT, ".data");
const FILES_PATH = path.join(DATA_DIR, "files.json");
const SETTINGS_PATH = path.join(DATA_DIR, "settings.json");
const CATEGORIES = new Map([
  ["courses", "课程资料"],
  ["assignments", "作业报告"],
  ["slides", "课件讲义"],
  ["exams", "考试资料"],
  ["personal", "个人材料"],
  ["other", "其他"]
]);
const SKIP_DIRECTORIES = new Set([
  ".Spotlight-V100", ".Trashes", ".fseventsd", ".DocumentRevisions-V100",
  "System Volume Information", "$RECYCLE.BIN", "node_modules", ".git"
]);
let scanning = false;
let diskMutation = false;
let pickerOpen = false;
let scanInfo = { scanned: 0, bytes: 0, startedAt: null, completedAt: null, error: "", skipped: [] };

loadEnvFile();
const CONFIG = {
  defaultDrivePath: process.env.DRIVE_PATH?.trim() || "",
  host: process.env.HOST?.trim() || "127.0.0.1",
  port: Number(process.env.PORT || 3000)
};

function loadEnvFile() {
  try {
    const contents = readFileSync(path.join(ROOT, ".env"), "utf8");
    for (const line of contents.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const separator = trimmed.indexOf("=");
      if (separator < 1) continue;
      const key = trimmed.slice(0, separator).trim();
      let value = trimmed.slice(separator + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
      if (!(key in process.env)) process.env[key] = value;
    }
  } catch {}
}

async function ensureDataFiles() {
  await mkdir(DATA_DIR, { recursive: true });
  try { await readFile(FILES_PATH, "utf8"); }
  catch { await writeFile(FILES_PATH, "[]\n", { mode: 0o600 }); }
}

async function readFiles() {
  try {
    const parsed = JSON.parse(await readFile(FILES_PATH, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

async function saveFiles(files) {
  const temporary = `${FILES_PATH}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(files, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, FILES_PATH);
}

async function readSettings() {
  try { return JSON.parse(await readFile(SETTINGS_PATH, "utf8")); }
  catch { return {}; }
}

async function drivePath() {
  const settings = await readSettings();
  return path.resolve(settings.drivePath || CONFIG.defaultDrivePath || "");
}

async function driveStatus() {
  const settings = await readSettings();
  const selected = settings.drivePath || CONFIG.defaultDrivePath || "";
  if (!selected) return { configured: false, connected: false, path: "", error: "" };
  const absolute = path.resolve(selected);
  try {
    const details = await stat(absolute);
    if (!details.isDirectory()) return { configured: true, connected: false, path: absolute, error: "所选路径不是文件夹" };
    await access(absolute, constants.R_OK | constants.W_OK);
    return { configured: true, connected: true, path: absolute, browseRoot: await diskRootFor(absolute), error: "" };
  } catch {
    return { configured: true, connected: false, path: absolute, error: "无法访问此目录；请确认硬盘已连接且目录可读写" };
  }
}

async function withDiskMutation(action) {
  if (scanning || diskMutation) throw Object.assign(new Error("正在整理或扫描文件，请完成后再操作"), { status: 409 });
  diskMutation = true;
  try { return await action(); }
  finally { diskMutation = false; }
}

async function saveArchiveDirectory(selected) {
  const directory = await validateArchiveDirectory(selected);
  const previous = await readSettings();
  if (previous.drivePath !== directory) await saveFiles([]);
  await saveSettings({ ...previous, drivePath: directory });
  return directory;
}

async function saveSettings(settings) {
  const temporary = `${SETTINGS_PATH}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, SETTINGS_PATH);
}

async function browseStatus() {
  const settings = await readSettings();
  const selected = settings.browsePath || settings.drivePath || CONFIG.defaultDrivePath || "";
  if (!selected) return { configured: false, connected: false, path: "", error: "" };
  try {
    const root = settings.browsePath ? path.resolve(selected) : await diskRootFor(selected);
    return { configured: true, connected: true, path: await validateBrowseDirectory(root), error: "" };
  } catch {
    return { configured: true, connected: false, path: path.resolve(selected), error: "无法访问浏览位置，请连接硬盘或重新选择目录" };
  }
}

async function connectedDisk() {
  const browser = await browseStatus();
  if (!browser.connected) throw Object.assign(new Error(browser.error || "请先选择要查看的硬盘或目录"), { status: 400 });
  const settings = await readSettings();
  return { browseRoot: browser.path, archivePath: settings.drivePath || CONFIG.defaultDrivePath || "" };
}

async function connectedArchive() {
  const drive = await driveStatus();
  if (!drive.connected) throw Object.assign(new Error(drive.error || "请先选择移动硬盘归档位置"), { status: 400 });
  return drive;
}

function requireBrowseRoot(drive, expected) {
  if (expected && expected !== drive.browseRoot) throw Object.assign(new Error("浏览位置已变化，请刷新后重新操作"), { status: 409 });
}

async function syncRenamedIndex(change, archiveDirectory) {
  if (!archiveDirectory || !insideRoot(path.resolve(archiveDirectory), change.from)) return;
  const archive = await realpath(archiveDirectory);
  const files = await readFiles();
  let changed = false;
  const updated = files.map((file) => {
    const source = file.relativePath ? path.resolve(archive, file.relativePath) : path.resolve(file.remotePath);
    if (!insideRoot(change.from, source)) return file;
    changed = true;
    const target = path.resolve(change.to, path.relative(change.from, source));
    const relativePath = path.relative(archive, target);
    const category = categoryFor(relativePath);
    return { ...file, id: createHash("sha256").update(target).digest("hex").slice(0, 32), remotePath: target, relativePath, filename: path.basename(target), category, categoryLabel: CATEGORIES.get(category) };
  });
  if (changed) await saveFiles(updated);
}

function json(res, status, body) {
  const payload = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": payload.length,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  });
  res.end(payload);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[character]);
}

function errorPage(title, message) {
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><body style="font:16px/1.6 system-ui,sans-serif;max-width:640px;margin:12vh auto;padding:24px;color:#172133"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p><p><a href="/">返回资料库</a></p></body></html>`;
}

function isLocalOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    return parsed.host === req.headers.host && ["http:", "https:"].includes(parsed.protocol);
  } catch { return false; }
}

async function writeJsonBody(req, limit = 16_000) {
  const chunks = [];
  let size = 0;
  for await (const part of req) {
    size += part.length;
    if (size > limit) throw Object.assign(new Error("请求内容过大"), { status: 413 });
    chunks.push(part);
  }
  const body = Buffer.concat(chunks).toString("utf8");
  try { return JSON.parse(body || "{}"); }
  catch { throw Object.assign(new Error("请求格式无效"), { status: 400 }); }
}

function safeFilename(value) {
  const base = path.posix.basename(String(value || "").replaceAll("\\", "/"));
  let cleaned = base.replace(/[<>:"|?*\u0000-\u001f\u007f]/g, "_").trim().replace(/[. ]+$/g, "");
  if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(cleaned)) cleaned = `_${cleaned}`;
  return cleaned.slice(0, 220) || "未命名文件";
}

function conflictFilename(filename, index) {
  if (!index) return filename;
  const extension = path.extname(filename);
  const stem = filename.slice(0, filename.length - extension.length);
  return `${stem} (${index})${extension}`;
}

function categoryFor(relativePath) {
  const firstFolder = relativePath.split(path.sep)[0];
  for (const [key, label] of CATEGORIES) if (firstFolder === label) return key;
  const normalized = relativePath.toLowerCase();
  const categories = [
    ["personal", /(证书|证明|简历|成绩单|身份证|奖状|个人材料)/],
    ["exams", /(考试|试卷|真题|复习|模拟题|考纲)/],
    ["assignments", /(作业|报告|实验|论文|project|assignment|lab\b)/],
    ["slides", /(课件|讲义|slides?|ppt\b|课本|教材)/]
  ];
  for (const [key, pattern] of categories) if (pattern.test(normalized)) return key;
  if (/\.(ppt|pptx|key)$/i.test(relativePath)) return "slides";
  return "courses";
}

async function scanDirectory(root) {
  const rootReal = await realpath(root);
  const files = [];
  const stack = [rootReal];
  let bytes = 0;
  let scanned = 0;
  const errors = [];

  while (stack.length) {
    const current = stack.pop();
    let entries;
    try { entries = await readdir(current, { withFileTypes: true }); }
    catch (error) {
      if (errors.length < 20) errors.push(`${path.relative(rootReal, current) || "."}: ${error.message}`);
      continue;
    }
    const fileEntries = [];
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const fullPath = path.join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (!SKIP_DIRECTORIES.has(entry.name)) stack.push(fullPath);
      } else if (entry.isFile()) fileEntries.push({ entry, fullPath });
    }
    for (let index = 0; index < fileEntries.length; index += 64) {
      const batch = fileEntries.slice(index, index + 64);
      const results = await Promise.all(batch.map(async ({ entry, fullPath }) => {
        try {
          const details = await stat(fullPath);
          const relativePath = path.relative(rootReal, fullPath);
          const category = categoryFor(relativePath);
          const id = createHash("sha256").update(fullPath).digest("hex").slice(0, 32);
          return {
            id,
            filename: entry.name,
            category,
            categoryLabel: CATEGORIES.get(category),
            size: details.size,
            remotePath: fullPath,
            uploadedAt: details.mtime.toISOString(),
            relativePath
          };
        } catch (error) {
          if (errors.length < 20) errors.push(`${path.relative(rootReal, fullPath)}: ${error.message}`);
          return null;
        }
      }));
      for (const file of results) {
        if (!file) continue;
        files.push(file);
        bytes += file.size;
        scanned += 1;
      }
      scanInfo = { ...scanInfo, scanned, bytes };
    }
  }
  files.sort((left, right) => new Date(right.uploadedAt) - new Date(left.uploadedAt));
  await saveFiles(files);
  return { scanned, bytes, errors };
}

function startScan(root) {
  if (scanning || diskMutation) return false;
  scanning = true;
  scanInfo = { scanned: 0, bytes: 0, startedAt: new Date().toISOString(), completedAt: null, error: "", errors: [] };
  scanDirectory(root).then((summary) => {
    scanInfo = { ...scanInfo, ...summary, completedAt: new Date().toISOString() };
  }).catch((error) => {
    scanInfo = { ...scanInfo, error: error.message || "扫描失败", completedAt: new Date().toISOString() };
  }).finally(() => { scanning = false; });
  return true;
}

function revealPath(target, res) {
  if (process.platform !== "win32") {
    json(res, 501, { error: "请在 Windows 电脑运行课夹，才能打开文件资源管理器" });
    return;
  }
  const child = spawn("explorer.exe", [`/select,${target}`], { stdio: "ignore", detached: true });
  child.on("error", () => json(res, 500, { error: "无法打开文件资源管理器" }));
  child.on("spawn", () => {
    child.unref();
    json(res, 200, { ok: true });
  });
}

async function staticFile(res, pathname) {
  let cleanPath;
  try { cleanPath = decodeURIComponent(pathname).replace(/^\/+/, ""); }
  catch { json(res, 400, { error: "路径无效" }); return; }
  const target = path.resolve(PUBLIC_DIR, cleanPath || "index.html");
  if (!target.startsWith(`${PUBLIC_DIR}${path.sep}`) && target !== path.join(PUBLIC_DIR, "index.html")) {
    json(res, 403, { error: "Forbidden" });
    return;
  }
  try {
    const contents = await readFile(target);
    const contentType = new Map([
      [".html", "text/html; charset=utf-8"], [".css", "text/css; charset=utf-8"],
      [".js", "text/javascript; charset=utf-8"], [".svg", "image/svg+xml"]
    ]).get(path.extname(target)) || "application/octet-stream";
    res.writeHead(200, {
      "content-type": contentType,
      "content-length": contents.length,
      "cache-control": "no-cache",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'"
    });
    res.end(contents);
  } catch { json(res, 404, { error: "Not found" }); }
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  if (req.method === "GET" && url.pathname === "/api/status") {
    const drive = await driveStatus();
    const browser = await browseStatus();
    json(res, 200, {
      configured: drive.configured,
      connected: drive.connected,
      drivePath: drive.path,
      rootPath: drive.path,
      browseRoot: browser.path,
      browser,
      platform: process.platform,
      error: drive.error,
      categories: Object.fromEntries(CATEGORIES)
    });
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/files") {
    json(res, 200, { files: await readFiles() });
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/scan-status") {
    json(res, 200, { running: scanning, ...scanInfo });
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/disk") {
    const drive = await connectedDisk();
    requireBrowseRoot(drive, url.searchParams.get("browseRoot"));
    json(res, 200, await listDiskDirectory(drive.browseRoot, url.searchParams.get("path") || "", { query: url.searchParams.get("query") || "", page: url.searchParams.get("page") || 0 }));
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/library") {
    const drive = await connectedDisk();
    requireBrowseRoot(drive, url.searchParams.get("browseRoot"));
    json(res, 200, { browseRoot: drive.browseRoot, folders: await listDiskFolders(drive.browseRoot) });
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/pick-directory") {
    if (!isLocalOrigin(req)) return json(res, 403, { error: "请求来源无效" });
    const body = await writeJsonBody(req);
    if (pickerOpen) return json(res, 409, { error: "系统选择窗口已打开，请先完成或取消" });
    pickerOpen = true;
    const controller = new AbortController();
    const cancel = () => controller.abort();
    res.once("close", cancel);
    try {
      const selected = await chooseNativeDirectory(body.kind === "archive" ? "请选择归档文件夹" : "请选择要查看的硬盘或文件夹", { signal: controller.signal });
      if (!res.destroyed) json(res, 200, selected ? { path: selected } : { cancelled: true });
    } finally {
      res.removeListener("close", cancel);
      pickerOpen = false;
    }
    return;
  }
  if (req.method === "POST" && ["/api/drive-path", "/api/browse-path", "/api/browse-archive"].includes(url.pathname)) {
    if (!isLocalOrigin(req)) return json(res, 403, { error: "请求来源无效" });
    const body = await writeJsonBody(req);
    const archive = url.pathname === "/api/drive-path";
    const directory = await withDiskMutation(async () => {
      if (archive) return saveArchiveDirectory(body.path);
      const selected = url.pathname === "/api/browse-archive" ? (await connectedArchive()).path : body.path;
      const browsePath = await validateBrowseDirectory(selected);
      await saveSettings({ ...await readSettings(), browsePath });
      return browsePath;
    });
    json(res, 200, { ok: true, ...(archive ? { drivePath: directory } : { browseRoot: directory }) });
    return;
  }
  if (req.method === "POST" && ["/api/disk/folder", "/api/disk/rename", "/api/disk/reveal"].includes(url.pathname)) {
    if (!isLocalOrigin(req)) return json(res, 403, { error: "请求来源无效" });
    const body = await writeJsonBody(req);
    if (url.pathname === "/api/disk/reveal") {
      const drive = await connectedDisk();
      requireBrowseRoot(drive, body.browseRoot);
      const entry = await resolveDiskEntry(drive.browseRoot, body.path);
      revealPath(entry.target, res);
      return;
    }
    await withDiskMutation(async () => {
      const drive = await connectedDisk();
      requireBrowseRoot(drive, body.browseRoot);
      if (url.pathname === "/api/disk/folder") {
        const result = await createDiskFolder(drive.browseRoot, body.path || "", body.name);
        json(res, 201, { ok: true, ...result });
      } else {
        const change = await renameDiskEntry(drive.browseRoot, body.path, body.name, drive.archivePath);
        let warning = "";
        try { await syncRenamedIndex(change, drive.archivePath); }
        catch { warning = "名称已修改，但索引未更新，请重新扫描归档目录"; }
        json(res, 200, { ok: true, relativePath: toBrowserPath(path.relative(drive.browseRoot, change.to)), warning });
      }
    });
    return;
  }
  if (req.method === "POST" && ["/api/upload", "/api/disk/upload"].includes(url.pathname)) {
    if (!isLocalOrigin(req)) return json(res, 403, { error: "请求来源无效" });
    await withDiskMutation(async () => {
      const direct = url.pathname === "/api/disk/upload";
      let targetDirectory;
      let drive;
      let categoryKey;
      let categoryLabel;
      if (direct) {
        const browser = await connectedDisk();
        requireBrowseRoot(browser, url.searchParams.get("browseRoot"));
        const directory = await resolveDiskEntry(browser.browseRoot, url.searchParams.get("path") || "");
        if (!(await stat(directory.target)).isDirectory()) return json(res, 400, { error: "投递位置不是文件夹，请重新选择栏目" });
        targetDirectory = directory.target;
        await access(targetDirectory, constants.W_OK);
      } else {
        drive = await connectedArchive();
        categoryKey = url.searchParams.get("category") || "courses";
        categoryLabel = CATEGORIES.get(categoryKey);
        if (!categoryLabel) return json(res, 400, { error: "无效的文件分类" });
        targetDirectory = path.join(drive.path, categoryLabel);
        await mkdir(targetDirectory, { recursive: true });
        if (!insideRoot(await realpath(drive.path), await realpath(targetDirectory))) return json(res, 403, { error: "分类文件夹不在归档目录内" });
      }
      let originalName;
      try { originalName = safeFilename(decodeURIComponent(req.headers["x-file-name"] || "")); }
      catch { return json(res, 400, { error: "文件名无效" }); }
      let handle;
      let target;
      for (let index = 0; index < 10_000; index += 1) {
        target = path.join(targetDirectory, conflictFilename(originalName, index));
        try {
          handle = await openFile(target, "wx", 0o600);
          break;
        } catch (error) {
          if (error.code !== "EEXIST") throw error;
        }
      }
      if (!handle) return json(res, 409, { error: "找不到可用的文件名" });
      try {
        await pipeline(req, handle.createWriteStream());
      } catch (error) {
        await rm(target, { force: true }).catch(() => {});
        json(res, Number(error.status) || 500, { error: error.message || "复制文件失败" });
        return;
      }
      try {
        const details = await stat(target);
        if (direct) {
          drive = await driveStatus();
          if (!drive.connected || !insideRoot(await realpath(drive.path), target)) {
            return json(res, 201, { ok: true, indexed: false, filename: path.basename(target) });
          }
          categoryKey = categoryFor(path.relative(drive.path, target));
          categoryLabel = CATEGORIES.get(categoryKey);
        }
        const record = {
          id: createHash("sha256").update(target).digest("hex").slice(0, 32),
          filename: path.basename(target),
          category: categoryKey,
          categoryLabel,
          size: details.size,
          remotePath: target,
          uploadedAt: details.mtime.toISOString(),
          relativePath: path.relative(drive.path, target)
        };
        const files = await readFiles();
        const updated = [record, ...files.filter((entry) => entry.id !== record.id)];
        await saveFiles(updated);
        json(res, 201, { file: record, indexed: true });
      } catch (error) {
        json(res, Number(error.status) || 500, { error: `文件已复制到硬盘，但索引更新失败。请点击“扫描归档目录”重新读取。${error.message ? `（${error.message}）` : ""}` });
      }
    });
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/scan") {
    if (!isLocalOrigin(req)) return json(res, 403, { error: "请求来源无效" });
    const drive = await driveStatus();
    if (!drive.connected) return json(res, 400, { error: drive.error || "先设置一个已连接的移动硬盘目录" });
    if (!startScan(drive.path)) return json(res, 409, { error: "正在整理或扫描文件，请完成后再试" });
    json(res, 202, { ok: true });
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/reveal") {
    if (!isLocalOrigin(req)) return json(res, 403, { error: "请求来源无效" });
    const body = await writeJsonBody(req);
    const file = (await readFiles()).find((entry) => entry.id === body.id);
    if (!file) return json(res, 404, { error: "文件索引已变化，请重新扫描移动硬盘" });
    const root = await drivePath();
    const resolvedFile = path.resolve(file.remotePath);
    try { await stat(resolvedFile); }
    catch { return json(res, 404, { error: "找不到原文件；可能已移动或删除" }); }
    const rootReal = await realpath(root);
    const fileReal = await realpath(resolvedFile);
    const relative = path.relative(rootReal, fileReal);
    if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      return json(res, 403, { error: "文件不在已设置的硬盘目录中" });
    }
    revealPath(fileReal, res);
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/reveal-root") {
    if (!isLocalOrigin(req)) return json(res, 403, { error: "请求来源无效" });
    const drive = await driveStatus();
    if (!drive.connected) return json(res, 400, { error: drive.error || "先设置移动硬盘目录" });
    if (process.platform === "win32") {
      const child = spawn("explorer.exe", [drive.path], { stdio: "ignore", detached: true });
      child.on("error", () => json(res, 500, { error: "无法打开文件资源管理器" }));
      child.on("spawn", () => { child.unref(); json(res, 200, { ok: true }); });
    } else {
      json(res, 501, { error: "请在 Windows 电脑运行课夹，才能打开文件资源管理器" });
    }
    return;
  }
  if (req.method === "GET") {
    await staticFile(res, url.pathname);
    return;
  }
  json(res, 405, { error: "Method not allowed" });
}

await ensureDataFiles();
const server = http.createServer((req, res) => {
  handle(req, res).catch((error) => {
    if (!res.headersSent) json(res, Number(error.status) || 500, { error: error.message || "服务器出错" });
    else res.destroy();
  });
});
server.requestTimeout = 0;
server.listen(CONFIG.port, CONFIG.host, () => {
  console.log(`课夹已启动：http://${CONFIG.host}:${server.address().port}`);
  console.log(CONFIG.defaultDrivePath ? `移动硬盘目录：${CONFIG.defaultDrivePath}` : "请在网页中设置移动硬盘目录。");
});
