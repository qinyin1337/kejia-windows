import { matchFilename } from "./filename-classifier.js";

const CATEGORY_NAMES = {
  courses: "课程资料",
  assignments: "作业报告",
  slides: "课件讲义",
  exams: "考试资料",
  personal: "个人材料",
  other: "其他"
};
const state = {
  status: { configured: false, connected: false, drivePath: "", rootPath: "" },
  files: [],
  selectedCategory: "all",
  query: "",
  sort: "newest",
  page: 0,
  pending: [],
  queuePage: 0,
  autoClassify: true,
  matching: false,
  uploadRunning: false,
  scanRunning: false,
  view: "disk",
  library: { folders: [], error: "", requestId: 0 },
  disk: { path: "", query: "", page: 0, data: null, loading: false, error: "", requestId: 0 },
  pickingDirectory: false,
  pickingBrowse: false,
  nameOperation: null
};

const $ = (selector) => document.querySelector(selector);
const escapeHTML = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
})[character]);

function formatSize(value) {
  const size = Number(value) || 0;
  if (size < 1024) return `${size} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let amount = size;
  let unit = -1;
  do { amount /= 1024; unit += 1; } while (amount >= 1024 && unit < units.length - 1);
  return `${amount.toFixed(amount >= 10 ? 0 : 1)} ${units[unit]}`;
}

function formatDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  const now = new Date();
  const sameDay = date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate();
  if (sameDay) return `今天 ${new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" }).format(date)}`;
  return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric" }).format(date);
}

function fileType(filename) {
  const extension = String(filename).split(".").pop().toLowerCase();
  if (extension === "pdf") return ["PDF", "type-pdf"];
  if (["ppt", "pptx", "key"].includes(extension)) return ["PPT", "type-ppt"];
  if (["doc", "docx", "rtf", "txt", "md"].includes(extension)) return ["DOC", "type-doc"];
  if (["xls", "xlsx", "csv"].includes(extension)) return ["XLS", "type-xls"];
  if (["zip", "rar", "7z", "tar", "gz"].includes(extension)) return ["ZIP", "type-zip"];
  if (["jpg", "jpeg", "png", "gif", "webp", "heic"].includes(extension)) return ["IMG", "type-img"];
  return [extension ? extension.slice(0, 4).toUpperCase() : "FILE", "type-file"];
}

function showToast(message, type = "", duration = 3500) {
  const toast = document.createElement("div");
  toast.className = `toast ${type}`.trim();
  toast.textContent = message;
  $("#toastRegion").append(toast);
  window.setTimeout(() => toast.remove(), duration);
}

function updateConnection() {
  $("#openAllFolders").innerHTML = "在文件资源管理器打开归档 <span>↗</span>";
  $("#searchShortcut").textContent = "Ctrl K";
  const connected = state.status.connected;
  const label = connected ? "移动硬盘已就绪" : state.status.configured ? "硬盘未连接" : "设置硬盘目录";
  $("#connectionText").textContent = state.pickingDirectory ? "正在选择文件夹…" : label;
  $("#connectTop").classList.toggle("connected", connected);
  $("#sidebarConnection").textContent = connected ? "已就绪" : state.status.configured ? "未连接" : "未设置";
  $("#sidebarConnection").style.color = connected ? "#4ca88e" : "";
  $("#storageHint").textContent = connected ? state.status.drivePath : state.status.error || "设置归档目录后查看索引文件";
  $("#storageHint").title = connected ? state.status.drivePath : "";
  const banner = $("#connectionBanner");
  banner.classList.toggle("hidden", state.view === "disk" || connected || sessionStorage.getItem("bannerDismissed") === "1");
  if (!connected) {
    if (!state.status.configured) {
      $("#bannerTitle").textContent = "先设置移动硬盘归档目录";
      $("#bannerMessage").textContent = "选择需要建立索引的文件夹，课夹会读取其中的文件。";
      $("#bannerConnect").textContent = "设置目录 →";
    } else {
      $("#bannerTitle").textContent = "移动硬盘暂时不可用";
      $("#bannerMessage").textContent = state.status.error || "请连接移动硬盘，或检查已设置的目录。";
      $("#bannerConnect").textContent = "检查目录 →";
    }
  }
  $("#connectSidebar").innerHTML = connected ? "管理目录 <span>→</span>" : "设置目录 <span>→</span>";
  $("#connectTop").title = connected ? `归档目录：${state.status.drivePath}` : label;
  for (const id of ["connectTop", "connectSidebar", "bannerConnect"]) $(`#${id}`).disabled = state.pickingDirectory || state.pickingBrowse || state.matching;
}

function updateStats() {
  const totalSize = state.files.reduce((sum, item) => sum + (Number(item.size) || 0), 0);
  const categories = state.library.folders;
  $("#statFiles").innerHTML = `${state.files.length}<span class="stat-unit"> 个文件</span>`;
  $("#statSize").innerHTML = `${escapeHTML(formatSize(totalSize))}<span class="stat-unit"></span>`;
  $("#statCategories").innerHTML = `${categories.length}<span class="stat-unit"> 个栏目</span>`;
  $("#allCount").textContent = state.files.length;
}

function renderLibrary() {
  const nav = $("#folderNav");
  const scrollTop = $(".main-nav").scrollTop;
  $("#addColumnButton").disabled = !state.status.browser?.connected || state.pickingDirectory || state.pickingBrowse || state.matching;
  if (!state.status.browser?.connected) {
    nav.innerHTML = '<div class="library-empty">选择硬盘或目录后，自动识别文件夹栏目。<button type="button" data-library-pick>选择硬盘</button></div>';
  } else if (state.library.error) {
    nav.innerHTML = `<div class="library-empty">${escapeHTML(state.library.error)}<button type="button" data-library-refresh>重新读取</button></div>`;
  } else {
    nav.innerHTML = state.library.folders.map((folder) => `<button class="nav-item ${state.view === "disk" && (state.disk.path === folder.relativePath || state.disk.path.startsWith(folder.relativePath + "/")) ? "active" : ""}" type="button" data-library-folder="${escapeHTML(folder.relativePath)}" title="${escapeHTML(folder.name)}"><span class="nav-icon drive-icon">▰</span><span class="library-folder-name">${escapeHTML(folder.name)}</span></button>`).join("") || '<div class="library-empty">还没有文件夹，点击资料库旁的“＋”新增栏目。</div>';
  }
  $(".main-nav").scrollTop = scrollTop;
}

function renderFolders() {
  $("#folderGrid").innerHTML = state.library.folders.map((folder) => `<button class="folder-card" data-folder="${escapeHTML(folder.relativePath)}" title="打开 ${escapeHTML(folder.name)}"><span class="folder-color folder-courses">▰</span><span class="folder-title">${escapeHTML(folder.name)}</span><span class="folder-count">打开文件夹 · 投递资料</span></button>`).join("");
  $(".folders-section").hidden = !state.library.folders.length;
}

async function loadLibrary() {
  const requestId = ++state.library.requestId;
  const root = state.status.browseRoot;
  if (!state.status.browser?.connected) {
    state.library.folders = [];
    state.library.error = "";
    renderLibrary();
    renderFolders();
    return;
  }
  try {
    const data = await apiRequest(`/api/library?${new URLSearchParams({ browseRoot: root })}`, { cache: "no-store" });
    if (requestId !== state.library.requestId || root !== state.status.browseRoot) return;
    state.library.folders = data.folders;
    state.library.error = "";
  } catch (error) {
    if (requestId !== state.library.requestId || root !== state.status.browseRoot) return;
    state.library.folders = [];
    state.library.error = error.message;
  }
  renderLibrary();
  renderFolders();
  updateStats();
}

function openLibraryFolder(relativePath) {
  state.view = "disk";
  updateCurrentSection();
  enterDirectory(relativePath);
}

function addLibraryColumn() {
  if (!state.status.browser?.connected) return chooseBrowseLocation();
  editEntryName(null, true);
}

function filteredFiles() {
  const query = state.query.trim().toLocaleLowerCase();
  const files = state.files.filter((file) => {
    const inCategory = state.selectedCategory === "all" || file.category === state.selectedCategory;
    const matches = !query || `${file.filename} ${file.relativePath || ""} ${file.categoryLabel || ""}`.toLocaleLowerCase().includes(query);
    return inCategory && matches;
  });
  if (state.sort === "name") files.sort((a, b) => a.filename.localeCompare(b.filename, "zh-CN"));
  else if (state.sort === "size") files.sort((a, b) => (b.size || 0) - (a.size || 0));
  else files.sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));
  return files;
}

