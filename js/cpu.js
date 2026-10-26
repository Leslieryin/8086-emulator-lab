/**
 * 8086 子集执行器
 *
 * 与真实 CPU 的差异（有意为之）：
 *   - IP 用「指令索引」而不是字节地址，因为没有机器码
 *   - 一条指令按 1 个时间单位计，不做周期级时序
 *   - 栈固定在 SS:SP = 0:SP，SP 从 0xFFFE 向下
 *   - 段寄存器只用于语法兼容，寻址一律在同一个 64K 空间内
 *
 * 这些简化不影响外设交互的语义正确性——端口读写、标志位、跳转逻辑都是真的。
 */

const REG8 = new Set(["AL", "AH", "BL", "BH", "CL", "CH", "DL", "DH"]);
const PARENT = { AL: "AX", AH: "AX", BL: "BX", BH: "BX", CL: "CX", CH: "CX", DL: "DX", DH: "DX" };

export class CPU {
  constructor(program, board) {
    this.program = program;
    this.memory = program.memory;
    this.board = board;
    this.reset();
  }

  reset() {
    this.regs = {
      AX: 0, BX: 0, CX: 0, DX: 0,
      SI: 0, DI: 0, SP: 0xfffe, BP: 0,
      CS: 0, DS: 0, SS: 0, ES: 0,
    };
    this.flags = { ZF: 0, SF: 0, CF: 0, OF: 0, PF: 0, AF: 0 };
    this.ip = this.program.entry;
    this.halted = false;
    this.hltWaiting = false;
    this.haltedReason = "";
    this.currentLine = -1;
    this.instructionCount = 0;
    this.ifFlag = 0;              // 中断允许标志（STI/CLI）
    if (this.board) this.board.reset();
  }

  // ---------- 寄存器读写 ----------
  getReg(name) {
    if (REG8.has(name)) {
      const p = PARENT[name];
      return name === p[0] + "L" ? this.regs[p] & 0xff : (this.regs[p] >> 8) & 0xff;
    }
    return this.regs[name] ?? 0;
  }

  setReg(name, value) {
    if (REG8.has(name)) {
      const p = PARENT[name];
      if (name === p[0] + "L") this.regs[p] = (this.regs[p] & 0xff00) | (value & 0xff);
      else this.regs[p] = (this.regs[p] & 0x00ff) | ((value & 0xff) << 8);
      return;
    }
    this.regs[name] = value & 0xffff;
  }

  // ---------- 内存 ----------
  readMem(addr, width) {
    const a = addr & 0xffff;
    if (width === 1) return this.memory[a];
    return this.memory[a] | (this.memory[(a + 1) & 0xffff] << 8);
  }

  writeMem(addr, width, value) {
    const a = addr & 0xffff;
    if (width === 1) { this.memory[a] = value & 0xff; return; }
    this.memory[a] = value & 0xff;
    this.memory[(a + 1) & 0xffff] = (value >> 8) & 0xff;
  }

  // ---------- 操作数 ----------
  widthOf(op) {
    if (!op) return null;
    if (op.t === "reg") return REG8.has(op.r) ? 1 : 2;
    if (op.t === "mem") return op.size ?? 1;
    if (op.t === "memidx") return op.size ?? null;   // [BX] 这类宽度未知，交给对方操作数决定
    return null;                  // imm 不决定宽度
  }

  addrOf(op) {
    if (op.t === "mem") return op.addr;
    if (op.t === "memidx") {
      const a = (op.base || 0) + this.getReg(op.idx) + (op.disp || 0);
      return a & 0xffff;
    }
    throw new Error("不是内存操作数");
  }

  read(op, width) {
    switch (op.t) {
      case "imm": return op.v & (width === 1 ? 0xff : 0xffff);
      case "reg": return this.getReg(op.r);
      case "mem":
      case "memidx": return this.readMem(this.addrOf(op), width);
      default: throw new Error(`操作数类型 ${op.t} 不可读`);
    }
  }

