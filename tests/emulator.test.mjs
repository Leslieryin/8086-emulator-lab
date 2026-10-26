/**
 * 模拟器端到端测试
 *
 * 跑的是 programs.js 里内嵌的真实课设汇编，断言的是外设层面的可观测行为
 * （数码管显示什么、谁被判赢、锁定标志），而不是内部实现细节。
 *
 *   node tests/emulator.test.mjs
 */
import { assemble } from "../js/asm.js";
import { CPU } from "../js/cpu.js";
import { createBuzzerBoard, createAdcBoard, Seg7Display } from "../js/devices.js";
import { PROGRAMS } from "../js/programs.js";

let pass = 0, fail = 0;
function ok(name, cond, detail = "") {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + "  " + detail); }
}

/** 建一套独立环境 */
function setup(programId) {
  const meta = PROGRAMS[programId];
  const program = assemble(meta.source);
  const board = createBuzzerBoard(meta.ports);
  const cpu = new CPU(program, board);
  cpu.reset();
  return {
    meta, program, board, cpu,
    ppi: board.devices.ppi,
    seg: board.devices.seg,
    sym: (n) => program.symbols.get(n).value,
    rd(n) { return cpu.memory[this.sym(n)]; },
    rw(n) { return cpu.memory[this.sym(n)] | (cpu.memory[this.sym(n) + 1] << 8); },
    /** 跑 n 步；keys 是按键掩码（1 = 按下），保持按下状态 */
    run(n, keys = 0) {
      this.ppi.setKeys(keys);
      for (let i = 0; i < n && !cpu.halted; i++) cpu.step();
    },
    /** 显示内容：两位数码管对应的字符 */
    display() {
      return this.seg.getDigits().map((c) => Seg7Display.toChar(c)).join("");
    },
  };
}

// ============================================================
console.log("\n[解析器]");
{
  const env = setup("buzzer");
  ok("指令数与预期一致", env.program.code.length === 172, `实际 ${env.program.code.length}`);
  ok("数据段分配了 20 字节", env.program.dataEnd === 20, `实际 ${env.program.dataEnd}`);
  ok("INIT_TIME 在地址 0", env.sym("INIT_TIME") === 0);
  ok("SEG_TAB 是 10 字节的段码表", env.sym("SEG_TAB") === 10);
  const tick = env.program.symbols.get("TICK_CNT");
  ok("TICK_CNT 识别为 16 位变量", tick.size === 2, `实际 ${tick.size}`);
  ok("段名 DATA 注册为常量 0", env.program.symbols.get("DATA")?.value === 0);
}

// ============================================================
console.log("\n[上电初始化]");
{
  const env = setup("buzzer");
  env.run(2000);
  ok("RUN_FLAG = 0", env.rd("RUN_FLAG") === 0);
  ok("LOCK_FLAG = 0", env.rd("LOCK_FLAG") === 0);
  ok("CUR_TIME = 20", env.rd("CUR_TIME") === 20, `实际 ${env.rd("CUR_TIME")}`);
  ok("8255 控制字 = 0x81（方式0，PA/PB 输出）", env.ppi.ctrl === 0x81, `实际 0x${env.ppi.ctrl.toString(16)}`);
  ok("数码管上电显示 20", env.display() === "20", `实际「${env.display()}」`);
}

// ============================================================
console.log("\n[按下开始键]");
{
  const env = setup("buzzer");
  env.run(2000);
  env.run(2000, 0b001);          // PC0 低电平
  env.run(2000, 0);              // 松开
  ok("RUN_FLAG 置 1，倒计时开始", env.rd("RUN_FLAG") === 1);
  ok("CUR_TIME 仍是 20", env.rd("CUR_TIME") === 20);
}

// ============================================================
console.log("\n[倒计时推进]");
{
  const env = setup("buzzer");
  env.run(2000);
  env.run(2000, 0b001);
  env.run(2000, 0);
  env.run(35000);                // 约 1 秒的量
  ok("CUR_TIME 减到 19", env.rd("CUR_TIME") === 19, `实际 ${env.rd("CUR_TIME")}`);
  ok("数码管显示 19", env.display() === "19", `实际「${env.display()}」`);
  env.run(30000);
  ok("再减到 18", env.rd("CUR_TIME") === 18, `实际 ${env.rd("CUR_TIME")}`);
  ok("数码管显示 18", env.display() === "18", `实际「${env.display()}」`);
}