function renderFileList() {
  const categoryName = state.selectedCategory === "all" ? "最近整理" : CATEGORY_NAMES[state.selectedCategory];
  $("#filesHeading").textContent = state.query ? "搜索结果" : categoryName;
  $("#filesSubheading").textContent = state.query ? `包含“${state.query}”的文件` : "刚整理好的文件都在这里";
  const files = filteredFiles();
  if (!files.length) {
    const title = state.query ? "没有找到匹配的文件" : state.status.connected ? "这里还没有文件" : "设置归档目录后查看索引";
    const subtitle = state.query ? "试试其他关键词" : state.status.connected ? "选择资料复制到移动硬盘，或扫描硬盘上的已有文件" : "选择移动硬盘上的文件夹作为归档位置";
    $("#fileList").innerHTML = `<div class="empty-state"><span class="empty-graphic">▱</span><strong>${escapeHTML(title)}</strong><span>${escapeHTML(subtitle)}</span></div>`;
    return;
  }
  const pageSize = 50;
  const pageCount = Math.ceil(files.length / pageSize);
  state.page = Math.max(0, Math.min(state.page, pageCount - 1));
  const first = state.page * pageSize;
  const shown = files.slice(first, first + pageSize);
  $("#fileList").innerHTML = `
    <div class="list-header"><span>文件名称</span><span>所在文件夹</span><span>文件大小</span><span>修改时间</span><span></span></div>
    ${shown.map((file) => {
      const [label, typeClass] = fileType(file.filename);
      const category = file.relativePath?.replaceAll("\\", "/").split("/").slice(0, -1).join("/") || file.categoryLabel || "根目录";
      const displayPath = file.relativePath || `${category}/${file.filename}`;
      return `<div class="file-row">
        <div class="file-name-cell"><span class="file-type-icon ${typeClass}">${escapeHTML(label)}</span><span class="filename-copy"><strong title="${escapeHTML(file.filename)}">${escapeHTML(file.filename)}</strong><small title="${escapeHTML(displayPath)}">${escapeHTML(displayPath)}</small></span></div>
        <span><span class="file-category">${escapeHTML(category)}</span></span>
        <span class="file-size">${escapeHTML(formatSize(file.size))}</span>
        <span class="file-date">${escapeHTML(formatDate(file.uploadedAt))}</span>
        <button class="file-open" data-open-id="${escapeHTML(file.id)}">定位 ↗</button>
      </div>`;
    }).join("")}
    ${pageCount > 1 ? `<div class="list-pagination"><span>显示 ${first + 1}–${Math.min(first + pageSize, files.length)} 项，共 ${files.length} 项</span><div><button type="button" data-page="prev" ${state.page === 0 ? "disabled" : ""}>上一页</button><span>${state.page + 1} / ${pageCount}</span><button type="button" data-page="next" ${state.page + 1 >= pageCount ? "disabled" : ""}>下一页</button></div></div>` : ""}
  `;
}

