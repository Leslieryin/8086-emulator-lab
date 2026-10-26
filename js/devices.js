/**
 * 外设模型
 *
 * Board 是一条「端口总线」：CPU 执行 OUT/IN 时按端口地址找到对应设备，
 * 转发读写。设备只关心自己那几个寄存器，彼此不耦合。
 *
 * 动态扫描的处理：真实硬件同一时刻只有一位数码管亮（靠切换位选 + 视觉暂留）。
 * Seg7 在这里把每位最后一次点亮时的段码「锁存」下来，这样界面上两位能同时显示，
 * 和人眼看到的效果一致。
 */

/** 共阴极七段码 → 字符，仅用于辅助显示 */
const SEG_DIGITS = {
  0x3f: "0", 0x06: "1", 0x5b: "2", 0x4f: "3", 0x66: "4",
  0x6d: "5", 0x7d: "6", 0x07: "7", 0x7f: "8", 0x6f: "9",
  0x77: "A", 0x7c: "b", 0x39: "C", 0x5e: "d", 0x79: "E", 0x71: "F",
  0x00: " ", 0x40: "-",
};

export class Board {
  constructor() {
    this.portMap = new Map();     // port → { device, reg }
    this.listeners = [];
    this.devices = {};
    this.unmapped = new Set();    // 记录没有设备响应的端口，便于排查
  }

  register(port, device, reg) {
    this.portMap.set(port & 0xffff, { device, reg });
  }

  write(port, value) {
    const p = port & 0xffff;
    const entry = this.portMap.get(p);
    if (entry) entry.device.write(entry.reg, value & 0xff);
    else this.unmapped.add(p);
    for (const fn of this.listeners) fn("write", p, value & 0xff);
  }

  read(port) {
    const p = port & 0xffff;
    const entry = this.portMap.get(p);
    const v = entry ? entry.device.read(entry.reg) : 0xff;
    for (const fn of this.listeners) fn("read", p, v & 0xff);
    return v & 0xff;
  }

  reset() {
    this.unmapped.clear();
    for (const d of Object.values(this.devices)) if (d.reset) d.reset();
  }
}

/** 8255 可编程并行接口：方式 0 */
export class PPI8255 {
  constructor() {
    this.reset();
  }
  reset() {
    this.pa = 0;        // A 口输出数据（段码）
    this.pb = 0;        // B 口输出数据（位选 + 蜂鸣器）
    this.pcOut = 0;
    this.pcIn = 0xff;   // C 口输入（按键，低电平有效 → 默认全 1）
    this.ctrl = 0x9b;
  }
  write(reg, v) {
    if (reg === "PA") this.pa = v;
    else if (reg === "PB") this.pb = v;
    else if (reg === "PC") this.pcOut = v;   // 写 PC 不影响输入位
    else if (reg === "CTRL") this.ctrl = v;
  }
  read(reg) {
    if (reg === "PA") return this.pa;
    if (reg === "PB") return this.pb;
    if (reg === "PC") return this.pcIn;      // 按键状态由界面写入
    return this.ctrl;
  }
  /** 界面设置按键：按位传入，低电平表示按下 */
  setKeys(mask) { this.pcIn = (~mask) & 0xff; }
}

/** 七段数码管：从 PA 取段码，从 PB 取位选 */
export class Seg7Display {
  constructor(ppi, digitCount = 2) {
    this.ppi = ppi;
    this.digitCount = digitCount;
    this.reset();
  }
  reset() {
    this.latched = new Array(this.digitCount).fill(0);
    this.active = -1;             // 当前正在扫描的位
  }
  /**
   * 每次 PA/PB 变化后调用，锁存当前点亮的位。
   *
   * 只锁存非零段码：动态扫描每轮都要先「灭段码 → 切位选 → 送段码」，
   * 灭段那一瞬间位选仍然有效，若照单全收会把 0x00 写进去、显示就闪没了。
   * 真实硬件上这一小段熄灭时间被视觉暂留抹平，这里用「保留上次非零值」等效实现。
   */
  refresh() {
    const sel = this.ppi.pb;
    const code = this.ppi.pa;
    if (code === 0) return;              // 全灭，保留上一次的值
    for (let i = 0; i < this.digitCount; i++) {
      if (sel & (1 << i)) {
        this.latched[i] = code;
        this.active = i;
      }
    }
  }
  /** 给界面：每位当前应显示的段码 */
  getDigits() { return this.latched.slice(); }
  /** 段码 → 字符（辅助显示） */
  static toChar(code) { return SEG_DIGITS[code] ?? "?"; }
  /** 段码 → 7 个段的开关，顺序 a b c d e f g */
  static toSegments(code) {
    return [
      !!(code & 0x01), !!(code & 0x02), !!(code & 0x04), !!(code & 0x08),
      !!(code & 0x10), !!(code & 0x20), !!(code & 0x40),
    ];
  }
}

/** 蜂鸣器：挂在 PB7 */
export class Buzzer {
  constructor(ppi, bit = 7) {
    this.ppi = ppi;
    this.bit = bit;
    this.reset();
  }
  reset() { this.on = false; }
  /** 由界面每帧调用，读取当前电平 */
  sample() {
    this.on = !!(this.ppi.pb & (1 << this.bit));
    return this.on;
  }
}

/**
 * 抢答器实验箱：8255 + 两位数码管 + 三个按键 + 蜂鸣器
 * ports 来自程序元数据，例如 { PA:0x298, PB:0x299, PC:0x29A, CTRL:0x29B }
 */
export function createBuzzerBoard(ports) {
  const board = new Board();
  const ppi = new PPI8255();
  const seg = new Seg7Display(ppi, 2);
  const buzzer = new Buzzer(ppi, 7);

  board.register(ports.PA, ppi, "PA");
  board.register(ports.PB, ppi, "PB");
  board.register(ports.PC, ppi, "PC");
  board.register(ports.CTRL, ppi, "CTRL");

  board.devices = { ppi, seg, buzzer };

  // PA 或 PB 一变就重算锁存
  board.listeners.push((type, port) => {
    if (type === "write" && (port === ports.PA || port === ports.PB)) seg.refresh();
  });

  return board;
}