// ============================================================
console.log("\n[原版：抢答键行为]");
{
  const env = setup("buzzer");
  env.run(2000);
  env.run(2000, 0b001); env.run(2000, 0);      // 开始
  env.run(60000);                              // 倒计时进行中
  const before = env.rd("CUR_TIME");

  env.run(3000, 0b010);                        // PC1 低电平
  env.run(2000, 0);
  ok("按 1 号键：WINNER 仍为 0（原版此处失效）", env.rd("WINNER") === 0,
     `实际 ${env.rd("WINNER")}`);
  ok("按 1 号键：未锁定，倒计时继续", env.rd("LOCK_FLAG") === 0 && env.rd("CUR_TIME") <= before);

  env.run(3000, 0b100);                        // PC2 低电平
  env.run(2000, 0);
  ok("按 2 号键：WINNER = 2", env.rd("WINNER") === 2, `实际 ${env.rd("WINNER")}`);
  ok("按 2 号键：LOCK_FLAG 置 1", env.rd("LOCK_FLAG") === 1);
  ok("按 2 号键：RUN_FLAG 归 0，倒计时停止", env.rd("RUN_FLAG") === 0);
}

// ============================================================
console.log("\n[修正版：1 号键恢复正常]");
{
  const env = setup("buzzer-fixed");
  env.run(2000);
  env.run(2000, 0b001); env.run(2000, 0);
  env.run(60000);

  env.run(3000, 0b010);
  env.run(2000, 0);
  ok("按 1 号键：WINNER = 1", env.rd("WINNER") === 1, `实际 ${env.rd("WINNER")}`);
  ok("按 1 号键：LOCK_FLAG 置 1", env.rd("LOCK_FLAG") === 1);

  // 已经锁定，再按 2 号键不应改变结果
  env.run(3000, 0b100);
  env.run(2000, 0);
  ok("锁定后按 2 号键无效，WINNER 仍是 1", env.rd("WINNER") === 1, `实际 ${env.rd("WINNER")}`);
}

// ============================================================
console.log("\n[修正版：2 号键仍正常]");
{
  const env = setup("buzzer-fixed");
  env.run(2000);
  env.run(2000, 0b001); env.run(2000, 0);
  env.run(60000);
  env.run(3000, 0b100);
  env.run(2000, 0);
  ok("按 2 号键：WINNER = 2", env.rd("WINNER") === 2, `实际 ${env.rd("WINNER")}`);
}

// ============================================================
console.log("\n[超时：无人抢答]");
{
  const env = setup("buzzer");
  env.run(2000);
  env.run(2000, 0b001);
  env.run(2000, 0);
  env.run(20 * 31000 + 5000);     // 20 秒
  ok("CUR_TIME 归 0", env.rd("CUR_TIME") === 0, `实际 ${env.rd("CUR_TIME")}`);
  ok("LOCK_FLAG 置 1（超时锁定）", env.rd("LOCK_FLAG") === 1);
  ok("RUN_FLAG 归 0", env.rd("RUN_FLAG") === 0);
  ok("数码管定格 00", env.display() === "00", `实际「${env.display()}」`);
}

// ============================================================
console.log("\n[蜂鸣器]");
{
  const env = setup("buzzer-fixed");
  env.run(2000);
  env.run(2000, 0b001); env.run(2000, 0);
  env.run(60000);
  // 从按下抢答键的那一刻就开始采样——BEEP_ONCE 只响约 2×WAIT_10MS，
  // 先跑完再采样就错过了
  let sawBuzzer = false;
  env.ppi.setKeys(0b010);
  for (let i = 0; i < 4000; i++) {
    env.cpu.step();
    if (env.board.devices.buzzer.sample()) sawBuzzer = true;
  }
  ok("抢答后蜂鸣器曾置位（PB7）", sawBuzzer);
}

// ============================================================
console.log("\n[段码解码]");
{
  ok("0x3F → 0", Seg7Display.toChar(0x3f) === "0");
  ok("0x6F → 9", Seg7Display.toChar(0x6f) === "9");
  ok("0x7F → 8", Seg7Display.toChar(0x7f) === "8");
  const segs = Seg7Display.toSegments(0x3f);
  ok("0x3F 点亮 a~f 六段", segs.filter(Boolean).length === 6, `实际 ${segs.filter(Boolean).length}`);
  ok("0x3F 的 g 段熄灭", segs[6] === false);
}