function updateCurrentSection() {
  updateConnection();
  const name = state.view === "disk" ? state.disk.path.split("/").filter(Boolean).pop() || "硬盘总览" : "归档记录";
  $("#currentSection").textContent = name;
  document.querySelectorAll(".nav-item[data-category]").forEach((button) => {
    button.classList.toggle("active", state.view === "archive" && button.dataset.category === state.selectedCategory);
  });
  $("#diskNav").classList.toggle("active", state.view === "disk" && !state.disk.path);
  renderLibrary();
  $("#archiveView").hidden = state.view !== "archive";
  $("#diskView").hidden = state.view !== "disk";
  $("#welcomeTitle").textContent = state.view === "disk" ? state.disk.path.split("/").filter(Boolean).pop() || "文件夹有序，投递轻松。" : "归档记录";
  $("#welcomeDescription").textContent = state.view === "disk" ? "左侧栏目对应硬盘文件夹，选择后即可查看和投递资料。" : "查看归档目录中的文件索引，重新扫描可同步外部改动。";
  $("#searchInput").placeholder = state.view === "disk" ? "搜索当前文件夹…" : "搜索文件名或路径…";
}

function render() {
  updateConnection();
  updateStats();
  renderFolders();
  renderFileList();
  updateCurrentSection();
  renderQueue();
  if (state.view === "disk") renderDiskBrowser();
}

async function refresh() {
  const [statusResult, filesResult] = await Promise.allSettled([
    fetch("/api/status", { cache: "no-store" }).then((response) => response.json()),
    fetch("/api/files", { cache: "no-store" }).then((response) => response.json())
  ]);
  if (statusResult.status === "fulfilled") {
    if (state.status.browseRoot !== statusResult.value.browseRoot) {
      state.disk.requestId += 1;
      state.disk.path = "";
      state.disk.query = "";
      state.disk.page = 0;
      state.disk.data = null;
      if (state.view === "disk") $("#searchInput").value = "";
    }
    state.status = statusResult.value;
  }
  if (filesResult.status === "fulfilled" && Array.isArray(filesResult.value.files)) state.files = filesResult.value.files;
  await loadLibrary();
  render();
  if (state.view === "disk") await loadDisk();
}

async function apiRequest(url, options = {}) {
  const response = await fetch(url, options);
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "操作失败，请重试");
  return result;
}

function selectArchive(category = "all") {
  state.view = "archive";
  state.selectedCategory = category;
  state.page = 0;
  $("#searchInput").value = state.query;
  renderFileList();
  updateCurrentSection();
}

function showDisk() {
  openLibraryFolder("");
}

async function loadDisk() {
  const requestId = ++state.disk.requestId;
  if (!state.status.browser?.connected) {
    state.disk.data = null;
    state.disk.loading = false;
    state.disk.error = "";
    renderDiskBrowser();
    return;
  }
  state.disk.loading = true;
  state.disk.error = "";
  renderDiskBrowser();
  try {
    const params = new URLSearchParams({ path: state.disk.path, query: state.disk.query, page: String(state.disk.page), browseRoot: state.status.browseRoot });
    const data = await apiRequest(`/api/disk?${params}`, { cache: "no-store" });
    if (requestId !== state.disk.requestId) return;
    state.disk.data = data;
    state.disk.path = data.path;
    state.disk.page = data.page;
  } catch (error) {
    if (requestId !== state.disk.requestId) return;
    state.disk.data = null;
    state.disk.error = error.message;
  } finally {
    if (requestId === state.disk.requestId) {
      state.disk.loading = false;
      renderDiskBrowser();
    }
  }
}

function enterDirectory(relativePath) {
  state.disk.path = relativePath;
  state.disk.page = 0;
  state.disk.query = "";
  $("#searchInput").value = "";
  updateCurrentSection();
  loadDisk();
}

