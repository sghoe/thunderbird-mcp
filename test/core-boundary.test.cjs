"use strict";

// Core modules (extension/mcp_server/core) are pure: no XPCOM, file,
// network or browser globals, no imports. ESLint enforces this in `npm run
// lint`; this zero-dependency test enforces it in `npm test` and proves the
// modules load and run in plain Node, i.e. without Thunderbird.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const CORE_DIR = path.resolve(__dirname, "../extension/mcp_server/core");
const FORBIDDEN = [
  "globalThis", "window", "self", "global", "process", "require",
  "Components", "Services", "ChromeUtils", "Cc", "Ci", "Cu", "Cr",
  "IOUtils", "PathUtils", "MailServices", "NetUtil", "browser", "messenger",
  "fetch", "XMLHttpRequest", "WebSocket", "eval", "Function",
];

// Removes comments, string/template literals and regex literals so only
// code identifiers remain. Template ${...} expressions are kept as code.
function codeOnly(src) {
  let out = "";
  let i = 0;
  let lastSignificant = "";
  const regexAllowedAfter = new Set(["", "(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";", "return", "typeof"]);
  function readTemplate() {
    i++; // opening backtick
    while (i < src.length) {
      if (src[i] === "\\") { i += 2; continue; }
      if (src[i] === "`") { i++; return; }
      if (src[i] === "$" && src[i + 1] === "{") {
        i += 2;
        let depth = 1;
        let expr = "";
        while (i < src.length && depth) {
          if (src[i] === "{") depth++;
          else if (src[i] === "}") depth--;
          if (depth) expr += src[i];
          i++;
        }
        out += ` ${codeOnly(expr)} `;
        continue;
      }
      i++;
    }
  }
  while (i < src.length) {
    const c = src[i];
    if (c === "/" && src[i + 1] === "/") { while (i < src.length && src[i] !== "\n") i++; continue; }
    if (c === "/" && src[i + 1] === "*") { const end = src.indexOf("*/", i + 2); i = end < 0 ? src.length : end + 2; continue; }
    if (c === "'" || c === '"') {
      i++;
      while (i < src.length && src[i] !== c) i += src[i] === "\\" ? 2 : 1;
      i++;
      out += " \"\" ";
      lastSignificant = "str";
      continue;
    }
    if (c === "`") { readTemplate(); out += " \"\" "; lastSignificant = "str"; continue; }
    if (c === "/" && regexAllowedAfter.has(lastSignificant)) {
      i++;
      let inClass = false;
      while (i < src.length) {
        if (src[i] === "\\") { i += 2; continue; }
        if (src[i] === "[") inClass = true;
        else if (src[i] === "]") inClass = false;
        else if (src[i] === "/" && !inClass) break;
        i++;
      }
      i++;
      while (/[a-z]/i.test(src[i] || "")) i++;
      out += " /re/ ";
      lastSignificant = "re";
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      let word = "";
      while (/[\w$]/.test(src[i] || "")) word += src[i++];
      out += word;
      lastSignificant = word === "return" || word === "typeof" ? word : "id";
      continue;
    }
    if (!/\s/.test(c)) lastSignificant = c;
    out += c;
    i++;
  }
  return out;
}

const modules = fs.readdirSync(CORE_DIR).filter((f) => f.endsWith(".sys.mjs"));

describe("core module boundary", () => {
  it("has core modules to check", () => {
    assert.ok(modules.length >= 3, modules.join(", "));
  });

  for (const file of modules) {
    const source = fs.readFileSync(path.join(CORE_DIR, file), "utf8");
    const code = codeOnly(source);

    it(`${file} uses no XPCOM, file, network or host globals`, () => {
      for (const name of FORBIDDEN) {
        // Property access (obj.Services) and object keys are not globals.
        const use = new RegExp(`(^|[^.\\w$])${name.replace("$", "\\$")}(?![\\w$])(?!\\s*:)`, "m");
        assert.doesNotMatch(code, use, `${file} references ${name}`);
      }
    });

    it(`${file} is a leaf module (no imports or re-exports)`, () => {
      assert.doesNotMatch(code, /(^|[;\s])import(\s|\(|\{|\*)/m, `${file} imports other code`);
      assert.doesNotMatch(code, /export\s*(\*|\{[^}]*\}\s*from)/, `${file} re-exports other code`);
    });

    it(`${file} loads in plain Node`, async () => {
      const mod = await import(pathToFileURL(path.join(CORE_DIR, file)).href);
      assert.ok(Object.keys(mod).length > 0);
    });
  }

  it("the lexical check itself catches forbidden globals", () => {
    const code = codeOnly('const a = "Services"; // Services\nconst b = Services.prefs; const c = `x${Cc}`;');
    assert.match(code, /(^|[^.\w$])Services(?![\w$])/);
    assert.match(code, /(^|[^.\w$])Cc(?![\w$])/);
    assert.doesNotMatch(codeOnly('const s = "ChromeUtils" /* ChromeUtils */;'), /ChromeUtils/);
  });
});