// ============================================================
console.log("\n[ADC 定时采样：解析与寻址]");
{
  const meta = PROGRAMS.adc;
  const program = assemble(meta.source);
  ok("解析出 128 条指令", program.code.length === 128, `实际 ${program.code.length}`);
  ok("数据段 1296 字节（1024 向量表 + 272 数据）", program.dataEnd === 1296, `实际 ${program.dataEnd}`);
  ok("向量表在前，SEG_DISPLAY 顺延到 1024", program.symbols.get("SEG_DISPLAY").value === 1024,
     `实际 ${program.symbols.get("SEG_DISPLAY").value}`);
  ok("IRQ_HANDLER 是代码标签", program.symbols.get("IRQ_HANDLER").kind === "label");
}

// ============================================================
console.log("\n[ADC 定时采样：外设初始化]");
{
  const meta = PROGRAMS.adc;
  const program = assemble(meta.source);
  const board = createAdcBoard(meta.ports);
  const cpu = new CPU(program, board);
  cpu.reset();
  board.devices.adc.setAnalog(200);
  for (let i = 0; i < 3000; i++) cpu.step();

  const timer = board.devices.timer, pic = board.devices.pic;

  ok("8253 计数器0 初值 1000", timer.counters[0].reload === 1000, `实际 ${timer.counters[0].reload}`);
  ok("8253 计数器1 初值 100", timer.counters[1].reload === 100, `实际 ${timer.counters[1].reload}`);
  ok("8259 中断向量基址 0x60", pic.vectorBase === 0x60, `实际 0x${pic.vectorBase.toString(16)}`);
  ok("8259 只开放 IR0（屏蔽字 0xFE）", pic.imr === 0xfe, `实际 0x${pic.imr.toString(16)}`);

  // 中断向量表由程序用 ES:[BX] 写入：类型 0x60 → 物理地址 0x180
  const vecIP = cpu.memory[0x180] | (cpu.memory[0x181] << 8);
  ok("向量表 0x180 指向 IRQ_HANDLER", vecIP === program.symbols.get("IRQ_HANDLER").value,
     `0x180=${vecIP} 期望 ${program.symbols.get("IRQ_HANDLER").value}`);

  ok("执行 HLT 后进入等待中断状态", cpu.halted === true && cpu.hltWaiting === true);
  ok("IF 已开（STI 生效）", cpu.ifFlag === 1);
}

// ============================================================
console.log("\n[ADC 定时采样：10Hz 中断与显示]");
{
  const meta = PROGRAMS.adc;
  const program = assemble(meta.source);
  const board = createAdcBoard(meta.ports);
  const cpu = new CPU(program, board);
  cpu.reset();
  board.devices.adc.setAnalog(200);

  const runSteps = (n) => { for (let i = 0; i < n; i++) cpu.step(); };
  runSteps(3000);                       // 初始化 + 等待第一次中断
  const c0 = board.devices.adc.conversions;

  runSteps(30000);                      // 约 1 秒
  const c1 = board.devices.adc.conversions;
  const perSecond = c1 - c0;

  ok("1 秒内采样约 10 次", perSecond >= 8 && perSecond <= 12, `实际 ${perSecond} 次`);
  ok("显示为高 4 位（200>>4=12 → C）", board.devices.seg.getDigits()[0] === 0x39,
     `段码 0x${board.devices.seg.getDigits()[0].toString(16)}`);

  // 改模拟输入，下一轮采样后应跟着变
  board.devices.adc.setAnalog(60);
  runSteps(6000);
  ok("输入 60 时显示 3（60>>4=3）", board.devices.seg.getDigits()[0] === 0x4f,
     `段码 0x${board.devices.seg.getDigits()[0].toString(16)}`);

  board.devices.adc.setAnalog(255);
  runSteps(6000);
  ok("输入 255 时显示 F（255>>4=15）", board.devices.seg.getDigits()[0] === 0x71,
     `段码 0x${board.devices.seg.getDigits()[0].toString(16)}`);

  board.devices.adc.setAnalog(0);
  runSteps(6000);
  ok("输入 0 时显示 0", board.devices.seg.getDigits()[0] === 0x3f,
     `段码 0x${board.devices.seg.getDigits()[0].toString(16)}`);
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail ? 1 : 0);
