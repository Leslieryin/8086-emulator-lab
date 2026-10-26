/**
 * 内嵌的实验程序
 *
 * 源码直接取自 8086-microcomputer-lab 仓库，没有为了能在网页里跑而改写任何一行——
 * 这是这个模拟器最想守住的东西：你看到的执行结果，就是这段汇编真实的执行结果。
 *
 * buzzer-fixed 是唯一的例外：它把原版里一处 JZ/JNZ 写反的地方改回来了，
 * 用于对照「原版跑出来的行为」和「本该有的行为」。差异只有那一行。
 */

export const PROGRAMS = {};

PROGRAMS["buzzer"] = {
  id: "buzzer",
  name: "抢答计时器",
  subtitle: "8255 + 8254 · 20 秒倒计时 · 双人抢答",
  note: `课设提交的原始版本。1 号抢答键按下去没有反应——原因见 README「原版里的一个 bug」。`,
  board: "buzzer",
  ports: { PA: 0x298, PB: 0x299, PC: 0x29a, CTRL: 0x29b },
  timerPorts: { CNT0: 0x280, CTL: 0x283 },
  keys: [
    { bit: 0, label: "开始", hint: "PC0" },
    { bit: 1, label: "1 号抢答", hint: "PC1" },
    { bit: 2, label: "2 号抢答", hint: "PC2" },
  ],
  buzzerBit: 7,
  secondsPerTick: 30000,
  source: `DATA SEGMENT                                         ; 数据段开始

CNT0_8254   EQU 280H                                 ; 8254通道0端口地址
CTL_8254    EQU 283H                                 ; 8254控制口地址

PA_8255     EQU 298H                                 ; 8255 A口地址
PB_8255     EQU 299H                                 ; 8255 B口地址
PC_8255     EQU 29AH                                 ; 8255 C口地址
CTL_8255    EQU 29BH                                 ; 8255控制口地址

INIT_TIME   DB 20                                    ; 初始倒计时秒数
CUR_TIME    DB 20                                    ; 当前剩余秒数

SHOW_TEN    DB 2                                     ; 显示缓冲：十位
SHOW_ONE    DB 0                                     ; 显示缓冲：个位

RUN_FLAG    DB 0                                     ; 运行标志，0表示未开始，1表示正在倒计时
LOCK_FLAG   DB 0                                     ; 锁定标志，0表示未锁定，1表示已经结束
WINNER      DB 0                                     ; 抢答结果，0无人，1号选手，2号选手

PB_BASE     DB 00H                                   ; PB口基础状态缓存，PB7给蜂鸣器，其余位选按需叠加
TICK_CNT    DW 100                                   ; 100个10ms构成1秒

SEG_TAB     DB 3FH                                   ; 0 的段码
            DB 06H                                   ; 1 的段码
            DB 5BH                                   ; 2 的段码
            DB 4FH                                   ; 3 的段码
            DB 66H                                   ; 4 的段码
            DB 6DH                                   ; 5 的段码
            DB 7DH                                   ; 6 的段码
            DB 07H                                   ; 7 的段码
            DB 7FH                                   ; 8 的段码
            DB 6FH                                   ; 9 的段码

DATA ENDS                                            ; 数据段结束

CODE SEGMENT                                         ; 代码段开始
ASSUME CS:CODE,DS:DATA                               ; 指定段寄存器

START:                                               ; 程序入口
        MOV AX,DATA                                  ; 数据段地址送AX
        MOV DS,AX                                    ; 初始化DS

        CALL INIT_8255                               ; 初始化8255
        CALL INIT_8254                               ; 初始化8254
        CALL RESET_SYSTEM                            ; 初始化系统状态

MAIN_WAIT:                                           ; 待机主循环
        CALL SCAN_DISPLAY                            ; 动态扫描数码管
        CALL CHECK_START_KEY                         ; 检测开始键
        CMP RUN_FLAG,1                               ; 判断是否已经开始
        JNE MAIN_WAIT                                ; 未开始就一直待机

COUNTDOWN_LOOP:                                      ; 倒计时外层循环
        MOV TICK_CNT,100                             ; 装入100个10ms作为1秒

ONE_SECOND_LOOP:                                     ; 1秒内部循环
        CALL WAIT_10MS                               ; 等待10ms，同时内部也会检测按键和刷新显示
        CALL CHECK_ANSWER_KEY
        CMP LOCK_FLAG,1                              ; 判断是否已经有人抢答或超时
        JE HOLD_RESULT                               ; 若已锁定则转入结果保持
        DEC TICK_CNT                                 ; 10ms计数减1
        JNZ ONE_SECOND_LOOP                          ; 未满1秒则继续

        DEC CUR_TIME                                 ; 满1秒后剩余时间减1
        CALL UPDATE_DISPLAY_BUF                      ; 更新显示缓冲
        CMP CUR_TIME,0                               ; 判断是否减到0
        JNZ COUNTDOWN_LOOP                           ; 不为0则继续下一秒

        MOV LOCK_FLAG,1                              ; 到0则锁定系统
        MOV RUN_FLAG,0                               ; 结束倒计时
        JMP HOLD_RESULT                              ; 进入保持状态

HOLD_RESULT:                                         ; 结果保持状态
        CALL SCAN_DISPLAY                            ; 持续刷新数码管
        JMP HOLD_RESULT                              ; 一直停在这里

; ------------------------------------------------------------
; 8255初始化
; PA输出，PB输出，PC低4位输入，PC高4位输出，模式0
; 控制字 = 1000 0001B = 81H
; ------------------------------------------------------------
INIT_8255 PROC NEAR
        MOV DX,CTL_8255                              ; DX指向8255控制口
        MOV AL,81H                                   ; 设置8255工作方式
        OUT DX,AL                                    ; 写8255控制字

        MOV DX,PA_8255                               ; DX指向A口
        MOV AL,00H                                   ; 清零输出
        OUT DX,AL                                    ; 清A口

        MOV DX,PB_8255                               ; DX指向B口
        OUT DX,AL                                    ; 清B口
        RET
INIT_8255 ENDP

; ------------------------------------------------------------
; 8254初始化
; 通道0用模式0，二进制计数，先写低字节后写高字节
; 控制字 = 0011 0000B = 30H
; ------------------------------------------------------------
INIT_8254 PROC NEAR
        MOV DX,CTL_8254                              ; DX指向8254控制口
        MOV AL,30H                                   ; 通道0，低高字节，模式0
        OUT DX,AL                                    ; 写控制字
        RET
INIT_8254 ENDP

; ------------------------------------------------------------
; 系统复位
; ------------------------------------------------------------
RESET_SYSTEM PROC NEAR
        MOV AL,INIT_TIME                             ; 取初始时间
        MOV CUR_TIME,AL                              ; 恢复当前时间
        MOV RUN_FLAG,0                               ; 清运行标志
        MOV LOCK_FLAG,0                              ; 清锁定标志
        MOV WINNER,0                                 ; 清获胜者标志
        MOV PB_BASE,00H                              ; 清蜂鸣器控制位
        CALL UPDATE_DISPLAY_BUF                      ; 更新显示缓冲
        RET
RESET_SYSTEM ENDP

; ------------------------------------------------------------
; 检测开始键
; 约定 PC0 为开始键，低电平按下
; ------------------------------------------------------------
CHECK_START_KEY PROC NEAR
        MOV DX,PC_8255                               ; DX指向C口
        IN AL,DX                                     ; 读取C口
        TEST AL,01H                                  ; 检测PC0
        JNZ CSK_EXIT                                 ; 若PC0=1，表示未按下
        CALL KEY_DELAY                               ; 按键消抖
        MOV DX,PC_8255                               ; DX指向C口
        IN AL,DX                                     ; 再读一次C口
        TEST AL,01H                                  ; 再检查PC0
        JNZ CSK_EXIT                                 ; 若第二次不是按下，则退出

        CALL RESET_SYSTEM                            ; 每次按开始都重新装初值
        MOV RUN_FLAG,1                               ; 进入运行状态

CSK_EXIT:
        RET
CHECK_START_KEY ENDP

; ------------------------------------------------------------
; 检测抢答键
; 约定 PC1 为1号，PC2为2号，低电平按下
; 只有 RUN_FLAG=1 且 LOCK_FLAG=0 时才有效
; ------------------------------------------------------------
CHECK_ANSWER_KEY PROC NEAR
        CMP RUN_FLAG,1                               ; 必须已经开始
        JNE CAK_EXIT                                 ; 否则退出
        CMP LOCK_FLAG,0                              ; 必须未锁定
        JNE CAK_EXIT                                 ; 否则退出

        MOV DX,PC_8255                               ; DX指向C口
        IN AL,DX                                     ; 读取C口
        TEST AL,02H                                  ; 检测PC1
        JZ CHECK_PLAYER2                            ; 若PC1未按，则去检查2号
        CALL KEY_DELAY                               ; 消抖
        MOV DX,PC_8255                               ; DX指向C口
        IN AL,DX                                     ; 再次读取C口
        TEST AL,02H                                  ; 再次检测PC1
        JNZ CHECK_PLAYER2                            ; 若抖动后无效，则检查2号

        MOV WINNER,1                                 ; 记录1号获胜
        MOV LOCK_FLAG,1                              ; 锁定系统
        MOV RUN_FLAG,0                               ; 停止倒计时
        CALL BEEP_ONCE                               ; 蜂鸣器响一下
        JMP CAK_EXIT

CHECK_PLAYER2:
        MOV DX,PC_8255                               ; DX指向C口
        IN AL,DX                                     ; 读取C口
        TEST AL,04H                                  ; 检测PC2
        JNZ CAK_EXIT                                 ; 若PC2未按则退出
        CALL KEY_DELAY                               ; 消抖
        MOV DX,PC_8255                               ; DX指向C口
        IN AL,DX                                     ; 再读一次C口
        TEST AL,04H                                  ; 再次检测PC2
        JNZ CAK_EXIT                                 ; 若抖动后无效则退出

        MOV WINNER,2                                 ; 记录2号获胜
        MOV LOCK_FLAG,1                              ; 锁定系统
        MOV RUN_FLAG,0                               ; 停止倒计时
        CALL BEEP_ONCE                               ; 蜂鸣器响一下

CAK_EXIT:
        RET
CHECK_ANSWER_KEY ENDP

; ------------------------------------------------------------
; 更新显示缓冲
; 把 CUR_TIME 拆成十位和个位
; ------------------------------------------------------------
UPDATE_DISPLAY_BUF PROC NEAR
        MOV AL,CUR_TIME                              ; 取当前时间
        AAM                                          ; AH为十位，AL为个位
        MOV SHOW_TEN,AH                              ; 保存十位
        MOV SHOW_ONE,AL                              ; 保存个位
        RET
UPDATE_DISPLAY_BUF ENDP

; ------------------------------------------------------------
; 动态扫描显示
; PA接段码
; PB0接S0，PB1接S1
; PB7为蜂鸣器
; 默认位选高电平有效
; ------------------------------------------------------------
SCAN_DISPLAY PROC NEAR
        PUSH AX                                      ; 保护寄存器
        PUSH BX
        PUSH DX

        ; ---------- 第一个数码管 ----------
        ; 这里先显示十位，你也可以后面换成个位
        MOV DX,PA_8255                               ; 先灭段码
        MOV AL,00H
        OUT DX,AL

        MOV AL,PB_BASE                               ; 取PB基础状态（保留PB7蜂鸣器）
        AND AL,0FCH                                  ; 清PB0、PB1
        OR  AL,01H                                   ; PB0=1，选中第一个数码管
        MOV DX,PB_8255
        OUT DX,AL

        MOV BL,SHOW_TEN                              ; 第一个数码管显示十位
        XOR BH,BH
        MOV AL,SEG_TAB[BX]                           ; 查段码
        MOV DX,PA_8255
        OUT DX,AL
        CALL SHORT_DELAY

        MOV DX,PA_8255                               ; 灭段码
        MOV AL,00H
        OUT DX,AL

        MOV DX,PB_8255                               ; 关位选
        MOV AL,PB_BASE
        AND AL,0FCH
        OUT DX,AL

        ; ---------- 第二个数码管 ----------
        MOV DX,PA_8255                               ; 先灭段码
        MOV AL,00H
        OUT DX,AL

        MOV AL,PB_BASE                               ; 取PB基础状态
        AND AL,0FCH                                  ; 清PB0、PB1
        OR  AL,02H                                   ; PB1=1，选中第二个数码管
        MOV DX,PB_8255
        OUT DX,AL

        MOV BL,SHOW_ONE                              ; 第二个数码管显示个位
        XOR BH,BH
        MOV AL,SEG_TAB[BX]                           ; 查段码
        MOV DX,PA_8255
        OUT DX,AL
        CALL SHORT_DELAY

        MOV DX,PA_8255                               ; 灭段码
        MOV AL,00H
        OUT DX,AL

        MOV DX,PB_8255                               ; 关位选
        MOV AL,PB_BASE
        AND AL,0FCH
        OUT DX,AL

        POP DX                                       ; 恢复寄存器
        POP BX
        POP AX
        RET
SCAN_DISPLAY ENDP

; ------------------------------------------------------------
; 10ms等待
; 利用8254通道0，输入时钟1MHz
; 10ms对应计数值10000
; 采用读当前计数值是否减到0的方法轮询
; ------------------------------------------------------------
WAIT_10MS PROC NEAR
        PUSH CX

        MOV CX,4          ; 这个值你可以再微调
WT_LOOP:
        CALL SCAN_DISPLAY
        LOOP WT_LOOP

        POP CX
        RET
WAIT_10MS ENDP; ------------------------------------------------------------
; 蜂鸣器响一次
; PB7接蜂鸣器，置1响，保持约200ms
; ------------------------------------------------------------
BEEP_ONCE PROC NEAR
        PUSH CX                                      ; 保护CX

        MOV AL,PB_BASE                               ; 读取基础状态
        OR AL,80H                                    ; 置位PB7
        MOV PB_BASE,AL                               ; 保存状态

        MOV CX,2                                    ; 约20个10ms

BEEP_LOOP:
        CALL WAIT_10MS                               ; 等待10ms
        LOOP BEEP_LOOP                               ; 重复20次

        MOV AL,PB_BASE                               ; 取当前状态
        AND AL,7FH                                   ; 清PB7
        MOV PB_BASE,AL                               ; 保存状态

        POP CX                                       ; 恢复CX
        RET
BEEP_ONCE ENDP

; ------------------------------------------------------------
; 按键消抖延时
; ------------------------------------------------------------
KEY_DELAY PROC NEAR
        PUSH CX                                      ; 保护CX
        MOV CX,3                                  ; 软件延时
KD1:    LOOP KD1
        POP CX                                       ; 恢复CX
        RET
KEY_DELAY ENDP

; ------------------------------------------------------------
; 数码管短延时
; ------------------------------------------------------------
SHORT_DELAY PROC NEAR
        PUSH CX                                      ; 保护CX
        MOV CX,2                                   ; 动态扫描保持时间
SD1:    LOOP SD1
        POP CX                                       ; 恢复CX
        RET
SHORT_DELAY ENDP

CODE ENDS
END START`,
};

