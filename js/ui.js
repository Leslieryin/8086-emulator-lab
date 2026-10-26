/**
 * 界面逻辑
 *
 * 运行方式是「按指令数限速」：BASE_IPS 条指令 ≈ 真实 1 秒。
 * 这个 30000 是实测出来的——抢答器的软件延时循环（WAIT_10MS × 100）
 * 正好决定倒计时快慢，IPS 调到 30000 时 20 秒倒计时约等于真实 20 秒。
 */
import { assemble } from "./asm.js";
import { CPU } from "./cpu.js";
import { createBuzzerBoard, Seg7Display } from "./devices.js";
import { PROGRAMS } from "./programs.js";

const BASE_IPS = 30000;
const SPEED_STEPS = [0.25, 0.5, 1, 2, 4, 8, 16];
const MAX_STEPS_PER_FRAME = 400000;

const $ = (id) => document.getElementById(id);
const el = {
  select: $("program-select"),
  run: $("btn-run"),
  step: $("btn-step"),
  reset: $("btn-reset"),
  speed: $("speed"),
  speedLabel: $("speed-label"),
  source: $("source"),
  curLine: $("cur-line"),
  displays: $("displays"),
  keys: $("keys"),
  buzzer: $("buzzer"),
  regs: $("regs"),
  flags: $("flags"),
  ports: $("ports"),
  status: $("status"),
  note: $("program-note"),
};

// ---------- 运行状态 ----------
let meta = null;          // 当前程序元数据
let program = null;       // assemble 结果
let cpu = null;
let board = null;
let ppi = null;
let seg = null;
let initialMemory = null; // 复位用的内存快照

let running = false;
let budget = 0;
let lastTime = 0;
let speedFactor = 1;
let keyMask = 0;
let lastLine = -1;

// 每行源码对应的 DOM
let lineEls = [];
// 数码管的段元素
let digitSegs = [];

/* =========================================================
   数码管
   ========================================================= */
const SEG_PATHS = [
  [15, 9, 45, 9],      // a 上横
  [48, 12, 48, 47],    // b 右上竖
  [48, 53, 48, 88],    // c 右下竖
  [15, 91, 45, 91],    // d 下横
  [12, 53, 12, 88],    // e 左下竖
  [12, 12, 12, 47],    // f 左上竖
  [15, 50, 45, 50],    // g 中横
];

function buildDisplays(count) {
  const NS = "http://www.w3.org/2000/svg";
  el.displays.innerHTML = "";
  digitSegs = [];
  for (let d = 0; d < count; d++) {
    const wrap = document.createElement("div");
    wrap.className = "display";
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "0 0 60 100");
    svg.setAttribute("width", "52");
    svg.setAttribute("height", "86");
    const segs = SEG_PATHS.map(([x1, y1, x2, y2]) => {
      const line = document.createElementNS(NS, "line");
      line.setAttribute("x1", x1); line.setAttribute("y1", y1);
      line.setAttribute("x2", x2); line.setAttribute("y2", y2);
      line.setAttribute("class", "seg");
      svg.appendChild(line);
      return line;
    });
    wrap.appendChild(svg);
    el.displays.appendChild(wrap);
    digitSegs.push(segs);
  }
}

function renderDisplays() {
  const codes = seg.getDigits();
  for (let d = 0; d < digitSegs.length; d++) {
    const on = Seg7Display.toSegments(codes[d] ?? 0);
    const segs = digitSegs[d];
    for (let i = 0; i < 7; i++) {
      segs[i].classList.toggle("on", !!on[i]);
    }
  }
}

/* =========================================================
   源码
   ========================================================= */
function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function renderSource() {
  const instrLines = new Map();
  for (const instr of program.code) instrLines.set(instr.line, instr);

  const html = program.lines.map((text, idx) => {
    const t = text.trim();
    let cls = "line";
    if (instrLines.has(idx)) cls += " inst";
    else if (!t) cls += " plain";
    else if (t.startsWith(";")) cls += " comment";
    else if (/^(\w+:|.*\b(PROC|ENDP|EQU|DB|DW|SEGMENT|ENDS|ASSUME)\b)/i.test(t)) cls += " label";
    const body = text.length ? escapeHtml(text) : "&nbsp;";
    return `<div class="${cls}" data-line="${idx}"><span class="ln">${idx + 1}</span><span class="code">${body}</span></div>`;
  }).join("");

  el.source.innerHTML = html;
  lineEls = Array.from(el.source.children);
  lastLine = -1;
}

function highlight(line) {
  if (line === lastLine) return;
  if (lastLine >= 0 && lineEls[lastLine]) lineEls[lastLine].classList.remove("cur");
  if (line >= 0 && lineEls[line]) {
    lineEls[line].classList.add("cur");
    lineEls[line].scrollIntoView({ block: "nearest" });
  }
  lastLine = line;
  el.curLine.textContent = line >= 0 ? `行 ${line + 1}` : "—";
}

/* =========================================================
   面板
   ========================================================= */
