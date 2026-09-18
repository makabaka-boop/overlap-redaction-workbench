/**
 * 敏感短语遮蔽核心。
 *
 * 语义（长度一律按 UTF-16 代码单元计，与 JavaScript string 索引一致）：
 *  - 区分大小写；
 *  - 匹配不跨换行：模式经校验只含 U+0020..U+007E（本身不含换行），
 *    扫描遇到 U+000A 时自动机回到根节点，换行两侧不可能连成一次命中；
 *    换行符本身永不替换；
 *  - 属于任一完整匹配的代码单元替换为 "#"，其余字符原位保留；
 *  - 命中区间重叠时只取覆盖并集。
 *
 * 实现：Aho–Corasick 自动机（稀疏边 + 开寻址哈希）做一次扫描，
 * 在每个位置记录“在此结束的最长命中长度”；再自右向左合并相邻/重叠区间。
 * 总时间 O(文本长度 + 模式总长)，空间 O(文本长度 + 模式总长)，
 * 不生成命中区间数组，不按命中数展开。
 */

/** 文本允许的字符：换行 U+000A 或可打印 ASCII（U+0020..U+007E）。 */
export function isAllowedTextCode(code: number): boolean {
  return code === 0x0a || (code >= 0x20 && code <= 0x7e);
}

/** 模式允许的字符：可打印 ASCII（U+0020..U+007E，不含换行）。 */
export function isAllowedPatternCode(code: number): boolean {
  return code >= 0x20 && code <= 0x7e;
}

export interface RedactResult {
  /** 遮蔽后的文本，UTF-16 代码单元数与原文严格相等。 */
  output: string;
  /** 被遮蔽的代码单元数（覆盖并集大小）。 */
  coveredUnits: number;
  /** 构建自动机耗时（毫秒）。 */
  buildMs: number;
  /** 扫描、合并与生成输出耗时（毫秒）。 */
  scanMs: number;
}

interface Automaton {
  /** 每个节点的第一条出边（边下标），-1 表示无出边。 */
  head: Int32Array;
  /** 每条边：源节点、字符（UTF-16 代码单元）、目标节点、同节点下一条边。 */
  edgeFrom: Int32Array;
  edgeChar: Uint16Array;
  edgeTo: Int32Array;
  edgeNext: Int32Array;
  /** 失效链。 */
  fail: Int32Array;
  /** 节点上（含失效链传播）最长命中模式的长度，0 表示无命中。 */
  out: Int32Array;
  size: number;
  edgeCount: number;
  /** 开寻址哈希槽，存边下标，-1 为空。 */
  slot: Int32Array;
  slotMask: number;
}

function nextPow2(x: number): number {
  let p = 1;
  while (p < x) p <<= 1;
  return p;
}

function buildAutomaton(patterns: ReadonlyArray<string>): Automaton | null {
  if (patterns.length === 0) return null;

  const totalChars = patterns.reduce((s, p) => s + p.length, 0);
  const maxNodes = 1 + totalChars;
  const maxEdges = Math.max(totalChars, 1);
  const slotCap = nextPow2(maxEdges * 2 + 2);

  const a: Automaton = {
    head: new Int32Array(maxNodes).fill(-1),
    edgeFrom: new Int32Array(maxEdges),
    edgeChar: new Uint16Array(maxEdges),
    edgeTo: new Int32Array(maxEdges),
    edgeNext: new Int32Array(maxEdges),
    fail: new Int32Array(maxNodes),
    out: new Int32Array(maxNodes),
    size: 1,
    edgeCount: 0,
    slot: new Int32Array(slotCap).fill(-1),
    slotMask: slotCap - 1,
  };

  const lookup = (from: number, ch: number): number => {
    let s = hash(from, ch) & a.slotMask;
    let id = a.slot[s];
    while (id !== -1) {
      if (a.edgeFrom[id] === from && a.edgeChar[id] === ch) return a.edgeTo[id];
      s = (s + 1) & a.slotMask;
      id = a.slot[s];
    }
    return -1;
  };

  const addEdge = (from: number, ch: number, to: number): void => {
    const id = a.edgeCount++;
    a.edgeFrom[id] = from;
    a.edgeChar[id] = ch;
    a.edgeTo[id] = to;
    a.edgeNext[id] = a.head[from];
    a.head[from] = id;
    let s = hash(from, ch) & a.slotMask;
    while (a.slot[s] !== -1) s = (s + 1) & a.slotMask;
    a.slot[s] = id;
  };

  // 1. 构建 Trie。
  for (const p of patterns) {
    let v = 0;
    for (let i = 0; i < p.length; i++) {
      const ch = p.charCodeAt(i);
      let to = lookup(v, ch);
      if (to === -1) {
        to = a.size++;
        addEdge(v, ch, to);
      }
      v = to;
    }
    // 模式互不重复；同长度重复后缀无妨，取较大值。
    if (p.length > a.out[v]) a.out[v] = p.length;
  }

  // 2. BFS 构建失效链，并把失效链上的最长命中长度传播到当前节点。
  const queue = new Int32Array(a.size);
  let qh = 0;
  let qt = 0;
  for (let e = a.head[0]; e !== -1; e = a.edgeNext[e]) {
    queue[qt++] = a.edgeTo[e]; // 根子节点的 fail 默认为 0
  }
  while (qh < qt) {
    const v = queue[qh++];
    for (let e = a.head[v]; e !== -1; e = a.edgeNext[e]) {
      const ch = a.edgeChar[e];
      const child = a.edgeTo[e];
      let f = a.fail[v];
      let to = lookup(f, ch);
      while (to === -1 && f !== 0) {
        f = a.fail[f];
        to = lookup(f, ch);
      }
      a.fail[child] = to === -1 || to === child ? 0 : to;
      const inherited = a.out[a.fail[child]];
      if (inherited > a.out[child]) a.out[child] = inherited;
      queue[qt++] = child;
    }
  }
  return a;
}

