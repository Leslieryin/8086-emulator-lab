/**
 * 8086 汇编子集解析器（MASM 风格）
 *
 * 不做机器码编码——直接把源码解析成「指令对象列表」，由 cpu.js 逐条执行。
 * 这样做的取舍：
 *   + 能高亮正在执行的那一行源码，单步调试友好
 *   + 不必实现 ModR/M 编码的所有细节
 *   - 不是严格的周期级仿真（指令耗时按 1 计）
 *
 * 支持的语法子集：
 *   段定义   NAME SEGMENT / ENDS、ASSUME（忽略）、END 入口
 *   常量     NAME EQU 值
 *   数据     [NAME] DB 值[, 值...]、DB 数量 DUP(值)
 *   标签     NAME:  或  NAME PROC [NEAR|FAR]  ... NAME ENDP
 *   指令     30 条（见 cpu.js）
 */

/** 解析数值字面量：280H / 0E8H / 20 / 0AH */
function parseNumber(text) {
  const s = String(text).trim();
  if (!s) return null;
  if (/^[0-9]+$/.test(s)) return parseInt(s, 10);
  if (/^[0-9][0-9A-F]*H$/i.test(s)) return parseInt(s.slice(0, -1), 16);
  if (/^[0-9A-F]+H$/i.test(s)) return parseInt(s.slice(0, -1), 16);
  if (/^0[0-7]+$/.test(s)) return parseInt(s, 8);
  return null;
}

/** 判断 token 是不是寄存器名 */
const REGISTERS = new Set([
  "AL", "AH", "AX", "BL", "BH", "BX", "CL", "CH", "CX",
  "DL", "DH", "DX", "SI", "DI", "SP", "BP",
  "CS", "DS", "SS", "ES",
]);
export function isRegister(name) {
  return REGISTERS.has(String(name).toUpperCase());
}

