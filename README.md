# SKY BARONESS — 皇牌空战

浏览器里的皇牌空战(Ace Combat)风格 3D 空战游戏。纯 [three.js](https://threejs.org)(WebGL,已本地 vendored,离线可玩),无任何外部资源——战机、地形、海洋、天空、音效全部程序化生成。

## 运行

需要通过本地 HTTP 服务器打开(ES Module 限制,不能直接双击 index.html):

```bash
cd plan_A
python -m http.server 8421
# 浏览器打开 http://127.0.0.1:8421
```

或 `npx serve .`。

## 操作

| 按键 | 功能 |
|---|---|
| W / S(或 ↑↓) | 俯冲 / 拉杆 |
| A / D(或 ←→) | 滚转(压杆转弯) |
| Q / E | 方向舵 |
| Shift / Ctrl | 加力提速 / 减速 |
| 空格(或左键) | 机炮 |
| F(或右键) | 发射导弹(需锁定) |
| C | 切换视角(追尾/远距/近距) |
| P | 暂停 |
| 回车 | 开始 / 重开 |

玩法:把敌机保持在机头前方锥形区内约 1 秒完成锁定(红圈收缩→LOCK),F 发射追踪导弹;机炮适合近距离乱斗。注意 MISSILE 告警——急转弯可以甩掉来袭导弹。飞出作战空域 15 秒任务失败,撞地坠毁。

## 调试参数

- `?t=N` — 确定性冻结帧:模拟 N 秒后渲染一帧(用于截图验证),冻结模式在 4.2/9.0/13.5s 定点自动发射导弹
- `?debug=1` — 在 `window.__game` 暴露内部状态(供无头测试)

## 架构

| 文件 | 职责 |
|---|---|
| `index.html` | 画布 + HUD 层 + 标题/结算界面 |
| `js/main.js` | 游戏循环、状态机、系统接线、`?t=` 冻结 harness |
| `js/sky.js` | 大气模型:天空穹顶着色器(渐变+太阳+Mie 前向光晕)、fbm 云层、雾、光照 |
| `js/terrain.js` | 岛链高度场(ridge fbm)、顶点色分层、海洋着色器(菲涅尔+太阳光带) |
| `js/jet.js` | 程序化战机建模(机身/三角翼/双垂尾/座舱/加力锥) |
| `js/player.js` | 街机飞行模型(四元数姿态)、追尾相机 |
| `js/enemies.js` | 敌机 AI(巡逻/追击/规避)、波次刷新 |
| `js/weapons.js` | 机炮弹道、锁定导弹(比例导引+近炸)、敌导弹 |
| `js/effects.js` | 粒子池:爆炸/尾烟/拉烟/火花 |
| `js/hud.js` | AC 风格 HUD(2D canvas) |
| `js/audio.js` | WebAudio 程序化音效 |
| `js/utils.js` | 种子 RNG、simplex 噪声、数学工具 |

渲染路径:所有材质输出 scene-linear,`renderer.toneMapping = ACESFilmic` 是唯一输出级(色调映射只做一次);天空、平行光、半球光、雾共享同一太阳方向。