function hash(from: number, ch: number): number {
  // 两个乘子均为 2^32 附近的素数/黄金分割常数，>>>0 归一为无符号 32 位。
  return ((from * 2654435761 + ch * 2246822519) >>> 0) ^ ((from + ch) | 0);
}

function now(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

/**
 * 对 text 执行遮蔽。
 * patterns 须已通过校验（1..50000 条、互不重复、非空、仅可打印 ASCII）。
 * 为空数组时原样返回。
 */
export function redact(text: string, patterns: ReadonlyArray<string>): RedactResult {
  const t0 = now();
  const a = buildAutomaton(patterns);
  const buildMs = now() - t0;

  const t1 = now();
  const n = text.length;
  if (!a || n === 0) {
    return { output: text, coveredUnits: 0, buildMs, scanMs: now() - t1 };
  }

  // 第一遍：扫描。mark[i] = 在位置 i 结束的最长命中长度，0 表示无命中。
  const mark = new Int32Array(n);
  let state = 0;
  for (let i = 0; i < n; i++) {
    const ch = text.charCodeAt(i);
    if (ch === 0x0a) {
      state = 0; // 不跨换行
      continue;
    }
    let to = lookup(a, state, ch);
    while (to === -1 && state !== 0) {
      state = a.fail[state];
      to = lookup(a, state, ch);
    }
    state = to === -1 ? 0 : to;
    mark[i] = a.out[state];
  }

  // 第二遍：自右向左合并命中区间的覆盖并集，同时写出结果代码单元。
  const out = new Uint16Array(n);
  let covered = 0;
  let runL = n + 1; // 已处理部分中当前连续覆盖段的左端（含）
  let runR = -1; // 右端（不含）
  for (let i = n - 1; i >= 0; i--) {
    const ch = text.charCodeAt(i);
    if (ch === 0x0a) {
      // 命中间隔不含换行，覆盖段不可能跨过换行。
      runL = n + 1;
      runR = -1;
      out[i] = 0x0a;
      continue;
    }
    const L = mark[i];
    let cov: boolean;
    if (L > 0) {
      const s = i + 1 - L;
      const e = i + 1;
      if (runR !== -1 && e >= runL) {
        if (s < runL) runL = s; // 与右侧覆盖段相接或重叠
      } else {
        runL = s;
        runR = e;
      }
      cov = i >= runL && i < runR;
    } else {
      cov = i >= runL && i < runR;
    }
    if (cov) {
      covered++;
      out[i] = 0x23; // '#'
    } else {
      out[i] = ch;
    }
  }

  // 分块把 UTF-16 代码单元解码为字符串（每块 32768，避免 apply 参数上限）。
  const CHUNK = 0x8000;
  const chunks: string[] = new Array(Math.ceil(n / CHUNK));
  for (let i = 0, b = 0; i < n; i += CHUNK, b++) {
    chunks[b] = String.fromCharCode.apply(
      null,
      out.subarray(i, Math.min(i + CHUNK, n)) as unknown as number[],
    );
  }

  return { output: chunks.join(""), coveredUnits: covered, buildMs, scanMs: now() - t1 };
}

function lookup(a: Automaton, from: number, ch: number): number {
  let s = hash(from, ch) & a.slotMask;
  let id = a.slot[s];
  while (id !== -1) {
    if (a.edgeFrom[id] === from && a.edgeChar[id] === ch) return a.edgeTo[id];
    s = (s + 1) & a.slotMask;
    id = a.slot[s];
  }
  return -1;
}