function renderDiskBrowser() {
  const disk = state.disk;
  const data = disk.data;
  updateDeliveryTarget();
  const picking = state.pickingBrowse || state.pickingDirectory;
  $("#newFolderButton").disabled = !state.status.browser?.connected || disk.loading || picking;
  $("#diskRefresh").disabled = disk.loading || picking;
  $("#chooseBrowseButton").disabled = picking;
  $("#chooseBrowseButton").textContent = state.pickingBrowse ? "正在选择…" : "选择浏览位置";
  $("#browseArchiveButton").hidden = !state.status.configured;
  $("#browseArchiveButton").disabled = !state.status.connected || picking;
  $("#diskRootLabel").textContent = state.status.browseRoot ? `浏览位置：${state.status.browseRoot}` : "选择要查看的硬盘或文件夹";
  const segments = disk.path.split("/").filter(Boolean);
  $("#diskBreadcrumbs").innerHTML = `<button type="button" data-enter-path="">▣ ${escapeHTML(data?.rootLabel || "硬盘")}</button>${segments.map((name, index) => `<span>/</span><button type="button" data-enter-path="${escapeHTML(segments.slice(0, index + 1).join("/"))}">${escapeHTML(name)}</button>`).join("")}${segments.length ? `<button class="disk-up" type="button" data-enter-path="${escapeHTML(segments.slice(0, -1).join("/"))}">↑ 返回上一级</button>` : ""}`;
  if (!state.status.browser?.connected) {
    $("#diskList").innerHTML = `<div class="empty-state"><span class="empty-graphic">▣</span><strong>${state.status.browser?.configured ? "当前浏览位置不可用" : "选择要查看的硬盘或目录"}</strong><span>${escapeHTML(state.status.browser?.error || "选择整个硬盘或一个文件夹，查看其中的文件")}</span><button class="choose-button" type="button" data-pick-browse ${picking ? "disabled" : ""}>选择浏览位置</button></div>`;
    return;
  }
  if (disk.loading) { $("#diskList").innerHTML = '<div class="empty-state"><strong>正在读取硬盘目录…</strong></div>'; return; }
  if (disk.error) { $("#diskList").innerHTML = `<div class="empty-state"><strong>${escapeHTML(disk.error)}</strong><button class="choose-button" type="button" data-enter-path="">返回硬盘根目录</button></div>`; return; }
  const entries = data?.entries || [];
  if (!entries.length) {
    $("#diskList").innerHTML = `<div class="empty-state"><span class="empty-graphic">▱</span><strong>${disk.query ? "当前文件夹没有匹配文件" : "这个文件夹还是空的"}</strong><span>${disk.query ? "试试其他名称，或清空搜索" : "点击“新建文件夹”开始投递目录"}</span></div>`;
    return;
  }
  const pageCount = Math.max(1, Math.ceil(data.total / data.pageSize));
  $("#diskList").innerHTML = `<div class="disk-list-header"><span>名称</span><span>大小</span><span>修改时间</span><span>操作</span></div>${entries.map((entry) => {
    const [label, iconClass] = entry.type === "folder" ? ["▰", "disk-folder-icon"] : fileType(entry.name);
    return `<div class="disk-row"><button class="disk-entry-name" type="button" ${entry.type === "folder" ? `data-enter-path="${escapeHTML(entry.relativePath)}"` : `data-disk-reveal="${escapeHTML(entry.relativePath)}"`} title="${escapeHTML(entry.name)}"><span class="file-type-icon ${iconClass}">${escapeHTML(label)}</span><span>${escapeHTML(entry.name)}</span>${entry.type === "folder" ? '<small>文件夹</small>' : ""}</button><span class="disk-size">${entry.type === "folder" ? "—" : escapeHTML(formatSize(entry.size))}</span><span class="disk-date">${escapeHTML(formatDate(entry.modifiedAt))}</span><div class="disk-row-actions"><button type="button" data-rename-path="${escapeHTML(entry.relativePath)}" aria-label="重命名 ${escapeHTML(entry.name)}">重命名</button><button type="button" data-disk-reveal="${escapeHTML(entry.relativePath)}">定位 ↗</button></div></div>`;
  }).join("")}<div class="list-pagination"><span>${data.total} 个项目</span>${pageCount > 1 ? `<div><button type="button" data-disk-page="prev" ${disk.page === 0 ? "disabled" : ""}>上一页</button><span>${disk.page + 1} / ${pageCount}</span><button type="button" data-disk-page="next" ${disk.page + 1 >= pageCount ? "disabled" : ""}>下一页</button></div>` : ""}</div>`;
}

function editEntryName(entry = null, column = false) {
  if (!state.status.browser?.connected) return chooseBrowseLocation();
  state.nameOperation = { entry, parent: column ? "" : state.disk.path, browseRoot: state.status.browseRoot, column };
  $("#nameDialogTitle").textContent = entry ? "重命名" : column ? "新增栏目" : "新建文件夹";
  $("#nameContext").textContent = entry ? `正在修改：${entry.name}` : `创建位置：${column ? state.status.browseRoot : state.disk.path || state.disk.data?.rootLabel || "硬盘根目录"}`;
  $("#nameHint").textContent = entry?.type === "file" ? "请保留正确的文件扩展名；修改会直接保存到硬盘。" : "名称会直接保存到当前硬盘目录。";
  $("#entryNameInput").value = entry?.name || (column ? "新栏目" : "新建文件夹");
  $("#nameError").hidden = true;
  $("#nameDialog").showModal();
  const input = $("#entryNameInput");
  input.focus();
  const extensionStart = entry?.type === "file" ? entry.name.lastIndexOf(".") : -1;
  input.setSelectionRange(0, extensionStart > 0 ? extensionStart : input.value.length);
}

async function saveEntryName(event) {
  event.preventDefault();
  const operation = state.nameOperation;
  if (!operation) return;
  const button = $("#saveEntryName");
  button.disabled = true;
  $("#nameError").hidden = true;
  try {
    const result = await apiRequest(operation.entry ? "/api/disk/rename" : "/api/disk/folder", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: operation.entry?.relativePath || operation.parent, name: $("#entryNameInput").value, browseRoot: operation.browseRoot })
    });
    $("#nameDialog").close();
    if (operation.column) { state.view = "disk"; state.disk.path = result.relativePath; state.disk.query = ""; state.disk.page = 0; }
    showToast(result.warning || (operation.entry ? "名称已修改" : "文件夹已创建"), result.warning ? "error" : "success");
    await refresh();
  } catch (error) {
    $("#nameError").textContent = error.message;
    $("#nameError").hidden = false;
  } finally { button.disabled = false; }
}

async function revealDiskEntry(relativePath) {
  try { await apiRequest("/api/disk/reveal", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: relativePath, browseRoot: state.status.browseRoot }) }); }
  catch (error) { showToast(error.message, "error"); }
}

