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
    this.tickHooks = [];          // 每执行一条指令推进一次（定时器用）
    this.interruptPoll = null;    // CPU 每步询问是否有中断请求
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

  tick() {
    for (const fn of this.tickHooks) fn();
  }

  pollInterrupt() {
    return this.interruptPoll ? this.interruptPoll() : null;
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

/** 七段数码管：从数据口取段码，从位选口取位选 */
export class Seg7Display {
  /**
   * @param ppi 8255 实例
   * @param digitCount 位数
   * @param opt.dataPort 段码来自哪个端口，'PA' 或 'PB'
   * @param opt.selectPort 位选来自哪个端口，null 表示静态显示（单管直连）
   */
  constructor(ppi, digitCount = 2, opt = {}) {
    this.ppi = ppi;
    this.digitCount = digitCount;
    this.dataPort = opt.dataPort || "PA";
    this.selectPort = opt.selectPort === undefined ? "PB" : opt.selectPort;
    this.reset();
  }
  reset() {
    this.latched = new Array(this.digitCount).fill(0);
    this.active = -1;
  }
  _portVal(name) { return name === "PA" ? this.ppi.pa : this.ppi.pb; }

  /**
   * 每次 PA/PB 变化后调用，锁存当前点亮的位。
   *
   * 只锁存非零段码：动态扫描每轮都要先「灭段码 → 切位选 → 送段码」，
   * 灭段那一瞬间位选仍然有效，若照单全收会把 0x00 写进去、显示就闪没了。
   * 真实硬件上这一小段熄灭时间被视觉暂留抹平，这里用「保留上次非零值」等效实现。
   */
  refresh() {
    const code = this._portVal(this.dataPort);
    if (code === 0) return;              // 全灭，保留上一次的值

    if (this.selectPort === null) {      // 静态显示：只有一个管
      this.latched[0] = code;
      this.active = 0;
      return;
    }
    const sel = this._portVal(this.selectPort);
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

/* =========================================================================
   以下是 ADC 定时采样实验用到的外设
   ========================================================================= */

/**
 * 8253 可编程定时器（只实现本实验用到的部分：计数器 0/1 级联分频）
 *
 * 时间推进方式：每执行一条 CPU 指令推进固定个数的输入时钟周期。
 * 标定依据——抢答器实测 30000 条指令 ≈ 1 秒，本实验 8253 输入 1MHz，
 * 于是 1 条指令 ≈ 1e6 / 30000 ≈ 33.3 个时钟周期。
 * 这样课设设定的「1MHz → 1000 → 1kHz → 100 → 10Hz」在界面上就是真的 10Hz。
 */
export class Timer8253 {
  constructor(cyclesPerStep = 1e6 / 30000) {
    this.cps = cyclesPerStep;
    this.onPulse = null;      // 计数器 1 输出一个脉冲时回调（接 8259 的 IRQ0）
    this.reset();
  }

  reset() {
    this.acc = 0;
    this.counters = [0, 1].map(() => ({
      reload: 0, count: 0, mode: 3, low: 0, half: false,
    }));
  }

  write(reg, v) {
    if (reg === "CTRL") return this.writeControl(v);
    return this.writeCounter(reg === "CNT0" ? 0 : 1, v);
  }

  read() { return 0; }

  writeControl(v) {
    const sel = (v >> 6) & 3;
    if (sel > 2) return;                     // 读回命令，忽略
    const mode = (v >> 1) & 7;
    const c = this.counters[sel];
    c.mode = mode;
    c.half = false;
  }

  writeCounter(i, v) {
    const c = this.counters[i];
    if (!c.half) {
      c.low = v & 0xff;
      c.half = true;
      return;
    }
    // 先低字节后高字节，写完装载新初值
    c.reload = ((v << 8) | c.low) & 0xffff;
    c.count = c.reload > 0 ? c.reload : 0x10000;
    c.half = false;
  }

  tick() {
    this.acc += this.cps;
    let cycles = Math.floor(this.acc);
    if (cycles <= 0) return;
    this.acc -= cycles;

    const c0 = this.counters[0];
    if (!c0.reload) return;

    c0.count -= cycles;
    let guard = 0;
    while (c0.count <= 0 && guard++ < 1024) {
      c0.count += c0.reload;
      this._pulseSecond();
    }
  }

  _pulseSecond() {
    const c1 = this.counters[1];
    if (!c1.reload) return;
    c1.count -= 1;
    if (c1.count <= 0) {
      c1.count += c1.reload;
      if (this.onPulse) this.onPulse();
    }
  }
}

/** 8259 可编程中断控制器（单片，主程序只用到 IR0） */
export class PIC8259 {
  constructor() { this.reset(); }

  reset() {
    this.icwStep = 0;        // 0=等ICW1 1=等ICW2 2=等ICW4 3=就绪
    this.vectorBase = 0;
    this.imr = 0xff;         // 全屏蔽
    this.irr = 0;            // 中断请求
    this.isr = 0;            // 服务中
    this.needICW4 = false;
  }

  write(reg, v) {
    if (reg === "CMD") return this.writeCmd(v);
    return this.writeData(v);
  }

  read() { return 0; }

  writeCmd(v) {
    if (v & 0x10) {                        // ICW1：边沿触发 / 单片 / 是否需要 ICW4
      this.icwStep = 1;
      this.needICW4 = !!(v & 0x01);
      this.imr = 0xff;
      this.irr = 0;
      this.isr = 0;
      return;
    }
    if (v & 0x08) return;                  // OCW3，忽略
    if ((v & 0xe0) === 0x20) this.isr = 0; // OCW2：非指定 EOI
  }

  writeData(v) {
    if (this.icwStep === 1) {              // ICW2：中断类型号基址
      this.vectorBase = v & 0xf8;
      this.icwStep = this.needICW4 ? 2 : 3;
      return;
    }
    if (this.icwStep === 2) {              // ICW4：8086 模式
      this.icwStep = 3;
      return;
    }
    this.imr = v;                          // OCW1：屏蔽字
  }

  /** 外设拉高某条 IRQ */
  raise(irq) { this.irr |= (1 << irq); }

  /** CPU 来查询：返回待处理的中断类型号，没有则 null */
  acknowledge() {
    const active = this.irr & ~this.imr & ~this.isr;
    if (!active) return null;
    let irq = 0;
    while (!(active & (1 << irq))) irq++;
    this.irr &= ~(1 << irq);
    this.isr |= (1 << irq);
    return (this.vectorBase + irq) & 0xff;
  }
}

/** ADC0808 模数转换器：写入启动转换，读取得 8 位结果 */
export class ADC0808 {
  constructor() { this.reset(); }

  reset() {
    this.analog = 128;       // 模拟输入（界面滑块控制）
    this.result = 128;
    this.conversions = 0;
  }

  write(_reg, _v) {
    // 简化：写入即视为启动转换并立即完成。
    // 真实器件需要约 100μs，而课设里的延时循环（255 次 LOOP）远长于此，不影响结果。
    this.result = this.analog & 0xff;
    this.conversions++;
  }

  read(_reg) { return this.result & 0xff; }

  setAnalog(v) { this.analog = v & 0xff; }
}

/**
 * ADC 定时采样实验箱：8253 + 8259 + 8255 + ADC0808 + 一位数码管
 *
 * 信号链：8253 两级分频 10Hz → 8259 IR0 → 中断服务程序
 *        → 启动 ADC0808 → 读结果取高 4 位 → 8255 PB → 数码管
 */
export function createAdcBoard(ports) {
  const board = new Board();
  const ppi = new PPI8255();
  const timer = new Timer8253();
  const pic = new PIC8259();
  const adc = new ADC0808();
  // 这个实验的数码管直接挂在 PB 口上，没有位选（静态显示单管）
  const seg = new Seg7Display(ppi, 1, { dataPort: "PB", selectPort: null });

  board.register(ports.PPI_PA, ppi, "PA");
  board.register(ports.PPI_PB, ppi, "PB");
  board.register(ports.PPI_PC, ppi, "PC");
  board.register(ports.PPI_CTRL, ppi, "CTRL");
  board.register(ports.CNT0, timer, "CNT0");
  board.register(ports.CNT1, timer, "CNT1");
  board.register(ports.TIMER_CTRL, timer, "CTRL");
  board.register(ports.PIC_CMD, pic, "CMD");
  board.register(ports.PIC_DATA, pic, "DATA");
  board.register(ports.ADC, adc, "DATA");

  timer.onPulse = () => pic.raise(0);          // 定时器 10Hz 输出接 IR0
  board.devices = { ppi, seg, timer, pic, adc };
  board.tickHooks.push(() => timer.tick());
  board.interruptPoll = () => pic.acknowledge();

  board.listeners.push((type, port) => {
    if (type === "write" && port === ports.PPI_PB) seg.refresh();
  });

  return board;
}
