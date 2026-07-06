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
- **局部重绘（Inpaint）** —— 用蒙版圈选区域后重绘，配套蒙版编辑覆盖层。
- **AI 助手侧边栏** —— 集成对话式 AI 助手。
- **自定义智能体与技能** —— 配置文本智能体、视觉智能体、自定义智能体（Custom Agent）与技能（Skill）。
- **多端点 API** —— 支持配置多个 AI 服务端点与模型。
- **生成日志与任务列表** —— 记录生成任务，支持任务索引与回溯。

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

> Lumina 的长期目标是一个解谜游戏层（激光光路、阴影揭秘），当前光影 / 材质引擎（M1、M2）已落地。

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