function updateDeliveryTarget() {
  const ready = state.status.browser?.connected && !state.disk.loading && !state.disk.error && !state.pickingBrowse && !state.pickingDirectory;
  const separator = state.status.platform === "win32" ? "\\" : "/";
  const root = (state.status.browseRoot || "").replace(/[\\/]$/, "");
  $("#deliveryTarget").textContent = ready ? state.autoClassify ? "按文件名匹配左侧资料库栏目，确认去向后开始投递" : `投递到：${root}${separator}${state.disk.path.split("/").join(separator)}` : "先选择硬盘或目录";
  $("#autoClassify").disabled = state.uploadRunning || state.matching;
  $("#rematchFiles").disabled = !ready || state.uploadRunning || state.matching || !state.pending.length;
  $("#rematchFiles").textContent = state.matching ? "正在匹配…" : "重新自动匹配";
  for (const id of ["chooseFiles", "chooseFolder", "sidebarUpload"]) $(`#${id}`).disabled = !ready || state.uploadRunning || state.matching;
  $("#dropzone").classList.toggle("unavailable", !ready);
  $("#dropzone").setAttribute("aria-disabled", String(!ready));
}

function folderOptions(item) {
  if (item.browseRoot !== state.status.browseRoot) return `<option>原浏览位置 / ${escapeHTML(item.directory ?? "待选择")}</option>`;
  const choices = new Map([["", "当前硬盘或目录的根目录"], ...state.library.folders.map((folder) => [folder.relativePath, folder.name])]);
  if (!choices.has(item.defaultDirectory)) choices.set(item.defaultDirectory, item.defaultDirectory);
  if (item.directory !== null && !choices.has(item.directory)) choices.set(item.directory, item.directory);
  return `<option value="" disabled ${item.directory === null ? "selected" : ""}>请选择目标文件夹</option>` + [...choices].map(([value, label]) => `<option value="${escapeHTML(value)}" ${value === item.directory ? "selected" : ""}>${escapeHTML(label)}</option>`).join("");
}

function classifyItem(item) {
  if (state.library.error) {
    item.directory = null;
    item.matchReason = "无法读取资料库，请刷新后重新匹配或手动选择目标";
    item.matchKind = "unmatched";
    return;
  }
  const match = matchFilename(item.file.name, state.library.folders);
  item.directory = match.directory;
  item.matchReason = match.reason;
  item.matchKind = match.kind;
}

async function addFiles(fileList, directory = state.disk.path) {
  const files = Array.from(fileList || []);
  if (!files.length) return;
  if (state.uploadRunning || state.matching) return showToast("请等待当前投递或匹配完成", "error");
  if (!state.status.browser?.connected || state.pickingBrowse || state.pickingDirectory || state.disk.loading || state.disk.error) return showToast("请先选择可访问的硬盘文件夹", "error");
  const root = state.status.browseRoot;
  if (state.autoClassify) {
    state.matching = true;
    updateDeliveryTarget();
    renderQueue();
    try { await loadLibrary(); }
    finally { state.matching = false; updateDeliveryTarget(); }
    if (root !== state.status.browseRoot) return showToast("浏览位置已变化，请重新加入文件", "error");
  }
  for (const file of files) {
    const item = { id: crypto.randomUUID(), file, directory, defaultDirectory: directory, browseRoot: state.status.browseRoot, progress: 0, status: "待投递", failed: false, manual: false, matchKind: "current", matchReason: "投递到加入队列时的文件夹" };
    if (state.autoClassify) classifyItem(item);
    state.pending.push(item);
  }
  state.view = "disk";
  state.queuePage = 0;
  updateCurrentSection();
  updateDeliveryTarget();
  renderQueue();
  $("#uploadPanel").scrollIntoView({ behavior: "smooth", block: "center" });
}

async function rematchPending() {
  if (state.uploadRunning || state.matching || !state.status.browser?.connected) return;
  const root = state.status.browseRoot;
  state.autoClassify = true;
  $("#autoClassify").checked = true;
  state.matching = true;
  updateDeliveryTarget();
  renderQueue();
  try {
    await loadLibrary();
    if (root !== state.status.browseRoot) return;
    for (const item of state.pending) {
      if (item.browseRoot !== root || item.manual) continue;
      classifyItem(item);
      item.status = "待投递";
      item.failed = false;
    }
    const first = state.pending.findIndex((item) => item.directory === null);
    state.queuePage = first < 0 ? 0 : Math.floor(first / 30);
    showToast(state.library.error || "已按最新栏目重新匹配；手动选择的目标已保留", state.library.error ? "error" : "success");
  } finally {
    state.matching = false;
    updateDeliveryTarget();
    renderQueue();
  }
}

function renderQueue() {
  const queue = $("#uploadQueue");
  queue.hidden = state.pending.length === 0;
  $("#rematchFiles").disabled = !state.status.browser?.connected || state.uploadRunning || state.matching || !state.pending.length;
  if (!state.pending.length) { queue.replaceChildren(); return; }
  const unresolved = state.pending.filter((item) => item.directory === null).length;
  const pages = Math.ceil(state.pending.length / 30);
  state.queuePage = Math.max(0, Math.min(state.queuePage, pages - 1));
  const visibleItems = state.pending.slice(state.queuePage * 30, (state.queuePage + 1) * 30);
  const busy = state.uploadRunning || state.matching;
  queue.innerHTML = visibleItems.map((item) => {
    const [label, typeClass] = fileType(item.file.name);
    return `<div class="queue-item ${item.directory === null ? "needs-target" : ""}" data-queue-id="${item.id}">
      <div class="queue-file"><span class="file-type-icon ${typeClass}">${escapeHTML(label)}</span><span class="queue-file-copy"><strong title="${escapeHTML(item.file.name)}">${escapeHTML(item.file.name)}</strong><small>${escapeHTML(formatSize(item.file.size))}${item.file.webkitRelativePath ? ` · ${escapeHTML(item.file.webkitRelativePath)}` : ""}</small></span></div>
      <select aria-label="${escapeHTML(item.file.name)} 的目标文件夹" data-queue-directory="${item.id}" ${busy || item.browseRoot !== state.status.browseRoot ? "disabled" : ""}>${folderOptions(item)}</select>
      <button class="queue-remove" type="button" data-remove-queue="${item.id}" aria-label="移除文件" ${busy ? "disabled" : ""}>×</button>
      <div class="queue-match ${item.directory === null ? "queue-warning" : ""}">${escapeHTML(item.matchReason)}</div>
      ${item.status === "正在复制" ? `<div class="queue-progress"><span style="width:${item.progress}%"></span></div>` : ""}
      ${item.status !== "待投递" ? `<div class="queue-status ${item.failed ? "queue-error" : ""}">${escapeHTML(item.status)}</div>` : ""}
    </div>`;
  }).join("") + (pages > 1 ? `<div class="list-pagination"><span>共 ${state.pending.length} 个文件</span><div><button type="button" data-queue-page="prev" ${state.queuePage === 0 ? "disabled" : ""}>上一页</button><span>${state.queuePage + 1} / ${pages}</span><button type="button" data-queue-page="next" ${state.queuePage + 1 >= pages ? "disabled" : ""}>下一页</button></div></div>` : "") + `<div class="queue-actions"><span role="status">${state.pending.length} 个待投递文件 · ${unresolved ? `${unresolved} 个待选择目标` : "目标已全部确认"}</span>${unresolved ? '<button type="button" data-find-unresolved>查看待选择</button>' : ""}<button type="button" id="uploadNow" ${busy || unresolved ? "disabled" : ""}>${state.uploadRunning ? "正在投递…" : "开始投递"}</button></div>`;
}