  write(op, value, width) {
    switch (op.t) {
      case "reg": this.setReg(op.r, value); return;
      case "mem":
      case "memidx": this.writeMem(this.addrOf(op), width, value); return;
      default: throw new Error(`操作数类型 ${op.t} 不可写`);
    }
  }

  // ---------- 标志位 ----------
  setZS(result, width) {
    const mask = width === 1 ? 0xff : 0xffff;
    const signBit = width === 1 ? 0x80 : 0x8000;
    const v = result & mask;
    this.flags.ZF = v === 0 ? 1 : 0;
    this.flags.SF = (v & signBit) ? 1 : 0;
    // 奇偶标志只看低 8 位
    let bits = 0, b = v & 0xff;
    while (b) { bits += b & 1; b >>= 1; }
    this.flags.PF = bits % 2 === 0 ? 1 : 0;
  }

  // ---------- 栈 ----------
  push(value) {
    this.regs.SP = (this.regs.SP - 2) & 0xffff;
    this.writeMem(this.regs.SP, 2, value);
  }

  pop() {
    const v = this.readMem(this.regs.SP, 2);
    this.regs.SP = (this.regs.SP + 2) & 0xffff;
    return v;
  }

  // ---------- 执行一步 ----------
  step() {
    // HLT 只是「停机等中断」，不是程序结束：外设时钟照常推进，
    // 中断一到就恢复执行。真实 8086 就是这个语义。
    if (this.halted) {
      if (!this.hltWaiting) return false;
      if (this.board.tick) this.board.tick();
      if (this.ifFlag && this.board.pollInterrupt) {
        const vec = this.board.pollInterrupt();
        if (vec !== null && vec !== undefined) {
          this.halted = false;
          this.hltWaiting = false;
          this.enterInterrupt(vec);
        }
      }
      return true;          // 空转也算一步，让时钟与节拍继续推进
    }

    // 推进外设时钟（8253 计数 → 定时中断）
    if (this.board.tick) this.board.tick();

    // 硬件中断：优先级高于取指。IF=0 时不响应，挂到下一次
    if (this.ifFlag && this.board.pollInterrupt) {
      const vec = this.board.pollInterrupt();
      if (vec !== null && vec !== undefined) {
        this.enterInterrupt(vec);
        return true;
      }
    }

    const instr = this.program.code[this.ip];
    if (!instr) {
      this.halted = true;
      this.haltedReason = "指令指针越界";
      return false;
    }

    this.currentLine = instr.line;
    this.ip++;
    this.instructionCount++;

    try {
      this.execute(instr);
    } catch (err) {
      this.halted = true;
      this.haltedReason = `第 ${instr.line + 1} 行 ${instr.op}：${err.message}`;
      return false;
    }
    return true;
  }

  enterInterrupt(vector) {
    this.push(this.flagsValue());
    this.push(this.regs.CS);
    this.push(this.ip);
    this.ifFlag = 0;
    // 中断向量表：向量号 × 4 存放 IP 与 CS（这里 IP 存的是指令索引）
    const addr = (vector * 4) & 0xffff;
    this.ip = this.readMem(addr, 2);
    this.regs.CS = this.readMem((addr + 2) & 0xffff, 2);
  }

  flagsValue() {
    const f = this.flags;
    return (f.CF ? 0x0001 : 0) | (f.PF ? 0x0004 : 0) | (f.AF ? 0x0010 : 0) |
           (f.ZF ? 0x0040 : 0) | (f.SF ? 0x0080 : 0) | (f.OF ? 0x0800 : 0) |
           (this.ifFlag ? 0x0200 : 0);
  }

