// 隐私脱敏：Agent 提交的任何文本在入库前都会经过这里。
// 目标是挡住最常见的意外泄漏（手机号、邮箱、证件号、卡号、密钥、密码），
// 不是完美的 DLP。返回脱敏后的值和命中统计，让 Agent 知道哪些内容被改了。

const RULES = [
  { type: 'secret', label: '[密钥已隐藏]', re: /\b(?:sk-[A-Za-z0-9_-]{16,}|sk-ant-[A-Za-z0-9_-]{16,}|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{30,}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{30,}|cg_[a-f0-9]{32})\b/g },
  { type: 'password', label: null, re: /((?:password|passwd|pwd|密码|口令)\s*[:=：]\s*)(\S+)/gi },
  { type: 'email', label: '[邮箱已隐藏]', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g },
  { type: 'id_card', label: '[证件号已隐藏]', re: /(?<![\dA-Za-z])\d{17}[\dXx](?![\dA-Za-z])/g },
  { type: 'card', label: '[卡号已隐藏]', re: /(?<![\d-])(?:\d[ -]?){12,18}\d(?![\d-])/g, check: luhn },
  { type: 'phone', label: '[手机号已隐藏]', re: /(?<!\d)(?:\+?86[- ]?)?1[3-9]\d{9}(?!\d)/g },
];

function luhn(s) {
  const digits = s.replace(/\D/g, '');
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (dbl) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

export function redactText(text, counts = {}) {
  if (typeof text !== 'string' || !text) return text;
  let out = text;
  for (const rule of RULES) {
    out = out.replace(rule.re, (...m) => {
      const match = m[0];
      if (rule.check && !rule.check(match)) return match;
      counts[rule.type] = (counts[rule.type] || 0) + 1;
      if (rule.type === 'password') return `${m[1]}[已隐藏]`;
      return rule.label;
    });
  }
  return out;
}

// 深度遍历对象，所有字符串都脱敏。URL 字段只脱敏查询串，避免把链接改坏。
export function redactDeep(value) {
  const counts = {};
  const walk = (v, key) => {
    if (typeof v === 'string') {
      if (key === 'url') return redactUrl(v, counts);
      return redactText(v, counts);
    }
    if (Array.isArray(v)) return v.map((x) => walk(x, key));
    if (v && typeof v === 'object') {
      const o = {};
      for (const [k, x] of Object.entries(v)) o[k] = walk(x, k);
      return o;
    }
    return v;
  };
  const value2 = walk(value, null);
  return { value: value2, findings: Object.entries(counts).map(([type, count]) => ({ type, count })) };
}

function redactUrl(u, counts) {
  const q = u.indexOf('?');
  if (q < 0) return u;
  // 查询串里常带 token / email，直接整体脱敏
  return u.slice(0, q) + redactText(u.slice(q), counts).replace(/([?&][^=&]*(?:token|key|secret|sig|code|session)[^=&]*=)[^&#]*/gi, (_, p) => {
    counts.secret = (counts.secret || 0) + 1;
    return `${p}[已隐藏]`;
  });
}

// 疑似提示词注入 / 危险命令。命中后不拒收，而是打上标记，
// 让读取攻略的 Agent 和人类都能看到警告。
const INJECTION_PATTERNS = [
  [/ignore (?:all |any )?(?:previous|prior|above) (?:instructions|prompts)/i, '疑似提示词注入：要求忽略之前的指令'],
  [/(?:忽略|无视)(?:之前|以上|前面|先前)的?(?:所有)?(?:指令|提示|规则)/, '疑似提示词注入：要求忽略之前的指令'],
  [/system prompt|系统提示词/i, '提到了系统提示词'],
  [/(?:curl|wget)[^\n|]*\|\s*(?:sudo\s+)?(?:ba|z)?sh\b/i, '包含“下载后直接执行”的命令（curl | sh）'],
  [/rm\s+-rf\s+(?:\/|~|\$HOME)(?:\s|$)/i, '包含删除根目录或主目录的命令'],
  [/(?:send|post|upload|发送|上传)[^\n]{0,40}(?:api[_ ]?key|token|cookie|密钥|凭据)/i, '要求发送密钥或凭据'],
];

export function scanForRisks(value) {
  const flags = new Set();
  const walk = (v) => {
    if (typeof v === 'string') {
      for (const [re, msg] of INJECTION_PATTERNS) if (re.test(v)) flags.add(msg);
    } else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(value);
  return [...flags];
}