function updateQueueItem(item, { status = item.status, progress = item.progress, failed = item.failed } = {}) {
  item.status = status;
  item.progress = progress;
  item.failed = failed;
  const row = document.querySelector(`[data-queue-id="${CSS.escape(item.id)}"]`);
  if (!row) return renderQueue();
  row.querySelector(".queue-status")?.remove();
  row.querySelector(".queue-progress")?.remove();
  if (status === "正在复制") row.insertAdjacentHTML("beforeend", `<div class="queue-progress"><span style="width:${Math.max(0, Math.min(100, progress))}%"></span></div>`);
  if (status !== "待投递") row.insertAdjacentHTML("beforeend", `<div class="queue-status ${failed ? "queue-error" : ""}">${escapeHTML(status)}</div>`);
  if (failed) {
    const remove = row.querySelector(".queue-remove");
    if (remove) remove.disabled = false;
  }
}

function archiveFile(item) {
  return new Promise((resolve) => {
    const request = new XMLHttpRequest();
    request.open("POST", `/api/disk/upload?${new URLSearchParams({ path: item.directory, browseRoot: item.browseRoot })}`);
    request.setRequestHeader("content-type", "application/octet-stream");
    request.setRequestHeader("x-file-name", encodeURIComponent(item.file.name));
    request.upload.onprogress = (event) => {
      const progress = event.lengthComputable ? Math.round(event.loaded / event.total * 100) : 0;
      const status = progress >= 100 ? "已复制，正在更新索引…" : `正在复制到移动硬盘 ${progress}%`;
      updateQueueItem(item, { status: progress >= 100 ? status : "正在复制", progress, failed: false });
    };
    request.onload = async () => {
      let payload = {};
      try { payload = JSON.parse(request.responseText); } catch {}
      if (request.status >= 200 && request.status < 300) {
        if (payload.file) state.files.unshift(payload.file);
        state.pending = state.pending.filter((entry) => entry.id !== item.id);
        renderQueue();
        render();
        showToast(`${payload.filename || payload.file?.filename || item.file.name} 已投递到 ${item.directory || "根目录"}`, "success");
        resolve(true);
      } else {
        updateQueueItem(item, { status: payload.error || "整理失败，可重试", failed: true });
        resolve(false);
      }
    };
    request.onerror = () => {
      updateQueueItem(item, { status: "连接中断，可重新整理", failed: true });
      resolve(false);
    };
    request.onabort = () => {
      updateQueueItem(item, { status: "复制已取消", failed: true });
      resolve(false);
    };
    updateQueueItem(item, { status: "正在复制", progress: 0, failed: false });
    request.send(item.file);
  });
}

async function uploadPending() {
  if (state.uploadRunning || state.matching || !state.pending.length) return;
  if (state.pending.some((item) => item.directory === null)) return showToast("请先为未匹配或有多个匹配的文件选择目标文件夹", "error");
  if (!state.status.browser?.connected) {
    showToast("请先连接硬盘并选择投递位置", "error", 5000);
    chooseBrowseLocation();
    return;
  }
  if (state.pickingBrowse || state.pickingDirectory || state.scanRunning) return showToast("请等待当前操作完成", "error");
  if (state.pending.some((item) => item.browseRoot !== state.status.browseRoot)) return showToast("队列中有其他硬盘的文件，请返回原浏览位置，或移除这些文件后重新选择", "error", 6000);
  state.uploadRunning = true;
  updateDeliveryTarget();
  renderQueue();
  const snapshot = [...state.pending];
  for (const item of snapshot) {
    if (!state.pending.some((entry) => entry.id === item.id)) continue;
    const success = await archiveFile(item);
    if (!success) showToast(`${item.file.name} 整理失败：${item.status}`, "error", 5000);
  }
  state.uploadRunning = false;
  renderQueue();
  await refresh();
}

