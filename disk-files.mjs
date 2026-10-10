import path from "node:path";
import { access, lstat, mkdir, readdir, realpath, rename } from "node:fs/promises";
import { constants } from "node:fs";
import { spawn } from "node:child_process";

const SYSTEM_FOLDERS = new Set(["System Volume Information", "$RECYCLE.BIN", "node_modules", ".git"]);
const isSystemFolder = (name) => [...SYSTEM_FOLDERS].some((entry) => entry.toLowerCase() === name.toLowerCase());
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
export const toBrowserPath = (value) => value.split(path.sep).join("/");
export const insideRoot = (root, target) => {
  const relative = path.relative(root, target);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

async function validateDirectory(selected, archive) {
  const value = String(selected || "").trim().replace(/^(["'])(.*)\1$/s, "$2");
  if (!path.isAbsolute(value)) throw fail("请选择一个完整的文件夹路径");
  const directory = await realpath(value).catch(() => { throw fail("找不到所选文件夹，请确认移动硬盘已连接", 404); });
  const systemRoot = process.platform === "win32" ? `${process.env.SystemDrive || "C:"}${path.sep}` : path.parse(directory).root;
  if (archive && directory.toLowerCase() === systemRoot.toLowerCase()) throw fail("请选择移动硬盘或其中的文件夹，不能选择系统根目录");
  if (!(await lstat(directory)).isDirectory()) throw fail("请选择文件夹");
  await access(directory, archive ? constants.R_OK | constants.W_OK : constants.R_OK).catch(() => { throw fail("无法访问所选文件夹，请检查硬盘权限", 403); });
  return directory;
}

export const validateArchiveDirectory = (selected) => validateDirectory(selected, true);
export const validateBrowseDirectory = (selected) => validateDirectory(selected, false);

export async function diskRootFor(archiveDirectory) {
  const resolved = await realpath(archiveDirectory);
  if (process.platform === "win32") {
    const volume = path.parse(resolved).root;
    const systemVolume = `${process.env.SystemDrive || "C:"}${path.sep}`;
    return volume.toLowerCase() === systemVolume.toLowerCase() ? resolved : volume;
  }
  return resolved;
}

export async function resolveDiskEntry(root, relative = "") {
  const rootReal = await realpath(root);
  const input = String(relative || "");
  if (input.includes("\\") || path.isAbsolute(input)) throw fail("文件路径无效", 403);
  const segments = input.split("/").filter(Boolean);
  if (segments.some((part) => part === "." || part === ".." || part.startsWith(".") || isSystemFolder(part) || part.includes(":"))) {
    throw fail("不能访问此文件路径", 403);
  }
  let target = rootReal;
  for (const segment of segments) {
    target = path.join(target, segment);
    const details = await lstat(target).catch(() => { throw fail("找不到文件或文件夹，请刷新目录", 404); });
    if (details.isSymbolicLink()) throw fail("不支持操作快捷链接或符号链接", 403);
  }
  const targetReal = await realpath(target);
  if (!insideRoot(rootReal, targetReal)) throw fail("文件不在当前硬盘内", 403);
  return { root: rootReal, target: targetReal, relativePath: toBrowserPath(path.relative(rootReal, targetReal)) };
}

export async function listDiskDirectory(root, relative, { query = "", page = 0 } = {}) {
  const resolved = await resolveDiskEntry(root, relative);
  if (!(await lstat(resolved.target)).isDirectory()) throw fail("此路径不是文件夹");
  const search = String(query).toLocaleLowerCase();
  const entries = (await readdir(resolved.target, { withFileTypes: true }))
    .filter((entry) => !entry.name.startsWith(".") && !isSystemFolder(entry.name) && !entry.isSymbolicLink() && (entry.isDirectory() || entry.isFile()) && entry.name.toLocaleLowerCase().includes(search))
    .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name, "zh-CN", { numeric: true }));
  const pageSize = 100;
  const currentPage = Math.min(Math.max(0, Math.floor(Number(page) || 0)), Math.max(0, Math.ceil(entries.length / pageSize) - 1));
  const items = await Promise.all(entries.slice(currentPage * pageSize, (currentPage + 1) * pageSize).map(async (entry) => {
    try {
      const target = path.join(resolved.target, entry.name);
      const details = await lstat(target);
      if (details.isSymbolicLink()) return null;
      return { name: entry.name, type: entry.isDirectory() ? "folder" : "file", size: entry.isDirectory() ? null : details.size, modifiedAt: details.mtime.toISOString(), relativePath: toBrowserPath(path.relative(resolved.root, target)) };
    } catch { return null; }
  }));
  return { path: resolved.relativePath, rootLabel: path.basename(resolved.root) || resolved.root, rootPath: resolved.root, total: entries.length, page: currentPage, pageSize, entries: items.filter(Boolean) };
}

export async function listDiskFolders(root) {
  const resolved = await resolveDiskEntry(root);
  const entries = await readdir(resolved.target, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && !entry.name.startsWith(".") && !isSystemFolder(entry.name))
    .sort((a, b) => a.name.localeCompare(b.name, "zh-CN", { numeric: true }))
    .map((entry) => ({ name: entry.name, relativePath: entry.name }));
}

export function validateEntryName(value) {
  const name = String(value || "");
  if (!name || name !== name.trim() || name === "." || name === ".." || name.startsWith(".") || /[<>:"/\\|?*\u0000-\u001f]/.test(name) || /[. ]$/.test(name)) throw fail("名称不能为空，也不能包含特殊符号、首尾空格或末尾句点");
  if (name.length > 255 || /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(name) || isSystemFolder(name)) throw fail("该名称不能用于文件或文件夹，请换一个名称");
  return name;
}

export async function createDiskFolder(root, parent, name) {
  const resolved = await resolveDiskEntry(root, parent);
  if (!(await lstat(resolved.target)).isDirectory()) throw fail("请在文件夹内创建新文件夹");
  const target = path.join(resolved.target, validateEntryName(name));
  try { await mkdir(target); }
  catch (error) {
    if (error.code === "EEXIST") throw fail("此目录已有同名文件或文件夹，请换一个名称", 409);
    throw error;
  }
  return { relativePath: toBrowserPath(path.relative(resolved.root, target)) };
}

export async function renameDiskEntry(root, relative, name, archiveDirectory) {
  const source = await resolveDiskEntry(root, relative);
  if (source.target === source.root) throw fail("不能重命名硬盘根目录");
  const destination = path.join(path.dirname(source.target), validateEntryName(name));
  if (destination === source.target) return { from: source.target, to: destination };
  const sourceDetails = await lstat(source.target);
  const archiveReal = archiveDirectory ? await realpath(archiveDirectory).catch(() => path.resolve(archiveDirectory)) : null;
  if (archiveReal && sourceDetails.isDirectory() && insideRoot(source.target, archiveReal)) throw fail("这是当前归档目录或它的上级文件夹，请先更换归档位置再重命名", 409);
  try {
    await lstat(destination);
    throw fail("已有同名文件或文件夹，无法覆盖，请换一个名称", 409);
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  await rename(source.target, destination);
  return { from: source.target, to: destination };
}

export const WINDOWS_FOLDER_PICKER_SCRIPT = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.Application]::EnableVisualStyles()
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$owner = New-Object System.Windows.Forms.Form
try {
  $dialog.Description = $env:COURSE_ARCHIVE_PICKER_DESCRIPTION
  $dialog.ShowNewFolderButton = $true
  $dialog.RootFolder = [System.Environment+SpecialFolder]::MyComputer
  if ($env:COURSE_ARCHIVE_PICKER_START) { $dialog.SelectedPath = $env:COURSE_ARCHIVE_PICKER_START }
  $owner.TopMost = $true
  $owner.ShowInTaskbar = $false
  $owner.Opacity = 0
  $owner.Size = New-Object System.Drawing.Size(1, 1)
  $owner.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen
  $owner.Show()
  $owner.Activate()
  if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) {
    [Console]::Write($dialog.SelectedPath)
  }
} finally { $dialog.Dispose(); $owner.Dispose() }
`;

export async function chooseNativeDirectory(initialPath = "", description = "请选择移动硬盘或硬盘中的归档文件夹") {
  if (process.platform !== "win32") throw fail("请在 Windows 电脑运行课夹，才能打开 Windows 系统文件夹选择窗口", 501);
  const command = "powershell.exe";
  const args = ["-NoProfile", "-STA", "-EncodedCommand", Buffer.from(WINDOWS_FOLDER_PICKER_SCRIPT, "utf16le").toString("base64")];
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, env: { ...process.env, COURSE_ARCHIVE_PICKER_START: initialPath, COURSE_ARCHIVE_PICKER_DESCRIPTION: description }, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let errors = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (part) => { output += part; });
    child.stderr.on("data", (part) => { errors += part; });
    child.on("error", () => reject(fail("无法打开系统文件夹选择窗口，请确认本机服务可调用系统组件", 500)));
    child.on("close", (code) => code === 0 ? resolve(output.trim()) : reject(fail(`系统选择窗口未完成：${errors.trim() || "请重试"}`, 500)));
  });
}