PROGRAMS["buzzer-fixed"] = {
  id: "buzzer-fixed",
  name: "抢答计时器（修正版）",
  subtitle: "只改了一行 JZ → JNZ",
  note: `把 CHECK_ANSWER_KEY 里第一处 JZ CHECK_PLAYER2 改成 JNZ，1 号键就正常了。其余代码完全不变。`,
  board: "buzzer",
  ports: { PA: 0x298, PB: 0x299, PC: 0x29a, CTRL: 0x29b },
  timerPorts: { CNT0: 0x280, CTL: 0x283 },
  keys: [
    { bit: 0, label: "开始", hint: "PC0" },
    { bit: 1, label: "1 号抢答", hint: "PC1" },
    { bit: 2, label: "2 号抢答", hint: "PC2" },
  ],
  buzzerBit: 7,
  secondsPerTick: 30000,
  source: `DATA SEGMENT                                         ; 数据段开始

CNT0_8254   EQU 280H                                 ; 8254通道0端口地址
CTL_8254    EQU 283H                                 ; 8254控制口地址

PA_8255     EQU 298H                                 ; 8255 A口地址
PB_8255     EQU 299H                                 ; 8255 B口地址
PC_8255     EQU 29AH                                 ; 8255 C口地址
CTL_8255    EQU 29BH                                 ; 8255控制口地址

INIT_TIME   DB 20                                    ; 初始倒计时秒数
CUR_TIME    DB 20                                    ; 当前剩余秒数

SHOW_TEN    DB 2                                     ; 显示缓冲：十位
SHOW_ONE    DB 0                                     ; 显示缓冲：个位

RUN_FLAG    DB 0                                     ; 运行标志，0表示未开始，1表示正在倒计时
LOCK_FLAG   DB 0                                     ; 锁定标志，0表示未锁定，1表示已经结束
WINNER      DB 0                                     ; 抢答结果，0无人，1号选手，2号选手

PB_BASE     DB 00H                                   ; PB口基础状态缓存，PB7给蜂鸣器，其余位选按需叠加
TICK_CNT    DW 100                                   ; 100个10ms构成1秒

SEG_TAB     DB 3FH                                   ; 0 的段码
            DB 06H                                   ; 1 的段码
            DB 5BH                                   ; 2 的段码
            DB 4FH                                   ; 3 的段码
            DB 66H                                   ; 4 的段码
            DB 6DH                                   ; 5 的段码
            DB 7DH                                   ; 6 的段码
            DB 07H                                   ; 7 的段码
            DB 7FH                                   ; 8 的段码
            DB 6FH                                   ; 9 的段码

DATA ENDS                                            ; 数据段结束

CODE SEGMENT                                         ; 代码段开始
ASSUME CS:CODE,DS:DATA                               ; 指定段寄存器

START:                                               ; 程序入口
        MOV AX,DATA                                  ; 数据段地址送AX
        MOV DS,AX                                    ; 初始化DS

        CALL INIT_8255                               ; 初始化8255
        CALL INIT_8254                               ; 初始化8254
        CALL RESET_SYSTEM                            ; 初始化系统状态

MAIN_WAIT:                                           ; 待机主循环
        CALL SCAN_DISPLAY                            ; 动态扫描数码管
        CALL CHECK_START_KEY                         ; 检测开始键
        CMP RUN_FLAG,1                               ; 判断是否已经开始
        JNE MAIN_WAIT                                ; 未开始就一直待机

COUNTDOWN_LOOP:                                      ; 倒计时外层循环
        MOV TICK_CNT,100                             ; 装入100个10ms作为1秒

ONE_SECOND_LOOP:                                     ; 1秒内部循环
        CALL WAIT_10MS                               ; 等待10ms，同时内部也会检测按键和刷新显示
        CALL CHECK_ANSWER_KEY
        CMP LOCK_FLAG,1                              ; 判断是否已经有人抢答或超时
        JE HOLD_RESULT                               ; 若已锁定则转入结果保持
        DEC TICK_CNT                                 ; 10ms计数减1
        JNZ ONE_SECOND_LOOP                          ; 未满1秒则继续

        DEC CUR_TIME                                 ; 满1秒后剩余时间减1
        CALL UPDATE_DISPLAY_BUF                      ; 更新显示缓冲
        CMP CUR_TIME,0                               ; 判断是否减到0
        JNZ COUNTDOWN_LOOP                           ; 不为0则继续下一秒

        MOV LOCK_FLAG,1                              ; 到0则锁定系统
        MOV RUN_FLAG,0                               ; 结束倒计时
        JMP HOLD_RESULT                              ; 进入保持状态

HOLD_RESULT:                                         ; 结果保持状态
        CALL SCAN_DISPLAY                            ; 持续刷新数码管
        JMP HOLD_RESULT                              ; 一直停在这里

; ------------------------------------------------------------
; 8255初始化
; PA输出，PB输出，PC低4位输入，PC高4位输出，模式0
; 控制字 = 1000 0001B = 81H
; ------------------------------------------------------------
INIT_8255 PROC NEAR
        MOV DX,CTL_8255                              ; DX指向8255控制口
        MOV AL,81H                                   ; 设置8255工作方式
        OUT DX,AL                                    ; 写8255控制字

        MOV DX,PA_8255                               ; DX指向A口
        MOV AL,00H                                   ; 清零输出
        OUT DX,AL                                    ; 清A口

        MOV DX,PB_8255                               ; DX指向B口
        OUT DX,AL                                    ; 清B口
        RET
INIT_8255 ENDP

; ------------------------------------------------------------
; 8254初始化
; 通道0用模式0，二进制计数，先写低字节后写高字节
; 控制字 = 0011 0000B = 30H
; ------------------------------------------------------------
INIT_8254 PROC NEAR
        MOV DX,CTL_8254                              ; DX指向8254控制口
        MOV AL,30H                                   ; 通道0，低高字节，模式0
        OUT DX,AL                                    ; 写控制字
        RET
INIT_8254 ENDP

; ------------------------------------------------------------
; 系统复位
; ------------------------------------------------------------
RESET_SYSTEM PROC NEAR
        MOV AL,INIT_TIME                             ; 取初始时间
        MOV CUR_TIME,AL                              ; 恢复当前时间
        MOV RUN_FLAG,0                               ; 清运行标志
        MOV LOCK_FLAG,0                              ; 清锁定标志
        MOV WINNER,0                                 ; 清获胜者标志
        MOV PB_BASE,00H                              ; 清蜂鸣器控制位
        CALL UPDATE_DISPLAY_BUF                      ; 更新显示缓冲
        RET
RESET_SYSTEM ENDP

; ------------------------------------------------------------
; 检测开始键
; 约定 PC0 为开始键，低电平按下
; ------------------------------------------------------------
CHECK_START_KEY PROC NEAR
        MOV DX,PC_8255                               ; DX指向C口
        IN AL,DX                                     ; 读取C口
        TEST AL,01H                                  ; 检测PC0
        JNZ CSK_EXIT                                 ; 若PC0=1，表示未按下
        CALL KEY_DELAY                               ; 按键消抖
        MOV DX,PC_8255                               ; DX指向C口
        IN AL,DX                                     ; 再读一次C口
        TEST AL,01H                                  ; 再检查PC0
        JNZ CSK_EXIT                                 ; 若第二次不是按下，则退出

        CALL RESET_SYSTEM                            ; 每次按开始都重新装初值
        MOV RUN_FLAG,1                               ; 进入运行状态

CSK_EXIT:
        RET
CHECK_START_KEY ENDP

; ------------------------------------------------------------
; 检测抢答键
; 约定 PC1 为1号，PC2为2号，低电平按下
; 只有 RUN_FLAG=1 且 LOCK_FLAG=0 时才有效
; ------------------------------------------------------------
CHECK_ANSWER_KEY PROC NEAR
        CMP RUN_FLAG,1                               ; 必须已经开始
        JNE CAK_EXIT                                 ; 否则退出
        CMP LOCK_FLAG,0                              ; 必须未锁定
        JNE CAK_EXIT                                 ; 否则退出

        MOV DX,PC_8255                               ; DX指向C口
        IN AL,DX                                     ; 读取C口
        TEST AL,02H                                  ; 检测PC1
        JNZ CHECK_PLAYER2                            ; 若PC1未按，则去检查2号
        CALL KEY_DELAY                               ; 消抖
        MOV DX,PC_8255                               ; DX指向C口
        IN AL,DX                                     ; 再次读取C口
        TEST AL,02H                                  ; 再次检测PC1
        JNZ CHECK_PLAYER2                            ; 若抖动后无效，则检查2号

        MOV WINNER,1                                 ; 记录1号获胜
        MOV LOCK_FLAG,1                              ; 锁定系统
        MOV RUN_FLAG,0                               ; 停止倒计时
        CALL BEEP_ONCE                               ; 蜂鸣器响一下
        JMP CAK_EXIT

CHECK_PLAYER2:
        MOV DX,PC_8255                               ; DX指向C口
        IN AL,DX                                     ; 读取C口
        TEST AL,04H                                  ; 检测PC2
        JNZ CAK_EXIT                                 ; 若PC2未按则退出
        CALL KEY_DELAY                               ; 消抖
        MOV DX,PC_8255                               ; DX指向C口
        IN AL,DX                                     ; 再读一次C口
        TEST AL,04H                                  ; 再次检测PC2
        JNZ CAK_EXIT                                 ; 若抖动后无效则退出

        MOV WINNER,2                                 ; 记录2号获胜
        MOV LOCK_FLAG,1                              ; 锁定系统
        MOV RUN_FLAG,0                               ; 停止倒计时
        CALL BEEP_ONCE                               ; 蜂鸣器响一下

CAK_EXIT:
        RET
CHECK_ANSWER_KEY ENDP

; ------------------------------------------------------------
; 更新显示缓冲
; 把 CUR_TIME 拆成十位和个位
; ------------------------------------------------------------
UPDATE_DISPLAY_BUF PROC NEAR
        MOV AL,CUR_TIME                              ; 取当前时间
        AAM                                          ; AH为十位，AL为个位
        MOV SHOW_TEN,AH                              ; 保存十位
        MOV SHOW_ONE,AL                              ; 保存个位
        RET
UPDATE_DISPLAY_BUF ENDP

; ------------------------------------------------------------
; 动态扫描显示
; PA接段码
; PB0接S0，PB1接S1
; PB7为蜂鸣器
; 默认位选高电平有效
; ------------------------------------------------------------
SCAN_DISPLAY PROC NEAR
        PUSH AX                                      ; 保护寄存器
        PUSH BX
        PUSH DX

        ; ---------- 第一个数码管 ----------
        ; 这里先显示十位，你也可以后面换成个位
        MOV DX,PA_8255                               ; 先灭段码
        MOV AL,00H
        OUT DX,AL

        MOV AL,PB_BASE                               ; 取PB基础状态（保留PB7蜂鸣器）
        AND AL,0FCH                                  ; 清PB0、PB1
        OR  AL,01H                                   ; PB0=1，选中第一个数码管
        MOV DX,PB_8255
        OUT DX,AL

        MOV BL,SHOW_TEN                              ; 第一个数码管显示十位
        XOR BH,BH
        MOV AL,SEG_TAB[BX]                           ; 查段码
        MOV DX,PA_8255
        OUT DX,AL
        CALL SHORT_DELAY

        MOV DX,PA_8255                               ; 灭段码
        MOV AL,00H
        OUT DX,AL

        MOV DX,PB_8255                               ; 关位选
        MOV AL,PB_BASE
        AND AL,0FCH
        OUT DX,AL

        ; ---------- 第二个数码管 ----------
        MOV DX,PA_8255                               ; 先灭段码
        MOV AL,00H
        OUT DX,AL

        MOV AL,PB_BASE                               ; 取PB基础状态
        AND AL,0FCH                                  ; 清PB0、PB1
        OR  AL,02H                                   ; PB1=1，选中第二个数码管
        MOV DX,PB_8255
        OUT DX,AL

        MOV BL,SHOW_ONE                              ; 第二个数码管显示个位
        XOR BH,BH
        MOV AL,SEG_TAB[BX]                           ; 查段码
        MOV DX,PA_8255
        OUT DX,AL
        CALL SHORT_DELAY

        MOV DX,PA_8255                               ; 灭段码
        MOV AL,00H
        OUT DX,AL

        MOV DX,PB_8255                               ; 关位选
        MOV AL,PB_BASE
        AND AL,0FCH
        OUT DX,AL

        POP DX                                       ; 恢复寄存器
        POP BX
        POP AX
        RET
SCAN_DISPLAY ENDP

; ------------------------------------------------------------
; 10ms等待
; 利用8254通道0，输入时钟1MHz
; 10ms对应计数值10000
; 采用读当前计数值是否减到0的方法轮询
; ------------------------------------------------------------
WAIT_10MS PROC NEAR
        PUSH CX

        MOV CX,4          ; 这个值你可以再微调
WT_LOOP:
        CALL SCAN_DISPLAY
        LOOP WT_LOOP

        POP CX
        RET
WAIT_10MS ENDP; ------------------------------------------------------------
; 蜂鸣器响一次
; PB7接蜂鸣器，置1响，保持约200ms
; ------------------------------------------------------------
BEEP_ONCE PROC NEAR
        PUSH CX                                      ; 保护CX

        MOV AL,PB_BASE                               ; 读取基础状态
        OR AL,80H                                    ; 置位PB7
        MOV PB_BASE,AL                               ; 保存状态

        MOV CX,2                                    ; 约20个10ms

BEEP_LOOP:
        CALL WAIT_10MS                               ; 等待10ms
        LOOP BEEP_LOOP                               ; 重复20次

        MOV AL,PB_BASE                               ; 取当前状态
        AND AL,7FH                                   ; 清PB7
        MOV PB_BASE,AL                               ; 保存状态

        POP CX                                       ; 恢复CX
        RET
BEEP_ONCE ENDP

; ------------------------------------------------------------
; 按键消抖延时
; ------------------------------------------------------------
KEY_DELAY PROC NEAR
        PUSH CX                                      ; 保护CX
        MOV CX,3                                  ; 软件延时
KD1:    LOOP KD1
        POP CX                                       ; 恢复CX
        RET
KEY_DELAY ENDP

; ------------------------------------------------------------
; 数码管短延时
; ------------------------------------------------------------
SHORT_DELAY PROC NEAR
        PUSH CX                                      ; 保护CX
        MOV CX,2                                   ; 动态扫描保持时间
SD1:    LOOP SD1
        POP CX                                       ; 恢复CX
        RET
SHORT_DELAY ENDP

CODE ENDS
END START`,
};