function buildPanels() {
  el.regs.innerHTML = ["AX", "BX", "CX", "DX", "SI", "DI", "SP", "BP"]
    .map((r) => `<dt>${r}</dt><dd id="reg-${r}">0000</dd>`).join("")
    + `<dt>IP</dt><dd id="reg-IP">0</dd>`;

  el.flags.innerHTML = ["ZF", "SF", "CF", "OF"]
    .map((f) => `<dt>${f}</dt><dd id="flag-${f}">0</dd>`).join("")
    + `<dt>IF</dt><dd id="flag-IF">0</dd>`;

  el.ports.innerHTML = ["PA", "PB", "PC"]
    .map((p) => `<dt>${p}</dt><dd id="port-${p}">0x00</dd>`).join("")
    + `<dt>CTRL</dt><dd id="port-CTRL">0x00</dd>`;
}

const hex4 = (v) => v.toString(16).toUpperCase().padStart(4, "0");
const hex2 = (v) => "0x" + v.toString(16).toUpperCase().padStart(2, "0");

function renderPanels() {
  for (const r of ["AX", "BX", "CX", "DX", "SI", "DI", "SP", "BP"]) {
    const node = document.getElementById("reg-" + r);
    const v = cpu.regs[r];
    if (node.textContent !== hex4(v)) node.textContent = hex4(v);
  }
  const ipNode = document.getElementById("reg-IP");
  const ipText = `#${cpu.ip}`;
  if (ipNode.textContent !== ipText) ipNode.textContent = ipText;

  for (const f of ["ZF", "SF", "CF", "OF"]) {
    const node = document.getElementById("flag-" + f);
    const v = String(cpu.flags[f]);
    if (node.textContent !== v) node.textContent = v;
  }
  const ifNode = document.getElementById("flag-IF");
  if (ifNode.textContent !== String(cpu.ifFlag)) ifNode.textContent = String(cpu.ifFlag);

  const portVals = { PA: ppi.pa, PB: ppi.pb, PC: ppi.pcIn, CTRL: ppi.ctrl };
  for (const [k, v] of Object.entries(portVals)) {
    const node = document.getElementById("port-" + k);
    const t = hex2(v);
    if (node.textContent !== t) node.textContent = t;
  }
}

function renderBuzzer() {
  const on = board.devices.buzzer.sample();
  el.buzzer.classList.toggle("on", on);
}

/** 从程序数据段读一个变量的值（用于显示 WINNER / LOCK_FLAG 这类业务状态） */
function readVar(name) {
  const s = program.symbols.get(name);
  if (!s || s.kind !== "var") return null;
  return cpu.memory[s.value];
}

function renderStatus() {
  if (cpu.halted) {
    el.status.classList.add("err");
    el.status.textContent = `已停止：${cpu.haltedReason || "程序结束"}　|　累计执行 ${cpu.instructionCount.toLocaleString()} 条指令`;
    return;
  }
  el.status.classList.remove("err");

  const parts = [];
  parts.push(running ? "运行中" : "已暂停");

  // 业务状态：这几个变量是课设程序自己的，能直接反映"现在处于什么阶段"
  const lock = readVar("LOCK_FLAG");
  const winner = readVar("WINNER");
  const runFlag = readVar("RUN_FLAG");
  if (winner !== null) {
    if (lock === 1 && winner > 0) parts.push(`已锁定 · ${winner} 号抢答成功`);
    else if (lock === 1) parts.push("已锁定 · 超时无人抢答");
    else if (runFlag === 1) parts.push("倒计时中 · 等待抢答");
    else parts.push("待机 · 等待开始");
  }

  parts.push(`数码管 ${seg.getDigits().map((c) => Seg7Display.toChar(c)).join("")}`);
  if (board.devices.buzzer.sample()) parts.push("蜂鸣器 响");
  parts.push(`累计 ${cpu.instructionCount.toLocaleString()} 条指令`);

  el.status.textContent = parts.join("　|　");
}

/* =========================================================
   运行控制
   ========================================================= */
function frame(now) {
  if (!running) return;
  const dt = Math.min((now - lastTime) / 1000, 0.1); // 切后台回来时不要一次算太多
  lastTime = now;
  budget += dt * BASE_IPS * speedFactor;

  let n = 0;
  while (budget >= 1 && n < MAX_STEPS_PER_FRAME && !cpu.halted) {
    cpu.step();
    budget -= 1;
    n++;
  }
  budget = Math.min(budget, BASE_IPS);   // 防止欠账滚雪球

  render();
  if (cpu.halted) { stop(); return; }
  requestAnimationFrame(frame);
}

function render() {
  highlight(cpu.currentLine);
  renderDisplays();
  renderPanels();
  renderBuzzer();
  renderStatus();
}

function start() {
  if (cpu.halted) return;
  running = true;
  budget = 0;
  lastTime = performance.now();
  el.run.textContent = "暂停";
  el.run.classList.add("running");
  requestAnimationFrame(frame);
}

function stop() {
  running = false;
  el.run.textContent = "运行";
  el.run.classList.remove("running");
  render();
}