async function showPathDialog() {
  if (state.pickingDirectory || state.pickingBrowse) return;
  if (state.uploadRunning || state.scanRunning || state.matching) return showToast("请等待当前文件整理或扫描完成", "error");
  state.pickingDirectory = true;
  updateConnection();
  try {
    const result = await apiRequest("/api/choose-drive-path", { method: "POST" });
    if (result.cancelled) return;
    state.disk.path = "";
    state.disk.page = 0;
    state.disk.query = "";
    state.disk.data = null;
    if (state.view === "disk") $("#searchInput").value = "";
    await refresh();
    showToast("归档位置已选择，正在读取已有文件…", "success");
    await scanArchive({ quiet: true });
  } catch (error) {
    showToast(error.message || "无法打开系统选择窗口", "error", 6000);
  } finally {
    state.pickingDirectory = false;
    updateConnection();
    if (state.view === "disk") renderDiskBrowser();
  }
}

async function chooseBrowseLocation(useArchive = false) {
  if (state.pickingDirectory || state.pickingBrowse) return;
  if (state.uploadRunning || state.scanRunning || state.matching) return showToast("请等待当前文件整理或扫描完成", "error");
  state.pickingBrowse = true;
  updateConnection();
  renderDiskBrowser();
  try {
    const result = await apiRequest(useArchive ? "/api/browse-archive" : "/api/choose-browse-path", { method: "POST" });
    if (result.cancelled) return;
    state.disk.requestId += 1;
    state.disk.path = "";
    state.disk.page = 0;
    state.disk.query = "";
    state.disk.data = null;
    if (state.view === "disk") $("#searchInput").value = "";
    await refresh();
    showToast("浏览位置已切换", "success");
  } catch (error) {
    showToast(error.message || "无法选择浏览位置", "error", 6000);
  } finally {
    state.pickingBrowse = false;
    updateConnection();
    if (state.view === "disk") renderDiskBrowser();
  }
}

async function scanArchive({ quiet = false } = {}) {
  if (!state.status.connected) {
    showToast("请先连接移动硬盘并设置归档目录", "error");
    showPathDialog();
    return;
  }
  if (state.scanRunning) return;
  state.scanRunning = true;
  updateScanButton("正在开始扫描…", true);
  try {
    const response = await fetch("/api/scan", { method: "POST" });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "扫描无法开始");
    let latest = {};
    do {
      await new Promise((resolve) => window.setTimeout(resolve, 900));
      const statusResponse = await fetch("/api/scan-status", { cache: "no-store" });
      latest = await statusResponse.json();
      updateScanButton(`正在扫描 · ${latest.scanned || 0} 个文件`, true);
    } while (latest.running);
    await refresh();
    if (latest.error) showToast(`扫描中断：${latest.error}`, "error", 6000);
    else if (!quiet) showToast(`扫描完成，已索引 ${latest.scanned || 0} 个文件`, "success");
    if (latest.errors?.length) showToast(`有 ${latest.errors.length} 个项目无法读取`, "error", 5000);
  } catch (error) {
    showToast(error.message || "扫描失败", "error", 5000);
  } finally {
    state.scanRunning = false;
    updateScanButton("扫描归档目录", false);
  }
}

function updateScanButton(label, disabled) {
  const button = $("#scanButton");
  button.textContent = label;
  button.disabled = disabled;
}

async function revealFile(id) {
  if (!state.status.connected) {
    showToast("请连接移动硬盘后再定位文件", "error");
    return;
  }
  try {
    const response = await fetch("/api/reveal", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "无法定位文件");
  } catch (error) {
    showToast(error.message || "无法定位文件", "error", 5000);
  }
}

async function revealRoot() {
  if (!state.status.connected) {
    showPathDialog();
    return;
  }
  try {
    const response = await fetch("/api/reveal-root", { method: "POST" });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "无法打开归档目录");
  } catch (error) {
    showToast(error.message || "无法打开归档目录", "error", 5000);
  }
}

function setDate() {
  const now = new Date();
  $("#todayLabel").textContent = new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric", weekday: "long" }).format(now);
  $("#clockLabel").textContent = new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" }).format(now);
}

