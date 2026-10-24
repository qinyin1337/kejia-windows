// Local recognition only: filenames and existing columns, never file contents.
const normalize = (value) => String(value).normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}+#]+/gu, " ").trim();
const compact = (value) => normalize(value).replaceAll(" ", "");
const meaningful = (value) => compact(value).length >= 2 && !/^\d+$/.test(compact(value));
const endings = /(?:课程资料|学习资料|教学资料|课程材料|资料|材料|文件夹|文件|课程|课件|讲义|作业|报告)+$/u;
const generic = new Set(["资料", "学习", "教学", "课程", "文件", "材料", "课件", "讲义", "作业", "报告", "合集", "期末", "期中", "复习", "练习", "试卷", "答案"]);
const segmenter = new Intl.Segmenter("zh-CN", { granularity: "word" });
// Deliberately bounded aliases: unrelated short words are never fuzzy matched.
const subjects = [
  ["高等数学", "高数", "higher mathematics", "advanced mathematics", "calculus", "微积分"],
  ["线性代数", "线代", "linear algebra"],
  ["概率论", "概率统计", "概率与统计", "概率论与数理统计", "probability", "probability theory"],
  ["大学物理", "大物", "college physics"],
  ["数学", "math", "maths", "mathematics"],
  ["英语", "英文", "english"], ["语文", "国文", "chinese language"],
  ["物理", "physics"], ["化学", "chemistry"], ["生物", "biology"],
  ["历史", "history"], ["地理", "geography"], ["政治", "思政", "politics"],
  ["计算机", "电脑", "computer science", "computing"],
  ["数据结构", "data structures", "data structure"],
  ["操作系统", "operating systems", "operating system"],
  ["计算机网络", "计网", "computer networks", "computer network"],
  ["数据库", "database", "databases"], ["软件工程", "software engineering"],
  ["人工智能", "ai", "artificial intelligence"], ["机器学习", "machine learning"],
  ["深度学习", "deep learning"], ["网页设计", "web design"],
  ["经济学", "economics"], ["管理学", "management"], ["会计", "accounting"]
];
const documentKinds = [
  ["考试", "考试资料", "试卷", "试题", "真题", "测验", "exam", "exams", "quiz"],
  ["课件", "课件讲义", "讲义", "幻灯片", "slides", "slide", "presentation"],
  ["作业", "作业报告", "习题", "练习", "homework", "assignment", "assignments"],
  ["合同", "协议", "contract", "agreement"], ["发票", "invoice", "收据", "receipt"],
  ["简历", "个人简历", "resume", "résumé", "curriculum vitae"]
];

function folderKeywords(name) {
  const full = String(name).normalize("NFKC").replace(/^(?:\d+[\s._、\-]+)+/u, "");
  const subject = full.replace(endings, "").trim();
  return [...new Set([full, ...(meaningful(subject) ? [subject] : [])].filter(meaningful))];
}

function containsKeyword(stem, keyword) {
  const needle = compact(keyword);
  const haystack = compact(stem);
  const normalizedStem = normalize(stem);
  const positions = [...normalizedStem].flatMap((letter, index) => letter === " " ? [] : [index]);
  let offset = haystack.indexOf(needle);
  while (offset !== -1) {
    const before = normalizedStem[positions[offset] - 1] || "";
    const after = normalizedStem[positions[offset + needle.length - 1] + 1] || "";
    // Keep Java distinct from JavaScript; allow years and Chinese separators.
    if ((!/^[a-z]/.test(needle) || !/[a-z]/.test(before)) && (!/[a-z]$/.test(needle) || !/[a-z]/.test(after))) return true;
    offset = haystack.indexOf(needle, offset + 1);
  }
  return false;
}

function concepts(text, dictionary) {
  const found = dictionary.flatMap(([id, ...aliases]) => {
    const alias = [id, ...aliases].find((term) => containsKeyword(text, term));
    return alias ? [{ id, alias }] : [];
  });
  return found.filter((entry) => !found.some((other) => other.id !== entry.id && other.id.includes(entry.id)));
}

function tokens(text, keepSingle = false) {
  return [...segmenter.segment(normalize(text))].filter((part) => part.isWordLike)
    .map((part) => part.segment).filter((word) => (meaningful(word) || (keepSingle && /\p{Script=Han}/u.test(word))) && !generic.has(word));
}