function toggleRun() {
  if (running) stop(); else start();
}

function stepOnce() {
  if (running) stop();
  if (cpu.halted) return;
  cpu.step();
  render();
}

function reset() {
  running = false;
  el.run.textContent = "运行";
  el.run.classList.remove("running");
  cpu.memory.set(initialMemory);   // 恢复数据段初值
  cpu.reset();
  keyMask = 0;
  ppi.setKeys(0);
  for (const k of el.keys.querySelectorAll(".key")) k.classList.remove("pressed");
  budget = 0;
  // 重新走一遍上电初始化，让数码管回到 20
  for (let i = 0; i < 3000 && !cpu.halted; i++) cpu.step();
  render();
}

/* =========================================================
   按键
   ========================================================= */
function buildKeys() {
  el.keys.innerHTML = "";
  for (const k of meta.keys) {
    const btn = document.createElement("button");
    btn.className = "key";
    btn.dataset.bit = k.bit;
    btn.innerHTML = `${k.label}<span class="hint">${k.hint}</span>`;

    btn.addEventListener("pointerdown", (ev) => {
      ev.preventDefault();
      keyMask |= (1 << k.bit);
      ppi.setKeys(keyMask);
      btn.classList.add("pressed");
      if (!running && !cpu.halted) start();   // 按一下就开始跑，符合实验箱直觉
    });
    el.keys.appendChild(btn);
  }
}

window.addEventListener("pointerup", () => {
  if (!keyMask) return;
  keyMask = 0;
  if (ppi) ppi.setKeys(0);
  for (const k of el.keys.querySelectorAll(".key")) k.classList.remove("pressed");
});
window.addEventListener("pointercancel", () => {
  keyMask = 0;
  if (ppi) ppi.setKeys(0);
  for (const k of el.keys.querySelectorAll(".key")) k.classList.remove("pressed");
});

/* =========================================================
   装载程序
   ========================================================= */
function loadProgram(id) {
  meta = PROGRAMS[id];
  program = assemble(meta.source);
  initialMemory = Uint8Array.from(program.memory);
  board = createBuzzerBoard(meta.ports);
  ppi = board.devices.ppi;
  seg = board.devices.seg;
  cpu = new CPU(program, board);
  cpu.reset();

  running = false;
  budget = 0;
  keyMask = 0;
  el.run.textContent = "运行";
  el.run.classList.remove("running");

  renderSource();
  buildDisplays(2);
  buildKeys();
  buildPanels();

  el.note.hidden = !meta.note;
  el.note.textContent = meta.note || "";

  // 自动执行一小段，走完上电初始化（装初值 20 并刷新到数码管），
  // 这样页面一打开就能看到「20」，不用先点运行
  for (let i = 0; i < 3000 && !cpu.halted; i++) cpu.step();

  render();
}

/* =========================================================
   初始化
   ========================================================= */
function init() {
  for (const p of Object.values(PROGRAMS)) {
    const opt = document.createElement("option");
    opt.value = p.id;
    opt.textContent = p.name;
    el.select.appendChild(opt);
  }

  el.select.addEventListener("change", () => loadProgram(el.select.value));
  el.run.addEventListener("click", toggleRun);
  el.step.addEventListener("click", stepOnce);
  el.reset.addEventListener("click", reset);

  el.speed.addEventListener("input", () => {
    speedFactor = SPEED_STEPS[+el.speed.value - 1];
    el.speedLabel.textContent = `${speedFactor}×`;
  });
  speedFactor = SPEED_STEPS[+el.speed.value - 1];
  el.speedLabel.textContent = `${speedFactor}×`;

  // 键盘快捷键：空格运行/暂停，S 单步，R 复位
  document.addEventListener("keydown", (e) => {
    if (e.target.tagName === "SELECT") return;
    if (e.code === "Space") { e.preventDefault(); toggleRun(); }
    else if (e.key === "s" || e.key === "S") { e.preventDefault(); stepOnce(); }
    else if (e.key === "r" || e.key === "R") { e.preventDefault(); reset(); }
  });

  loadProgram(el.select.value || "buzzer");

  /**
   * 只读诊断接口。模块作用域内的状态外部拿不到，留这个口子方便自动化测试，
   * 也方便想二次开发的人查内部值。只暴露读，不暴露写。
   */
  window.__emu = {
    getState() {
      return {
        running,
        halted: cpu.halted,
        haltedReason: cpu.haltedReason,
        ip: cpu.ip,
        instructionCount: cpu.instructionCount,
        digits: seg.getDigits(),
        display: seg.getDigits().map((c) => Seg7Display.toChar(c)).join(""),
        pcIn: ppi.pcIn,
        pa: ppi.pa,
        pb: ppi.pb,
        winner: readVar("WINNER"),
        lock: readVar("LOCK_FLAG"),
        runFlag: readVar("RUN_FLAG"),
        curTime: readVar("CUR_TIME"),
      };
    },
    programId: () => meta.id,
  };
}

document.addEventListener("DOMContentLoaded", init);
if (document.readyState !== "loading") init();
