// Shared by the browser and Node tests. Only filenames and existing library
// columns participate; file contents and imported parent paths are ignored.
const normalize = (value) => String(value).normalize("NFKC").toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const compact = (value) => normalize(value).replaceAll(" ", "");
const meaningful = (value) => compact(value).length >= 2 && !/^\d+$/.test(compact(value));

function folderKeywords(name) {
  const full = String(name).normalize("NFKC").replace(/^(?:\d+[\s._、\-]+)+/u, "");
  const subject = full.replace(/(?:课程资料|学习资料|教学资料|课程材料|资料|材料|文件夹|文件|课程|课件|讲义|作业|报告)+$/u, "").trim();
  return [...new Set([full, ...(meaningful(subject) ? [subject] : [])].filter(meaningful))];
}

function containsKeyword(stem, keyword) {
  const needle = compact(keyword);
  const haystack = compact(stem);
  const normalizedStem = normalize(stem);
  const positions = normalizedStem.split("").map((letter, index) => letter === " " ? -1 : index).filter((index) => index >= 0);
  let offset = haystack.indexOf(needle);
  while (offset !== -1) {
    // Latin words must not match inside another word (Java / JavaScript).
    // Keep separators for these boundary checks while allowing Web_Design.
    const before = normalizedStem[positions[offset] - 1] || "";
    const after = normalizedStem[positions[offset + needle.length - 1] + 1] || "";
    if ((!/^[a-z0-9]/.test(needle) || !/[a-z]/.test(before)) && (!/[a-z]$/.test(needle) || !/[a-z]/.test(after))) return true;
    offset = haystack.indexOf(needle, offset + 1);
  }
  return false;
}

export function matchFilename(filename, folders) {
  const basename = String(filename).split(/[\\/]/).pop();
  const dot = basename.lastIndexOf(".");
  const stem = dot > 0 ? basename.slice(0, dot) : basename;
  const candidates = folders.flatMap((folder) => {
    const keywords = folderKeywords(folder.name).filter((keyword) => containsKeyword(stem, keyword));
    if (!keywords.length) return [];
    keywords.sort((left, right) => compact(right).length - compact(left).length);
    return [{ ...folder, keyword: keywords[0] }];
  });
  // A more specific subject wins over its substring (高等数学 / 数学), but
  // different subjects and indistinguishable columns require a choice.
  const strongest = candidates.filter((candidate) => !candidates.some((other) => {
    const keyword = compact(candidate.keyword);
    const otherKeyword = compact(other.keyword);
    return otherKeyword.length > keyword.length && otherKeyword.includes(keyword);
  }));
  if (strongest.length === 1) {
    const match = strongest[0];
    return { kind: "matched", directory: match.relativePath, reason: `自动匹配：文件名包含「${match.keyword}」`, candidates: strongest };
  }
  if (strongest.length > 1) return { kind: "ambiguous", directory: null, reason: `多个匹配：${strongest.map((folder) => folder.name).join("、")}，请选择目标`, candidates: strongest };
  return { kind: "unmatched", directory: null, reason: folders.length ? "未找到匹配的栏目，请选择目标文件夹" : "还没有资料库栏目，请先新增栏目或手动选择目标", candidates: [] };
}