function oneEditApart(a, b) {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0, j = 0, edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (!edits && a.length === b.length && a[i] === b[j + 1] && a[i + 1] === b[j]) return a.slice(i + 2) === b.slice(j + 2);
    if (++edits > 1) return false;
    if (a.length >= b.length) i++;
    if (b.length >= a.length) j++;
  }
  return edits + Number(i < a.length || j < b.length) === 1;
}

function typoMatch(stem, keyword) {
  const topic = compact(keyword);
  // A single typo in a two-character course would confuse 数学 and 化学.
  if (topic.length < 4 || topic.length > 48 || /\d/.test(topic) || generic.has(topic)) return false;
  const parts = tokens(stem, true);
  for (let start = 0; start < parts.length; start++) {
    let value = "";
    for (let end = start; end < parts.length && value.length <= topic.length + 1; end++) {
      value += parts[end];
      if (oneEditApart(topic, value)) return true;
    }
  }
  return false;
}

export function createFilenameClassifier(folders) {
  // Compile column topics once per batch, avoiding repeated segmentation.
  const library = folders.map((folder) => ({
    ...folder, keywords: folderKeywords(folder.name),
    subjects: concepts(folder.name, subjects), kinds: concepts(folder.name, documentKinds)
  }));
  return (filename) => {
    const basename = String(filename).split(/[\\/]/).pop();
    const dot = basename.lastIndexOf(".");
    const stem = dot > 0 ? basename.slice(0, dot) : basename;
    const fileSubjects = concepts(stem, subjects);
    const fileKinds = concepts(stem, documentKinds);
    let candidates = library.flatMap((folder) => {
      const direct = folder.keywords.filter((keyword) => containsKeyword(stem, keyword)).sort((a, b) => compact(b).length - compact(a).length)[0];
      const shared = folder.subjects.filter((topic) => fileSubjects.some((entry) => entry.id === topic.id));
      if (direct) return [{ ...folder, keyword: direct, score: 3, topic: shared.map((entry) => entry.id).join(" ") || direct, reason: `文件名包含「${direct}」` }];
      if (shared.length && shared.length === folder.subjects.length) {
        const alias = fileSubjects.filter((entry) => shared.some((topic) => topic.id === entry.id)).map((entry) => entry.alias).join("、");
        return [{ ...folder, keyword: shared[0].id, topic: shared.map((entry) => entry.id).join(" "), score: 3, reason: `「${alias}」与「${folder.name}」属于同一主题` }];
      }
      const reordered = folder.keywords.find((keyword) => {
        const words = tokens(keyword);
        return words.length >= 2 && words.every((word) => containsKeyword(stem, word));
      });
      if (reordered) return [{ ...folder, keyword: reordered, topic: reordered, score: 2, reason: `识别到「${tokens(reordered).join("、")}」，词序可不同` }];
      const kind = !folder.subjects.length && folder.kinds.find((entry) => fileKinds.some((file) => file.id === entry.id));
      if (kind) return [{ ...folder, keyword: kind.id, topic: kind.id, score: 1, reason: `识别为${kind.id}类资料` }];
      const similar = folder.keywords.find((keyword) => typoMatch(stem, keyword));
      if (similar) return [{ ...folder, keyword: similar, topic: similar, score: 0, reason: `名称与「${similar}」近似，请核对目标` }];
      return [];
    });
    // Specific subjects supersede their own general subject. Different subjects
    // remain ambiguous, including one literal name plus one semantic alias.
    const hasSubject = candidates.some((entry) => entry.subjects.length);
    if (hasSubject) candidates = candidates.filter((entry) => entry.subjects.length || !entry.kinds.length);
    const strong = candidates.filter((entry) => entry.score >= 2);
    if (strong.length) candidates = strong;
    const strongest = candidates.filter((candidate) => !candidates.some((other) => {
      const topic = compact(candidate.topic);
      const otherTopic = compact(other.topic);
      return otherTopic.length > topic.length && otherTopic.includes(topic);
    }));
    if (strongest.length === 1) {
      const match = strongest[0];
      return { kind: "matched", directory: match.relativePath, reason: `智能匹配：${match.reason}`, candidates: strongest };
    }
    if (strongest.length > 1) return { kind: "ambiguous", directory: null, reason: `多个匹配：${strongest.map((folder) => folder.name).join("、")}，请选择目标`, candidates: strongest };
    return { kind: "unmatched", directory: null, reason: folders.length ? "未找到可靠匹配，请选择目标文件夹" : "还没有资料库栏目，请先新增栏目或手动选择目标", candidates: [] };
  };
}

export const matchFilename = (filename, folders) => createFilenameClassifier(folders)(filename);
