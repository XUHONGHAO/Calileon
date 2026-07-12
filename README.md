<div align="center">
  <h1>Calileon</h1>
  <h3>手绘风格的 AI 无限画布</h3>
  <p>
    在 <a href="https://github.com/excalidraw/excalidraw">Excalidraw</a> 基础上二次开发，融合了 AI 图像工作台、云端协作与画布光影引擎的开源白板。
  </p>
</div>

<p align="center">
  <a href="./LICENSE">
    <img alt="License MIT" src="https://img.shields.io/badge/license-MIT-blue.svg" /></a>
  <a href="https://calileon.com">
    <img alt="Website" src="https://img.shields.io/badge/website-calileon.com-brightgreen.svg" /></a>
</p>

---

## 简介

Calileon 是基于 [Excalidraw](https://github.com/excalidraw/excalidraw) 的二次开发版本。它保留了 Excalidraw 全部的手绘风格无限画布能力，并在此之上加入了四类自研能力：

- **AI 工作台** —— 在画布内直接生成、编辑、局部重绘图片，并接入自定义智能体与技能。
- **云端与协作** —— 基于 Supabase 的账号登录、云端白板、资源存储、分享链接与多人实时协作。
- **Lumina 点一盏灯** —— 画布光影与材质引擎，支持点光/聚光/太阳光、实时软阴影、玻璃与镜面反射。
- **自部署** —— 完整的 Docker + Nginx 部署方案，可从纯前端客户端逐步接入后端能力。

项目遵循与上游一致的 MIT 许可证，品牌与域名为 **Calileon / [calileon.com](https://calileon.com)**。

---

## 核心能力

### 画布基础（继承自 Excalidraw）

- 🎨 无限画布，手绘风格。
- 🌓 深色模式。
- ⚒️ 矩形、圆形、菱形、箭头、线条、自由绘制、橡皮擦等工具。
- ➡️ 箭头绑定与带标签箭头。
- 🖼️ 导出 PNG、SVG 与剪贴板；`.excalidraw` JSON 格式。
- 🔍 缩放与平移，撤销 / 重做。
- 🌐 多语言支持，含简体中文（`zh-CN`）、繁体中文（`zh-TW`、`zh-HK`）。

### AI 工作台 / AI 媒体画布

在画布内完成从生成到编辑的完整 AI 图像流程：

- **创意生成** —— 通过提示词生成图片，支持参考图输入。
- **局部重绘（Inpaint）** —— 用蒙版圈选区域后重绘；蒙版拥有独立会话、撤销、视口几何映射、重新编辑与图像级绑定，不污染普通画布历史。
- **工作台草稿持久化** —— 参考图、局部重绘蒙版和不同生成模式的草稿按白板作用域保存到 IndexedDB，刷新页面后可以恢复，损坏记录会独立降级而不会拖垮其他草稿。
- **视频资产持久化** —— 生成视频可进入浏览器 Blob 缓存和可选 Supabase 对象存储，通过短期解析 URL 播放；场景、日志和分享数据不保存 provider 的完整签名 URL。
- **AI 助手侧边栏** —— 集成对话式 AI 助手。
- **自定义智能体与技能** —— 配置文本智能体、视觉智能体、自定义智能体（Custom Agent）与技能（Skill）。
- **多端点 API** —— 支持配置多个 AI 服务端点与模型。
- **生成日志与任务列表** —— 记录生成任务，支持任务索引、取消、恢复、视频资产迁移与回溯。

### 云端与协作（Supabase）

后端能力通过统一的适配层接入，纯前端模式下可完全降级为浏览器本地存储：

- **账号登录** —— 基于 Supabase Auth 的邮箱密码登录。
- **云端白板** —— 场景保存到云端，跨设备打开、重命名、删除。
- **资源存储** —— 图片等资源存入对象存储。
- **分享链接** —— 生成只读分享链接。
- **多人实时协作** —— 基于 `excalidraw-room` 的协作房间，支持协作快照恢复。
- **端到端加密** —— 可选的端到端加密云存储。

### Lumina 点一盏灯

画布光影与材质引擎，光照信息以 `customData` 挂载在普通元素上，屏幕渲染与导出路径一致：

- **多光源** —— 点光源、聚光灯（锥形）、太阳光（平行光）。
- **实时阴影** —— 拖动光源，阴影实时扫过。
- **材质系统** —— 实体、半透明、玻璃（透光）、镜面（虚像反射）、自发光。
- **光源属性面板** —— 颜色、强度、半径、锥角、方向可调。

Lumina 完全体已经落地：除光照与材质外，还包括 Snell 折射与焦散、point / spot / sun 镜面光学、激光解谜、阴影揭秘、黑屋探宝、可选游戏效果栅格导出，以及性能预算、样例关卡、i18n 与无障碍收口。生产渲染路径采用单一 Canvas2D + CPU 几何，不依赖 WebGL。

### 实验性画布功能

左侧主菜单的“实验性”入口集中承载当前白板实验能力，每个下一级功能都有独立 SVG 图标，并同步英文、简体中文和繁体中文：

- **单文件白板（P1）**：把当前白板导出为可离线运行、可继续编辑的单个 HTML 文件。支持浏览器授权后的覆盖保存；不支持覆盖时自动转为另存，并始终提供独立“另存为”。
- **边画边录（P2 Cast）**：使用 CastScript 记录场景、文件、视口和指针的语义变化，提供本地交互回放、导入导出和可选云端保存。MVP 不录制音频、视频和 Lumina 游戏效果。
- **Echo 锚点分身（U6）**：通过显式 `anchorId` 绑定多个分身，任意分身均可编辑；第一版同步文字、状态和背景色，并提供循环防护、复制粘贴与协作冲突处理。
- **嵌入式白板（P3 Embed）**：通过版本化 iframe 协议把白板嵌入其他网页，默认只读，支持完整、紧凑和演示预设、受控宿主通信、场景载入与导出。
- **连线语气（U4）**：为直线、箭头和肘形箭头增加确定、可能、阻塞、存疑四种结构化语义，同时保持用户原有样式，并在 Canvas、PNG、SVG、复制和持久化链路中保留。
- **异世界视角（G5 Many Minds）**：把同一图片、区域或文字输入交给多个视角有限并行生成，支持逐项失败恢复、刷新持久化、结果网格、替换原图和继续裂变。

这些功能和 Lumina 已共同接入主线的同一个“实验性”菜单，不需要分别启动不同工作树。

---

## 快速开始

本仓库是使用 Yarn 1 管理的 monorepo，Node 版本要求 `>=18`（推荐 Node 20 LTS）。

```bash
# 安装依赖
yarn install

# 启动开发服务器（默认端口 3000）
yarn start
```

常用脚本：

```bash
yarn test:typecheck   # TypeScript 类型检查
yarn test:app         # 应用测试
yarn test:update      # 运行全部测试并更新快照
yarn fix              # 自动修复格式与 lint 问题
yarn build            # 构建应用
```

### 目录结构

```
packages/excalidraw/   核心 React 组件库
packages/element/      元素数据模型与几何
packages/common/       共享常量与工具
packages/math/         数学工具
excalidraw-app/        完整 Web 应用（含 AI、云端、协作）
```

---

## 自部署

Calileon 可从纯前端客户端起步，按需接入 Supabase 与协作服务。

| 模式 | 需要的后端 | 支持能力 |
| --- | --- | --- |
| 纯前端客户端 | 无 | 画布编辑、浏览器本地保存、手动导入导出。 |
| 客户端 + Supabase | Supabase | 账号登录、云端白板、资源存储、分享链接。 |
| 客户端 + Supabase + room server | Supabase、`excalidraw-room` | 多人实时协作、协作房间绑定、快照恢复。 |

所有 `VITE_APP_*` 环境变量在构建时写入前端产物，修改后必须重新构建。只能放浏览器可见的公开配置（公开 URL、Supabase anon key、功能开关），**不要**放 `service_role` key、数据库密码或任何服务端密钥。

```bash
# 构建镜像
docker build -t calileon-self-hosted .

# 运行（仅绑定本机端口，由反向代理对外暴露）
docker run -d \
  --name calileon \
  --restart unless-stopped \
  -p 127.0.0.1:8080:80 \
  calileon-self-hosted
```

完整的环境变量说明、Supabase SQL 脚本清单、Nginx 反向代理与验证清单，见自部署指南：`dev-docs/docs/introduction/self-hosting.mdx`。

---

## 许可证与致谢

Calileon 基于 [Excalidraw](https://github.com/excalidraw/excalidraw) 二次开发，遵循 [MIT 许可证](./LICENSE)。感谢 Excalidraw 团队与社区提供的优秀开源基础。
