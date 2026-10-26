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