function setupEvents() {
  $("#chooseFiles").addEventListener("click", (event) => { event.stopPropagation(); $("#fileInput").click(); });
  $("#chooseFolder").addEventListener("click", (event) => { event.stopPropagation(); $("#folderInput").click(); });
  $("#fileInput").addEventListener("change", (event) => { addFiles(event.target.files); event.target.value = ""; });
  $("#folderInput").addEventListener("change", (event) => { addFiles(event.target.files); event.target.value = ""; });
  $("#sidebarUpload").addEventListener("click", () => { state.view = "disk"; updateCurrentSection(); $("#fileInput").click(); });
  $("#dropzone").addEventListener("click", (event) => { if (!event.target.closest("button") && $("#dropzone").getAttribute("aria-disabled") !== "true") $("#fileInput").click(); });
  $("#dropzone").addEventListener("keydown", (event) => { if ((event.key === "Enter" || event.key === " ") && $("#dropzone").getAttribute("aria-disabled") !== "true") { event.preventDefault(); $("#fileInput").click(); } });
  for (const name of ["dragenter", "dragover"]) $("#dropzone").addEventListener(name, (event) => { event.preventDefault(); $("#dropzone").classList.add("dragover"); });
  for (const name of ["dragleave", "drop"]) $("#dropzone").addEventListener(name, (event) => { event.preventDefault(); $("#dropzone").classList.remove("dragover"); });
  $("#dropzone").addEventListener("drop", (event) => addFiles(event.dataTransfer.files));
  document.querySelectorAll(".nav-item[data-category]").forEach((button) => button.addEventListener("click", () => selectArchive(button.dataset.category)));
  $("#folderGrid").addEventListener("click", (event) => { const button = event.target.closest("[data-folder]"); if (button) openLibraryFolder(button.dataset.folder); });
  $("#diskNav").addEventListener("click", showDisk);
  $("#addColumnButton").addEventListener("click", addLibraryColumn);
  $("#folderNav").addEventListener("click", (event) => {
    const folder = event.target.closest("[data-library-folder]");
    if (folder) return openLibraryFolder(folder.dataset.libraryFolder);
    if (event.target.closest("[data-library-pick]")) { state.view = "disk"; updateCurrentSection(); return chooseBrowseLocation(); }
    if (event.target.closest("[data-library-refresh]")) refresh();
  });
  $("#diskRefresh").addEventListener("click", () => refresh());
  $("#chooseBrowseButton").addEventListener("click", () => chooseBrowseLocation());
  $("#browseArchiveButton").addEventListener("click", () => chooseBrowseLocation(true));
  $("#newFolderButton").addEventListener("click", () => editEntryName());
  $("#nameForm").addEventListener("submit", saveEntryName);
  for (const id of ["nameDialogClose", "nameCancel"]) $(`#${id}`).addEventListener("click", () => $("#nameDialog").close());
  $("#diskView").addEventListener("click", (event) => {
    const enter = event.target.closest("[data-enter-path]");
    if (enter) return enterDirectory(enter.dataset.enterPath);
    if (event.target.closest("[data-pick-browse]")) return chooseBrowseLocation();
    const rename = event.target.closest("[data-rename-path]");
    if (rename) {
      const entry = state.disk.data?.entries.find((item) => item.relativePath === rename.dataset.renamePath);
      if (entry) editEntryName(entry);
      return;
    }
    const reveal = event.target.closest("[data-disk-reveal]");
    if (reveal) return revealDiskEntry(reveal.dataset.diskReveal);
    const page = event.target.closest("[data-disk-page]");
    if (page) { state.disk.page += page.dataset.diskPage === "next" ? 1 : -1; loadDisk(); }
  });
  $("#fileList").addEventListener("click", (event) => {
    const open = event.target.closest("[data-open-id]");
    if (open) revealFile(open.dataset.openId);
    const pageButton = event.target.closest("[data-page]");
    if (pageButton) { state.page += pageButton.dataset.page === "next" ? 1 : -1; renderFileList(); }
  });
  $("#openRoot").addEventListener("click", revealRoot);
  $("#openAllFolders").addEventListener("click", revealRoot);
  let diskSearchTimer;
  $("#searchInput").addEventListener("input", (event) => {
    if (state.view === "disk") {
      state.disk.query = event.target.value;
      state.disk.page = 0;
      window.clearTimeout(diskSearchTimer);
      diskSearchTimer = window.setTimeout(() => { if (state.view === "disk") loadDisk(); }, 250);
    } else { state.query = event.target.value; state.page = 0; renderFileList(); }
  });
  $("#sortSelect").addEventListener("change", (event) => { state.sort = event.target.value; state.page = 0; renderFileList(); });
  $("#connectTop").addEventListener("click", showPathDialog);
  $("#connectSidebar").addEventListener("click", showPathDialog);
  $("#bannerConnect").addEventListener("click", showPathDialog);
  $("#bannerClose").addEventListener("click", () => { $("#connectionBanner").classList.add("hidden"); sessionStorage.setItem("bannerDismissed", "1"); });
  $("#scanButton").addEventListener("click", () => scanArchive());
  $("#helpButton").addEventListener("click", () => $("#helpDialog").showModal());
  $("#autoClassify").addEventListener("change", (event) => {
    if (state.uploadRunning || state.matching) return;
    state.autoClassify = event.target.checked;
    if (state.autoClassify) return rematchPending();
    for (const item of state.pending) {
      if (item.manual || item.browseRoot !== state.status.browseRoot) continue;
      item.directory = item.defaultDirectory;
      item.matchKind = "current";
      item.matchReason = "投递到加入队列时的文件夹";
      item.status = "待投递";
      item.failed = false;
    }
    updateDeliveryTarget();
    renderQueue();
  });
  $("#rematchFiles").addEventListener("click", rematchPending);
  $("#uploadQueue").addEventListener("change", (event) => {
    const select = event.target.closest("[data-queue-directory]");
    if (!select) return;
    const item = state.pending.find((entry) => entry.id === select.dataset.queueDirectory);
    if (item && !state.uploadRunning && !state.matching && item.browseRoot === state.status.browseRoot) {
      item.directory = select.value;
      item.manual = true;
      item.matchKind = "manual";
      item.matchReason = "手动选择的目标";
      item.status = "待投递";
      item.failed = false;
      renderQueue();
    }
  });
  $("#uploadQueue").addEventListener("click", (event) => {
    const remove = event.target.closest("[data-remove-queue]");
    if (remove && !state.uploadRunning && !state.matching) {
      state.pending = state.pending.filter((item) => item.id !== remove.dataset.removeQueue);
      renderQueue();
      return;
    }
    const page = event.target.closest("[data-queue-page]");
    if (page) { state.queuePage += page.dataset.queuePage === "next" ? 1 : -1; renderQueue(); return; }
    if (event.target.closest("[data-find-unresolved]")) {
      state.queuePage = Math.floor(state.pending.findIndex((item) => item.directory === null) / 30);
      renderQueue();
      $(".needs-target select")?.focus();
      return;
    }
    if (event.target.closest("#uploadNow")) uploadPending();
  });
  document.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") { event.preventDefault(); $("#searchInput").focus(); }
    if (event.key === "Escape" && $("#helpDialog").open) $("#helpDialog").close();
  });
}

setupEvents();
setDate();
refresh().catch(() => showToast("无法连接网站服务，请确认服务正在运行", "error"));

window.setInterval(() => { if (!document.hidden && !state.uploadRunning && !state.pickingBrowse && !state.pickingDirectory && !$("#nameDialog").open) loadLibrary(); }, 15000);
