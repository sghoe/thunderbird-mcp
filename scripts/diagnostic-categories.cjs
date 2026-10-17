#!/usr/bin/env node
"use strict";

// Keeps ERROR_CATEGORIES in core/diagnostic-log.sys.mjs in sync with the
// error literals in api.js. A category is the static text an error literal
// starts with, up to its first interpolation, quote, colon, parenthesis or
// escape – so it never contains a runtime value.
//
//   node scripts/diagnostic-categories.cjs --check   exit 1 if out of date
//   node scripts/diagnostic-categories.cjs --write   update the module

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const API = path.join(ROOT, "extension", "mcp_server", "api.js");
const MODULE = path.join(ROOT, "extension", "mcp_server", "core", "diagnostic-log.sys.mjs");
const BLOCK = /(\/\/ BEGIN ERROR CATEGORIES\r?\n)[\s\S]*?(\r?\n\/\/ END ERROR CATEGORIES)/;

const LITERAL = /(?:\bnew Error\(\s*|\berror:\s*)(`(?:[^`\\]|\\.)*`|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g;
const CATEGORY = /^[A-Za-z][A-Za-z0-9 ,./-]*$/;

function extractCategories(source) {
  const categories = new Set();
  for (const match of source.matchAll(LITERAL)) {
    const body = match[1].slice(1, -1);
    const cut = body.search(/\$\{|[:"'(`\\]| -- | \u2014 /);
    const head = (cut < 0 ? body : body.slice(0, cut)).replace(/[\s.,;!?-]+$/, "").trim();
    if (head.length >= 6 && CATEGORY.test(head)) categories.add(head);
  }
  return [...categories].sort();
}

function renderBlock(categories, eol) {
  const lines = ["export const ERROR_CATEGORIES = Object.freeze(["];
  for (const category of categories) lines.push(`  ${JSON.stringify(category)},`);
  lines.push("]);");
  return lines.join(eol);
}

function expectedModule() {
  const current = fs.readFileSync(MODULE, "utf8");
  if (!BLOCK.test(current)) throw new Error("ERROR CATEGORIES block not found in diagnostic-log.sys.mjs");
  const eol = current.includes("\r\n") ? "\r\n" : "\n";
  const block = renderBlock(extractCategories(fs.readFileSync(API, "utf8")), eol);
  return { current, expected: current.replace(BLOCK, (_, begin, end) => `${begin}${block}${end}`) };
}

if (require.main === module) {
  const mode = process.argv[2];
  const { current, expected } = expectedModule();
  if (mode === "--write") {
    if (current !== expected) fs.writeFileSync(MODULE, expected);
    console.log("diagnostic categories up to date");
  } else if (mode === "--check") {
    if (current !== expected) {
      console.error("diagnostic categories are out of date: run node scripts/diagnostic-categories.cjs --write");
      process.exit(1);
    }
    console.log("diagnostic categories up to date");
  } else {
    console.error("usage: diagnostic-categories.cjs --check | --write");
    process.exit(2);
  }
}

module.exports = { extractCategories, expectedModule };
