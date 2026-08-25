import type { ParsedAddress } from "./types";

/** 实用正则子集（不追求全量 RFC 5322；带引号的极端形式不支持）。域名至少两段、段内禁连字符起止。 */
const EMAIL_RE =
  /^[A-Za-z0-9._%+-]+@[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$/;

/**
 * 解析「裸地址」或「Name <addr>」两种格式；不合法返回 null。
 * name 允许为空（`<a@b.com>`），含控制字符或 `<>` 则拒绝（防邮件头注入）。
 */
export function parseAddress(input: string): ParsedAddress | null {
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;

  let name: string | undefined;
  let address: string;
  const open = trimmed.indexOf("<");
  if (open === -1) {
    address = trimmed;
  } else {
    // 必须恰好以「[name] <addr>」收尾：仅一对尖括号且 > 在末尾
    if (trimmed.lastIndexOf(">") !== trimmed.length - 1) return null;
    if (trimmed.indexOf("<", open + 1) !== -1) return null;
    const inner = trimmed.slice(open + 1, trimmed.length - 1).trim();
    if (inner.length === 0 || inner.includes("<") || inner.includes(">")) return null;
    if (open > 0) {
      name = trimmed.slice(0, open).trim();
      if (/[<>\x00-\x1F\x7F]/.test(name)) return null;
      if (name.length === 0) name = undefined;
    }
    address = inner;
  }

  if (!EMAIL_RE.test(address)) return null;
  return name === undefined ? { address } : { name, address };
}

export interface PreparedRecipients {
  to: ParsedAddress[];
  cc: ParsedAddress[];
  bcc: ParsedAddress[];
}

/** to > cc > bcc 跨组去重 + 组内去重；比较键 = 地址小写；保留首次出现的写法（含其名称）。 */
export function prepareRecipients(
  to: ParsedAddress[],
  cc: ParsedAddress[],
  bcc: ParsedAddress[],
): PreparedRecipients {
  const seen = new Set<string>();
  const dedupe = (list: ParsedAddress[]): ParsedAddress[] => {
    const out: ParsedAddress[] = [];
    for (const a of list) {
      const key = a.address.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(a);
    }
    return out;
  };
  return { to: dedupe(to), cc: dedupe(cc), bcc: dedupe(bcc) };
}
