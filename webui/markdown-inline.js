/**
 * 行内 Markdown 的线性扫描器：替代带嵌套量词的正则，避免超级线性回溯。
 * 只识别代码、粗体与链接三种行内元素，其余字符原样返回。
 */

function isSpace(ch) {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\f" || ch === "\v";
}

/** 扫描链接目标，允许一层括号；遇到空白/换行/第二层括号即放弃。 */
function scanLinkTarget(value, start) {
  if (start >= value.length) return null;
  let depth = 0;
  let buffer = "";
  for (let index = start; index < value.length; index += 1) {
    const ch = value.charAt(index);
    if (isSpace(ch)) return null;
    if (ch === "(") {
      if (depth >= 1) return null;
      depth += 1;
      buffer += ch;
      continue;
    }
    if (ch === ")") {
      if (depth === 0) return buffer.length ? { end: index + 1, href: buffer } : null;
      depth -= 1;
      buffer += ch;
      continue;
    }
    buffer += ch;
  }
  return null;
}

/**
 * 把一行文本切成 {kind:'text'|'code'|'strong'|'link', ...} 片段。
 * 时间复杂度 O(n)：每个字符最多被查看两次，不回退。
 */
export function splitInline(value) {
  const source = String(value ?? "");
  const tokens = [];
  let literal = "";
  const flush = () => {
    if (literal) {
      tokens.push({ kind: "text", text: literal });
      literal = "";
    }
  };
  let index = 0;
  while (index < source.length) {
    const ch = source.charAt(index);
    if (ch === "`") {
      const end = source.indexOf("`", index + 1);
      if (end > index + 1 && !source.slice(index + 1, end).includes("\n")) {
        flush();
        tokens.push({ kind: "code", text: source.slice(index + 1, end) });
        index = end + 1;
        continue;
      }
    } else if (ch === "*" && source.charAt(index + 1) === "*") {
      const end = source.indexOf("**", index + 2);
      if (end > index + 2) {
        const inner = source.slice(index + 2, end);
        if (!inner.includes("\n") && !inner.includes("*")) {
          flush();
          tokens.push({ kind: "strong", text: inner });
          index = end + 2;
          continue;
        }
      }
    } else if (ch === "[") {
      const labelEnd = source.indexOf("](", index + 1);
      if (labelEnd > index + 1) {
        const label = source.slice(index + 1, labelEnd);
        if (!label.includes("\n")) {
          const target = scanLinkTarget(source, labelEnd + 2);
          if (target) {
            flush();
            tokens.push({ kind: "link", label, href: target.href });
            index = target.end;
            continue;
          }
        }
      }
    }
    literal += ch;
    index += 1;
  }
  flush();
  return tokens;
}

/** 标题行：最多 3 个前导空白 + 1–6 个 # + 空白 + 文本；结尾的 # 与空白会被去掉。 */
export function parseHeading(line) {
  const source = String(line ?? "");
  let index = 0;
  while (index < source.length && index < 3 && isSpace(source.charAt(index))) index += 1;
  let level = 0;
  while (index < source.length && level < 6 && source.charAt(index) === "#") {
    level += 1;
    index += 1;
  }
  if (!level || index >= source.length || !isSpace(source.charAt(index))) return null;
  while (index < source.length && isSpace(source.charAt(index))) index += 1;
  let end = source.length;
  while (end > index && isSpace(source.charAt(end - 1))) end -= 1;
  while (end > index && source.charAt(end - 1) === "#") end -= 1;
  while (end > index && isSpace(source.charAt(end - 1))) end -= 1;
  if (end <= index) return null;
  return { level, text: source.slice(index, end) };
}

/** 列表项：前导空白 + 数字. / 数字) / - + *，后接空白与文本。 */
export function parseListItem(line) {
  const source = String(line ?? "");
  let index = 0;
  while (index < source.length && isSpace(source.charAt(index))) index += 1;
  let ordered = false;
  let start = 0;
  const first = source.charAt(index);
  if (first >= "0" && first <= "9") {
    let cursor = index;
    while (cursor < source.length && source.charAt(cursor) >= "0" && source.charAt(cursor) <= "9") cursor += 1;
    const marker = source.charAt(cursor);
    if (marker !== "." && marker !== ")") return null;
    start = Number(source.slice(index, cursor));
    ordered = true;
    index = cursor + 1;
  } else if (first === "-" || first === "+" || first === "*") {
    index += 1;
  } else {
    return null;
  }
  if (index >= source.length || !isSpace(source.charAt(index))) return null;
  while (index < source.length && isSpace(source.charAt(index))) index += 1;
  const text = source.slice(index);
  if (!text) return null;
  return { ordered, start, text };
}

/** 围栏代码块起始行。 */
export function isFence(line) {
  const source = String(line ?? "");
  let index = 0;
  while (index < source.length && isSpace(source.charAt(index))) index += 1;
  return source.startsWith("```", index);
}