  // ---------- 指令 --------------
  execute(instr) {
    const { op, args } = instr;
    const a0 = args[0], a1 = args[1];

    switch (op) {
      // ===== 数据传送 =====
      case "MOV": {
        const w = this.widthOf(a0) ?? this.widthOf(a1) ?? 2;
        this.write(a0, this.read(a1, w), w);
        return;
      }
      case "PUSH": {
        const w = this.widthOf(a0) ?? 2;
        this.push(this.read(a0, w === 1 ? 2 : w));
        return;
      }
      case "POP": {
        const w = this.widthOf(a0) ?? 2;
        this.write(a0, this.pop(), w);
        return;
      }

      // ===== 算术 =====
      case "ADD": {
        const w = this.widthOf(a0) ?? this.widthOf(a1) ?? 2;
        const x = this.read(a0, w), y = this.read(a1, w);
        const r = x + y;
        const mask = w === 1 ? 0x100 : 0x10000;
        this.flags.CF = r >= mask ? 1 : 0;
        this.flags.OF = ((x ^ r) & (y ^ r) & (w === 1 ? 0x80 : 0x8000)) ? 1 : 0;
        this.write(a0, r, w);
        this.setZS(r, w);
        return;
      }
      case "SUB": {
        const w = this.widthOf(a0) ?? this.widthOf(a1) ?? 2;
        const x = this.read(a0, w), y = this.read(a1, w);
        const r = x - y;
        this.flags.CF = x < y ? 1 : 0;
        this.flags.OF = ((x ^ y) & (x ^ r) & (w === 1 ? 0x80 : 0x8000)) ? 1 : 0;
        this.write(a0, r, w);
        this.setZS(r, w);
        return;
      }
      case "CMP": {
        const w = this.widthOf(a0) ?? this.widthOf(a1) ?? 2;
        const x = this.read(a0, w), y = this.read(a1, w);
        const r = x - y;
        this.flags.CF = x < y ? 1 : 0;
        this.flags.OF = ((x ^ y) & (x ^ r) & (w === 1 ? 0x80 : 0x8000)) ? 1 : 0;
        this.setZS(r, w);
        return;
      }
      case "INC": {
        const w = this.widthOf(a0) ?? 2;
        const r = this.read(a0, w) + 1;
        this.write(a0, r, w);
        this.setZS(r, w);        // INC 不影响 CF
        return;
      }
      case "DEC": {
        const w = this.widthOf(a0) ?? 2;
        const r = this.read(a0, w) - 1;
        this.write(a0, r, w);
        this.setZS(r, w);        // DEC 不影响 CF
        return;
      }

      // ===== 逻辑 =====
      case "AND": case "OR": case "XOR": case "TEST": {
        const w = this.widthOf(a0) ?? this.widthOf(a1) ?? 2;
        const x = this.read(a0, w), y = this.read(a1, w);
        let r;
        if (op === "AND" || op === "TEST") r = x & y;
        else if (op === "OR") r = x | y;
        else r = x ^ y;
        this.flags.CF = 0;
        this.flags.OF = 0;
        this.setZS(r, w);
        if (op !== "TEST") this.write(a0, r, w);
        return;
      }
      case "NOT": {
        const w = this.widthOf(a0) ?? 2;
        this.write(a0, ~this.read(a0, w), w);
        return;
      }
      case "SHL": case "SHR": case "SAL": case "SAR": {
        const w = this.widthOf(a0) ?? 2;
        const count = a1 ? this.read(a1, 1) & 0x1f : 1;
        const mask = w === 1 ? 0xff : 0xffff;
        const signBit = w === 1 ? 0x80 : 0x8000;
        let v = this.read(a0, w) & mask;
        for (let i = 0; i < count; i++) {
          if (op === "SHL" || op === "SAL") {
            this.flags.CF = (v & signBit) ? 1 : 0;
            v = (v << 1) & mask;
          } else if (op === "SHR") {
            this.flags.CF = v & 1;
            v = (v >>> 1) & mask;
          } else {                       // SAR 算术右移，保留符号
            this.flags.CF = v & 1;
            v = ((v >> 1) | (v & signBit)) & mask;
          }
        }
        this.write(a0, v, w);
        this.setZS(v, w);
        return;
      }

      // ===== 特殊 =====
      case "AAM": {
        // AH = AL / 10, AL = AL % 10 —— 拆十位个位的常用技巧
        const al = this.getReg("AL");
        this.setReg("AH", Math.floor(al / 10));
        this.setReg("AL", al % 10);
        this.setZS(this.getReg("AX"), 2);
        return;
      }
      case "XLAT": {
        // AL = DS:[BX + AL]
        const addr = (this.getReg("BX") + this.getReg("AL")) & 0xffff;
        this.setReg("AL", this.memory[addr]);
        return;
      }
      case "NOP": return;

      // ===== 跳转 =====
      case "JMP": {
        this.ip = this.targetOf(a0);
        return;
      }
      case "JZ": case "JE": {
        if (this.flags.ZF) this.ip = this.targetOf(a0);
        return;
      }
      case "JNZ": case "JNE": {
        if (!this.flags.ZF) this.ip = this.targetOf(a0);
        return;
      }
      case "JC": {
        if (this.flags.CF) this.ip = this.targetOf(a0);
        return;
      }
      case "JNC": {
        if (!this.flags.CF) this.ip = this.targetOf(a0);
        return;
      }
      case "JS": {
        if (this.flags.SF) this.ip = this.targetOf(a0);
        return;
      }
      case "JNS": {
        if (!this.flags.SF) this.ip = this.targetOf(a0);
        return;
      }
      case "LOOP": {
        this.regs.CX = (this.regs.CX - 1) & 0xffff;
        if (this.regs.CX !== 0) this.ip = this.targetOf(a0);
        return;
      }

      // ===== 调用 =====
      case "CALL": {
        this.push(this.ip);
        this.ip = this.targetOf(a0);
        return;
      }
      case "RET": {
        this.ip = this.pop();
        return;
      }
      case "RETF": {
        this.ip = this.pop();
        this.regs.CS = this.pop();
        return;
      }

      // ===== 端口 =====
      case "OUT": {
        // 语法固定为 OUT DX, AL —— 端口在高 16 位寄存器里
        const port = this.read(a0, 2);
        const value = this.read(a1, 1);
        this.board.write(port, value);
        return;
      }
      case "IN": {
        // 语法固定为 IN AL, DX
        const port = this.read(a1, 2);
        this.write(a0, this.board.read(port), 1);
        return;
      }

      // ===== 标志与停机 =====
      case "STI": this.ifFlag = 1; return;
      case "CLI": this.ifFlag = 0; return;
      case "CLC": this.flags.CF = 0; return;
      case "STC": this.flags.CF = 1; return;
      case "HLT": {
        this.halted = true;
        this.hltWaiting = true;      // 等中断，不是结束
        this.haltedReason = "HLT：等待中断";
        return;
      }
      case "IRET": {
        this.ip = this.pop();
        this.regs.CS = this.pop();
        const fv = this.pop();
        const f = this.flags;
        f.CF = fv & 0x0001 ? 1 : 0;
        f.PF = fv & 0x0004 ? 1 : 0;
        f.AF = fv & 0x0010 ? 1 : 0;
        f.ZF = fv & 0x0040 ? 1 : 0;
        f.SF = fv & 0x0080 ? 1 : 0;
        f.OF = fv & 0x0800 ? 1 : 0;
        this.ifFlag = fv & 0x0200 ? 1 : 0;
        return;
      }

      default:
        throw new Error(`不支持该指令`);
    }
  }

  /** 跳转目标：标签或数值 */
  targetOf(op) {
    if (op.t === "label") {
      const sym = this.program.symbols.get(op.n);
      if (!sym) throw new Error(`找不到标签 ${op.n}`);
      return sym.value;
    }
    if (op.t === "imm") return op.v;
    throw new Error("跳转目标必须是标签");
  }
}