/** 把一行拆成操作数数组，支持 SEG_TAB[BX] 这种变址写法 */
function splitOperands(text) {
  const out = [];
  let depth = 0, cur = "";
  for (const ch of text) {
    if (ch === "[") depth++;
    if (ch === "]") depth--;
    if (ch === "," && depth === 0) { out.push(cur.trim()); cur = ""; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/**
 * 解析单个操作数。此时符号表已完整，可以直接判型。
 * 返回：{t:'imm',v} | {t:'reg',r} | {t:'mem',addr} | {t:'memidx',addr,idx}
 */
function parseOperand(text, symbols) {
  const s = String(text).trim();

  // 变址：SEG_TAB[BX]
  const idxMatch = s.match(/^([A-Za-z_]\w*)\s*\[\s*([A-Za-z]{2})\s*\]$/);
  if (idxMatch) {
    const sym = symbols.get(idxMatch[1].toUpperCase());
    if (!sym || sym.kind !== "var") {
      throw new Error(`变址寻址的基址「${idxMatch[1]}」不是已定义的数据变量`);
    }
    return { t: "memidx", addr: sym.value, idx: idxMatch[2].toUpperCase(), size: sym.size };
  }

  // 纯寄存器
  if (isRegister(s)) return { t: "reg", r: s.toUpperCase() };

  // 数值字面量
  const num = parseNumber(s);
  if (num !== null) return { t: "imm", v: num };

  // 符号：常量当立即数，变量当地址
  const sym = symbols.get(s.toUpperCase());
  if (sym) {
    if (sym.kind === "const") return { t: "imm", v: sym.value };
    if (sym.kind === "var") return { t: "mem", addr: sym.value, size: sym.size };
    throw new Error(`操作数「${s}」是代码标签，不能作为数据使用`);
  }

  throw new Error(`无法识别的操作数「${s}」`);
}

/**
 * 组装源码。
 * 返回 { code, symbols, memory, entry, lines, dataEnd }
 */
export function assemble(source) {
  const lines = String(source).replace(/\r\n/g, "\n").split("\n");
  const symbols = new Map();          // NAME → {kind:'const'|'var'|'label', value}
  const memory = new Uint8Array(65536);
  const code = [];                    // {op, args, line, text}
  let memPtr = 0;
  let seg = null;                     // 'data' | 'code'
  let lastVarName = null;             // DB 无标签续接时记住上一个变量
  let entryLabel = null;

  // ============ 第一遍：分段、符号、数据、指令骨架 ============
  for (let li = 0; li < lines.length; li++) {
    const original = lines[li];
    const text = original.split(";")[0].trim();
    if (!text) continue;
    const upper = text.toUpperCase();

    // 段定义。段名同时注册为常量 0：简化模型里所有段共享同一个 64K 空间，
    // 所以 MOV AX,DATA 这类取段基址的写法自然取到 0。
    if (/^\w+\s+SEGMENT\b/i.test(text)) {
      const segName = text.match(/^(\w+)/)[1].toUpperCase();
      if (!symbols.has(segName)) symbols.set(segName, { kind: "const", value: 0 });
      seg = /^DATA\b/i.test(text) ? "data" : "code";
      lastVarName = null;
      continue;
    }
    if (/^\w+\s+ENDS\b/i.test(text)) { seg = null; continue; }
    if (/^ASSUME\b/i.test(text)) continue;

    // 程序结束：END 后跟入口标签
    if (/^END\b/i.test(text)) {
      const m = text.match(/^END\s+(\w+)/i);
      if (m) entryLabel = m[1].toUpperCase();
      continue;
    }

    // 过程定义
    const proc = text.match(/^(\w+)\s+PROC\b(?:\s+(NEAR|FAR))?/i);
    if (proc) {
      symbols.set(proc[1].toUpperCase(), { kind: "label", value: code.length });
      lastVarName = null;
      continue;
    }
    if (/^(\w+)\s+ENDP\b/i.test(text)) continue;

    // 常量
    const equ = text.match(/^(\w+)\s+EQU\s+(.+)$/i);
    if (equ) {
      const v = parseNumber(equ[2]);
      if (v === null) throw new Error(`第 ${li + 1} 行：EQU 的值「${equ[2]}」不是数值`);
      symbols.set(equ[1].toUpperCase(), { kind: "const", value: v });
      continue;
    }

    // 数据定义（可能带也可能不带标签）：DB 单字节 / DW 双字节
    const dataMatch = text.match(/^(?:(\w+)\s+)?(DB|DW)\s+(.+)$/i);
    if (dataMatch) {
      const unit = dataMatch[2].toUpperCase() === "DW" ? 2 : 1;
      const name = dataMatch[1] ? dataMatch[1].toUpperCase() : lastVarName;
      const body = dataMatch[3].trim();

      if (!name) throw new Error(`第 ${li + 1} 行：无标签的数据定义没有可归属的变量`);

      // 形式一：n DUP(值)
      const dup = body.match(/^(\d+)\s+DUP\s*\(\s*(.+?)\s*\)$/i);
      if (dup) {
        const count = parseInt(dup[1], 10);
        const fill = parseNumber(dup[2]);
        if (fill === null) throw new Error(`第 ${li + 1} 行：DUP 的填充值不是数值`);
        if (dataMatch[1]) {
          symbols.set(name, { kind: "var", value: memPtr, size: unit });
          lastVarName = name;
        }
        for (let k = 0; k < count; k++) {
          if (unit === 1) memory[memPtr] = fill & 0xff;
          else { memory[memPtr] = fill & 0xff; memory[memPtr + 1] = (fill >> 8) & 0xff; }
          memPtr += unit;
        }
        continue;
      }

      const values = body.split(",").map((x) => parseNumber(x));
      if (values.some((v) => v === null)) {
        throw new Error(`第 ${li + 1} 行：数据定义中有无法解析的值`);
      }
      if (dataMatch[1]) {
        symbols.set(name, { kind: "var", value: memPtr, size: unit });
        lastVarName = name;
      }
      for (const v of values) {
        if (unit === 1) memory[memPtr] = v & 0xff;
        else { memory[memPtr] = v & 0xff; memory[memPtr + 1] = (v >> 8) & 0xff; }
        memPtr += unit;
      }
      continue;
    }

    // 行内标签（KD1: LOOP KD1 这种）
    let rest = text;
    const inlineLabel = rest.match(/^(\w+):\s*(.*)$/);
    if (inlineLabel) {
      symbols.set(inlineLabel[1].toUpperCase(), { kind: "label", value: code.length });
      rest = inlineLabel[2].trim();
      if (!rest) continue;
    }

    // 剩余的都当指令
    const inst = rest.match(/^([A-Za-z][A-Za-z0-9]*)\s*(.*)$/);
    if (!inst) throw new Error(`第 ${li + 1} 行无法解析：${text}`);
    code.push({
      op: inst[1].toUpperCase(),
      argText: inst[2].trim(),
      line: li,
      text: original.trim(),
      args: null,                      // 第二遍填
    });
  }

  // ============ 第二遍：解析操作数（此时符号表完整，支持前向引用） ============
  for (const instr of code) {
    if (!instr.argText) { instr.args = []; continue; }
    const parts = splitOperands(instr.argText);
    instr.args = parts.map((p) => {
      // 跳转目标：标签
      const up = p.trim().toUpperCase();
      const sym = symbols.get(up);
      if (sym && sym.kind === "label") return { t: "label", n: up };
      // 条件跳转也可能写成标签
      if (/^[A-Za-z_]\w*$/.test(p.trim()) && !isRegister(p) && parseNumber(p) === null) {
        if (!sym) throw new Error(`未定义的符号「${p.trim()}」（出现在：${instr.text}）`);
      }
      return parseOperand(p, symbols);
    });
  }

  // ============ 入口 ============
  let entry = 0;
  if (entryLabel) {
    const sym = symbols.get(entryLabel);
    if (!sym || sym.kind !== "label") {
      throw new Error(`END 指定的入口「${entryLabel}」不是代码标签`);
    }
    entry = sym.value;
  }

  return { code, symbols, memory, entry, lines, dataEnd: memPtr };
}

/** 反查：源码行号 → 是否是可执行指令行（给界面标号用） */
export function instructionLines(program) {
  const map = new Map();
  for (const instr of program.code) map.set(instr.line, instr);
  return map;
}
