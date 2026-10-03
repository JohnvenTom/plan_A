# assets/sfx — 音效素材文件夹

游戏音效文件统一放在这里。当前 `js/audio.js` 是纯程序化合成（WebAudio 实时生成，
零素材依赖）；往本文件夹放入音效文件后，需要在 audio.js 里接入加载与播放
（告诉 ZCode 文件名即可，例如"把 explosion.mp3 接到爆炸事件上"）。

## 命名约定

按游戏事件命名，全小写 + 下划线，与 audio.js 里的方法一一对应：

| 事件方法 | 语义 |
|---|---|
| gun | 机炮 |
| missile_launch | IR 弹发射 |
| radar_launch | 雷达弹发射 |
| explosion | 爆炸 |
| kill | 击坠确认 |
| sonic_boom | 音爆 |
| flare | 抛射干扰弹 |
| lock | 锁定 |
| warm_start / warm_ready / warm_cancel | 导弹预热 |
| seek_bite | 红外导引头咬住 |
| near_miss | 近失弹掠过 |
| hit_ting / hit_taken | 命中提示 / 被击中 |
| engine / wind | 引擎与风声（循环） |

## 格式建议

- 首选 `mp3`（体积小，浏览器全兼容）；需要零延迟的短促音效用 `wav`
- 循环音（引擎/风）确保首尾平滑，避免爆音
- 采样率 44100 Hz，单声道即可（游戏内不做 3D 声像）
