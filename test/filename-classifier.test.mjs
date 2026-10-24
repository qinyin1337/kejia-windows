import test from "node:test";
import assert from "node:assert/strict";
import { matchFilename } from "../public/filename-classifier.js";

const folders = (...names) => names.map((name) => ({ name, relativePath: name }));

test("Chinese subject filenames match existing library folders", () => {
  const library = folders("语文", "数学资料", "英语课件");
  assert.equal(matchFilename("数学_期中试卷.pdf", library).directory, "数学资料");
  assert.equal(matchFilename("2026英语作业.docx", library).directory, "英语课件");
  assert.equal(matchFilename("语文阅读.pdf", library).directory, "语文");
});

test("normalizes case, full width, separators and numbered columns", () => {
  assert.equal(matchFilename("WEB_design-2026.pdf", folders("01_Web Design资料")).directory, "01_Web Design资料");
  assert.equal(matchFilename("ｊａｖａ_实验.docx", folders("JAVA")).directory, "JAVA");
});

test("more specific subject wins over its own substring", () => {
  assert.equal(matchFilename("高等数学作业.pdf", folders("数学", "高等数学资料")).directory, "高等数学资料");
});

test("different subjects and indistinguishable columns need manual choice", () => {
  for (const [name, library] of [
    ["语文数学合集.zip", folders("语文", "数学")],
    ["数学作业.pdf", folders("数学资料", "数学课件")],
    ["Java SQL 综合报告.pdf", folders("Java", "SQL")]
  ]) {
    const match = matchFilename(name, library);
    assert.equal(match.kind, "ambiguous");
    assert.equal(match.directory, null);
    assert.equal(match.candidates.length, 2);
  }
});

test("no match never silently selects the root or creates a folder", () => {
  for (const [name, library] of [
    ["通知.pdf", folders("数学", "英语")],
    ["数学作业.docx", []],
    ["数学.docx", folders("资料", "01", "数")],
    ["简历.pdf", folders("PDF")]
  ]) {
    assert.equal(matchFilename(name, library).directory, null);
    assert.equal(matchFilename(name, library).kind, "unmatched");
  }
});

test("Latin subjects do not match inside other words", () => {
  const library = folders("Java", "JavaScript", "lab", "art");
  assert.equal(matchFilename("JavaScript实验.pdf", library).directory, "JavaScript");
  assert.equal(matchFilename("collaboration_start.pdf", library).kind, "unmatched");
  assert.equal(matchFilename("Java_报告.pdf", library).directory, "Java");
});

test("only basename participates, keeping imported directory names out", () => {
  assert.equal(matchFilename("数学/通知.pdf", folders("数学")).directory, null);
  assert.equal(matchFilename("数学\\通知.pdf", folders("数学")).directory, null);
});

test("recognizes course abbreviations and Chinese / English aliases", () => {
  for (const [filename, name] of [
    ["高数复习.pdf", "高等数学资料"], ["线代习题.pdf", "线性代数"],
    ["English作业.docx", "英语课件"], ["linear_algebra习题.pdf", "线性代数"],
    ["高等数学讲义.pdf", "高数"], ["AI导论.pdf", "人工智能"],
    ["电脑基础.txt", "计算机资料"], ["web design练习.pdf", "网页设计"]
  ]) assert.equal(matchFilename(filename, folders(name)).directory, name, filename);
  assert.equal(matchFilename("高数复习.pdf", folders("数学", "高等数学资料")).directory, "高等数学资料");
  assert.equal(matchFilename("高等数学讲义.pdf", folders("数学", "高数")).directory, "高数");
});

test("recognizes reordered topic words and one typo in a longer topic", () => {
  assert.equal(matchFilename("工程软件复习.pdf", folders("软件工程资料")).directory, "软件工程资料");
  assert.equal(matchFilename("软件工桯讲义.pdf", folders("软件工程资料")).directory, "软件工程资料");
  assert.equal(matchFilename("Softwrae Engineering笔记.pdf", folders("Software Engineering")).directory, "Software Engineering");
  assert.equal(matchFilename("专题2025.pdf", folders("专题2026")).kind, "unmatched");
  assert.equal(matchFilename("数学.pdf", folders("化学")).kind, "unmatched");
  assert.equal(matchFilename("软件工程.pdf", folders("软件工程", "软件工桯")).directory, "软件工程");
});

test("semantic ambiguity still requires a choice, even with one literal match", () => {
  for (const [filename, library] of [
    ["数学English合集.zip", folders("数学", "英语")],
    ["高数作业.pdf", folders("高等数学资料", "高数讲义")],
    ["软件工桯.pdf", folders("软件工程", "软件工呈")]
  ]) assert.equal(matchFilename(filename, library).kind, "ambiguous", filename);
  assert.equal(matchFilename("英语.pdf", folders("数学英语合集")).kind, "unmatched");
});

test("document synonyms are fallback destinations; subjects take priority", () => {
  assert.equal(matchFilename("employment_agreement.pdf", folders("合同资料")).directory, "合同资料");
  assert.equal(matchFilename("English_homework.docx", folders("作业报告", "英语课件")).directory, "英语课件");
  assert.equal(matchFilename("化学试卷.pdf", folders("考试资料")).directory, "考试资料");
  assert.equal(matchFilename("通知.pdf", folders("考试资料", "英语")).kind, "unmatched");
});

test("aliases respect Latin word boundaries and ignore extensions and parent names", () => {
  for (const name of ["chair.pdf", "email.pdf", "microbiology.pdf", "英语/通知.pdf", "通知.english"]) {
    assert.equal(matchFilename(name, folders("人工智能", "英语", "生物")).kind, "unmatched", name);
  }
});