PROGRAMS.adc = {
  id: "adc",
  name: "ADC0808 定时采样",
  subtitle: "8253 两级分频 10Hz · 8259 中断 · 数码管显示高 4 位",
  note: "8253 把 1MHz 分频成 10Hz 送 8259 的 IR0，中断服务程序启动 ADC 转换、取高 4 位送到数码管。拖动右上的模拟电压滑块，数码管会跟着变。",
  board: "adc",
  ports: {
    PPI_PA: 0x0100, PPI_PB: 0x0102, PPI_PC: 0x0104, PPI_CTRL: 0x0106,
    CNT0: 0x0200, CNT1: 0x0202, TIMER_CTRL: 0x0206,
    PIC_CMD: 0x0300, PIC_DATA: 0x0302,
    ADC: 0x0400,
  },
  analog: { min: 0, max: 255, default: 200, label: "模拟输入" },
  source: `
; ==================================================================
; 微机课设仿真实验 - 重构版本
; 功能描述：
;   利用8253定时器、8259中断控制器和ADC0808模数转换器
;   实现10Hz定时采样，并在七段数码管上显示结果
; ==================================================================

; ******************************************************************
; 向量表段
; ******************************************************************
VECTOR_TABLE SEGMENT
    DB 1024 DUP(0)
VECTOR_TABLE ENDS

; ******************************************************************
; 存储段
; ******************************************************************
STORAGE SEGMENT
    ; 七段数码管显示表（共阴极）
    SEG_DISPLAY DB 3FH, 06H, 5BH, 4FH
                DB 66H, 6DH, 7DH, 07H
                DB 7FH, 6FH, 77H, 7CH
                DB 39H, 5EH, 79H, 71H
STORAGE ENDS

; ******************************************************************
; 栈空间段
; ******************************************************************
STACK_SEG SEGMENT STACK
    DB 256 DUP(0)
STACK_SEG ENDS

; ******************************************************************
; 程序段
; ******************************************************************
CODE_SEG SEGMENT
    ASSUME CS:CODE_SEG, DS:STORAGE, SS:STACK_SEG

; ******************************************************************
; 硬件端口定义
; ******************************************************************
PPI_PORT_B   EQU 0102H
PPI_CTRL_REG EQU 0106H

CNT0_ADDR    EQU 0200H
CNT1_ADDR    EQU 0202H
TIMER_CTRL   EQU 0206H

PIC_CMD_PORT EQU 0300H
PIC_DAT_PORT EQU 0302H

ADC_IO_PORT  EQU 0400H

IRQ_TYPE     EQU 60H
PIC_EOI      EQU 20H

; ******************************************************************
; 程序入口点
; ******************************************************************
ENTRY_POINT:
    ; 配置数据段寄存器
    MOV AX, STORAGE
    MOV DS, AX

    ; 配置栈段寄存器
    MOV AX, STACK_SEG
    MOV SS, AX
    MOV SP, 0100H

    ; 关中断
    CLI

    ; 初始化各模块
    CALL SETUP_INTERRUPT
    CALL INIT_PARALLEL_PORT
    CALL INIT_TIMER_MODULE
    CALL INIT_INTERRUPT_CTRL

    ; 开中断
    STI

; ******************************************************************
; 主循环
; ******************************************************************
MAIN_CYCLE:
    HLT
    JMP MAIN_CYCLE

; ******************************************************************
; 子程序：设置中断向量
; ******************************************************************
SETUP_INTERRUPT PROC NEAR
    PUSH AX
    PUSH BX
    PUSH ES

    ; 指向中断向量表
    XOR AX, AX
    MOV ES, AX

    ; 计算中断向量位置
    MOV BX, IRQ_TYPE
    SHL BX, 1
    SHL BX, 1

    ; 设置偏移地址
    MOV AX, OFFSET IRQ_HANDLER
    MOV ES:[BX], AX

    ; 设置段地址
    MOV AX, CS
    MOV ES:[BX+2], AX

    POP ES
    POP BX
    POP AX
    RET
SETUP_INTERRUPT ENDP

; ******************************************************************
; 子程序：初始化8255并行接口
; ******************************************************************
INIT_PARALLEL_PORT PROC NEAR
    PUSH AX
    PUSH DX

    ; 方式0，全部端口输出
    MOV DX, PPI_CTRL_REG
    MOV AL, 80H
    OUT DX, AL

    POP DX
    POP AX
    RET
INIT_PARALLEL_PORT ENDP

; ******************************************************************
; 子程序：初始化8253定时器
; ******************************************************************
INIT_TIMER_MODULE PROC NEAR
    PUSH AX
    PUSH DX

    ; 配置计数器0：方式3，初值1000
    MOV DX, TIMER_CTRL
    MOV AL, 36H
    OUT DX, AL

    MOV DX, CNT0_ADDR
    MOV AL, 0E8H
    OUT DX, AL
    MOV AL, 03H
    OUT DX, AL

    ; 配置计数器1：方式2，初值100
    MOV DX, TIMER_CTRL
    MOV AL, 74H
    OUT DX, AL

    MOV DX, CNT1_ADDR
    MOV AL, 64H
    OUT DX, AL
    MOV AL, 00H
    OUT DX, AL

    POP DX
    POP AX
    RET
INIT_TIMER_MODULE ENDP

; ******************************************************************
; 子程序：初始化8259中断控制器
; ******************************************************************
INIT_INTERRUPT_CTRL PROC NEAR
    PUSH AX
    PUSH DX

    ; ICW1
    MOV DX, PIC_CMD_PORT
    MOV AL, 13H
    OUT DX, AL

    ; ICW2
    MOV DX, PIC_DAT_PORT
    MOV AL, IRQ_TYPE
    OUT DX, AL

    ; ICW4
    MOV AL, 01H
    OUT DX, AL

    ; 仅开放IR0
    MOV AL, 0FEH
    OUT DX, AL

    POP DX
    POP AX
    RET
INIT_INTERRUPT_CTRL ENDP

; ******************************************************************
; 中断处理程序
; ******************************************************************
IRQ_HANDLER PROC FAR
    PUSH AX
    PUSH BX
    PUSH CX
    PUSH DX
    PUSH DS

    ; 确保数据段正确
    MOV AX, STORAGE
    MOV DS, AX

    ; 启动ADC转换
    CALL TRIGGER_ADC

    ; 等待转换完成
    CALL WAIT_ADC_DONE

    ; 读取并处理ADC数据
    CALL PROCESS_ADC_DATA

    ; 发送EOI命令
    CALL SEND_EOI_TO_PIC

    ; 恢复现场
    POP DS
    POP DX
    POP CX
    POP BX
    POP AX

    IRET
IRQ_HANDLER ENDP

; ******************************************************************
; 子程序：触发ADC转换
; ******************************************************************
TRIGGER_ADC PROC NEAR
    PUSH AX
    PUSH DX

    MOV DX, ADC_IO_PORT
    XOR AL, AL
    OUT DX, AL

    POP DX
    POP AX
    RET
TRIGGER_ADC ENDP

; ******************************************************************
; 子程序：等待ADC转换
; ******************************************************************
WAIT_ADC_DONE PROC NEAR
    PUSH CX

    MOV CX, 00FFH
DELAY_LOOP:
    LOOP DELAY_LOOP

    POP CX
    RET
WAIT_ADC_DONE ENDP

; ******************************************************************
; 子程序：处理ADC数据并显示
; ******************************************************************
PROCESS_ADC_DATA PROC NEAR
    PUSH AX
    PUSH BX
    PUSH CX
    PUSH DX

    ; 读取ADC数据
    MOV DX, ADC_IO_PORT
    IN AL, DX

    ; 提取高4位
    MOV CL, 04H
    SHR AL, CL

    ; 查表获取段码
    MOV BX, OFFSET SEG_DISPLAY
    XLAT

    ; 输出到数码管
    MOV DX, PPI_PORT_B
    OUT DX, AL

    POP DX
    POP CX
    POP BX
    POP AX
    RET
PROCESS_ADC_DATA ENDP

; ******************************************************************
; 子程序：发送中断结束命令
; ******************************************************************
SEND_EOI_TO_PIC PROC NEAR
    PUSH AX
    PUSH DX

    MOV DX, PIC_CMD_PORT
    MOV AL, PIC_EOI
    OUT DX, AL

    POP DX
    POP AX
    RET
SEND_EOI_TO_PIC ENDP

CODE_SEG ENDS
END ENTRY_POINT`,
};
