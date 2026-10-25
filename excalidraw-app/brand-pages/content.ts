import { BRAND_PAGE_URLS } from "./routes";

export type BrandLang = "en" | "zh-CN";
export type BrandPageId = "plus" | "security";

export const BRAND_LANGS: readonly BrandLang[] = ["en", "zh-CN"];

export interface BrandLink {
  label: string;
  href: string;
}

export interface BrandCard {
  title: string;
  body: string;
}

export interface BrandSection {
  /** Anchor id, stable across languages. */
  id: string;
  eyebrow: string;
  title: string;
  lead: string;
  cards: BrandCard[];
  note?: string;
  link?: BrandLink;
}

export interface BrandPageCopy {
  documentTitle: string;
  description: string;
  hero: {
    eyebrow: string;
    title: string;
    lead: string;
    primary: string;
    secondary: BrandLink;
  };
  sections: BrandSection[];
  closing: {
    title: string;
    lead: string;
    cta: string;
  };
}

export interface BrandChromeCopy {
  skipToContent: string;
  navLabel: string;
  navPlus: string;
  navSecurity: string;
  openApp: string;
  /** Label of the *other* language, shown on the toggle. */
  switchLanguage: string;
  switchLanguageLabel: string;
  footer: string;
}

export interface BrandCopy {
  chrome: BrandChromeCopy;
  pages: Record<BrandPageId, BrandPageCopy>;
}

// Feature copy mirrors what the app ships; keep it in step with the source
// (AI Workbench, data/vault/*, Labs menu) rather than promising more.
const en: BrandCopy = {
  chrome: {
    skipToContent: "Skip to content",
    navLabel: "Main",
    navPlus: "Calileon+",
    navSecurity: "Security",
    openApp: "Open app",
    switchLanguage: "中文",
    switchLanguageLabel: "切换到中文",
    footer: "Calileon · Hand-drawn whiteboard",
  },
  pages: {
    plus: {
      documentTitle: "Calileon+ · AI Workbench, Vault and Labs",
      description:
        "Calileon+ brings an AI Workbench, end-to-end encrypted Vault spaces and experimental Labs to the hand-drawn whiteboard.",
      hero: {
        eyebrow: "Calileon+",
        title: "More than a whiteboard",
        lead: "Generate with AI, collaborate in end-to-end encrypted Vaults, and try what is next in Labs, all on the same hand-drawn canvas.",
        primary: "Open Calileon",
        secondary: {
          label: "How we protect your data",
          href: BRAND_PAGE_URLS.security,
        },
      },
      sections: [
        {
          id: "ai",
          eyebrow: "AI Workbench",
          title: "Your canvas is the prompt",
          lead: "Select something on the canvas and use it as AI input. Results come back as ordinary elements you can keep editing.",
          cards: [
            {
              title: "Generate",
              body: "Create images, video and audio from a prompt, guided by reference images and reusable prompt templates.",
            },
            {
              title: "Inpaint",
              body: "Paint a mask over part of an image and regenerate only that region.",
            },
            {
              title: "AI Assistant and agents",
              body: "Chat in the sidebar with text, vision and custom agents, each with their own skills.",
            },
            {
              title: "Text to diagram",
              body: "Describe a process in words and get a diagram you can keep editing.",
            },
            {
              title: "Wireframe to code",
              body: "Turn a hand-drawn wireframe into a working HTML prototype.",
            },
            {
              title: "Generation log",
              body: "Every generation keeps its parameters, so you can reload settings or reuse results as references.",
            },
            {
              title: "Your models",
              body: "Connect your own model providers, or use the managed gateway when your deployment offers one.",
            },
          ],
          note: "AI features need a configured model service. Selected content is sent to the provider you configure.",
        },
        {
          id: "vault",
          eyebrow: "Vault",
          title: "Encrypted end to end, collaboration included",
          lead: "Vault is a separate, encrypted mode. Content is encrypted in your browser before it leaves the device; servers only store and relay ciphertext.",
          cards: [
            {
              title: "End-to-end encryption",
              body: "Scenes, live collaboration messages and attachments are all encrypted. The content key is never sent to a server.",
            },
            {
              title: "Viewer and editor invites",
              body: "Invite people as viewers or editors, with links valid for 24 hours, 7 days or without expiry.",
            },
            {
              title: "Revoke at any time",
              body: "Revoking an invite blocks new access and disconnects existing sessions.",
            },
            {
              title: "Fails closed",
              body: "If something goes wrong, Vault stops instead of quietly falling back to plaintext or an ordinary room.",
            },
            {
              title: "Self-hostable",
              body: "Run the whole stack on your own servers with the bundled deployment, backup and restore tooling.",
            },
          ],
          note: "Creating a Vault requires signing in on a deployment with Vault enabled.",
          link: {
            label: "Read the security details",
            href: BRAND_PAGE_URLS.security,
          },
        },
        {
          id: "labs",
          eyebrow: "Labs",
          title: "Try what is next",
          lead: "Experimental features live in the Labs submenu of the main menu. You can hide it in Preferences.",
          cards: [
            {
              title: "Lighting (Lumina)",
              body: "Give shapes materials such as glass, mirror or emissive, place lights and watch refraction and caustics.",
            },
            {
              title: "Echo anchors",
              body: "Bind elements to an anchor so their text, status and background colour stay in sync.",
            },
            {
              title: "Line tone",
              body: "Mark a connector as certain, possible, blocked or questioned.",
            },
            {
              title: "Cast",
              body: "Record scene, viewport and pointer changes as an interactive replay you can export.",
            },
            {
              title: "Many Minds",
              body: "Generate several AI perspectives on the same input in one batch, then branch from any result.",
            },
            {
              title: "Embed whiteboard",
              body: "Embed a board in other pages as a read-only preview, an editable embed or a presentation.",
            },
            {
              title: "Single-file board",
              body: "Export the board as a self-contained HTML file that runs and edits offline.",
            },
            {
              title: "Rorschach Mirror",
              body: "Scribble something and see what it reads into it.",
            },
            {
              title: "Shelf Life",
              body: "Give rectangle notes a shelf life. Expired notes turn yellow and can be torn off in one go.",
            },
            {
              title: "Synesthesia",
              body: "Let sound draw hand-drawn shapes on the canvas.",
            },
          ],
          note: "Labs features may change or be removed. Some need AI to be configured.",
        },
      ],
      closing: {
        title: "Start drawing",
        lead: "All of this lives in the same canvas.",
        cta: "Open Calileon",
      },
    },
    security: {
      documentTitle: "Security · Calileon",
      description:
        "How Calileon encrypts shared drawings, live collaboration and Vault spaces in your browser.",
      hero: {
        eyebrow: "Security",
        title: "Encrypted in your browser, keys stay with you",
        lead: "Shared and collaborative drawings are encrypted on your device before upload. Servers handle only ciphertext, and the decryption key travels in the link, not through the server.",
        primary: "Open Calileon",
        secondary: { label: "Explore Calileon+", href: BRAND_PAGE_URLS.plus },
      },
      sections: [
        {
          id: "sharing",
          eyebrow: "Share links and live collaboration",
          title: "The key lives after the #",
          lead: "When you create a share link or start a live session, Calileon generates a random key in your browser.",
          cards: [
            {
              title: "Encrypted before upload",
              body: "Scene content is encrypted with AES-GCM (128-bit) in the browser, then uploaded.",
            },
            {
              title: "Key in the URL fragment",
              body: "The key sits after the # in the link. Browsers never send that part to servers.",
            },
            {
              title: "Relay only",
              body: "The collaboration server forwards encrypted messages between participants and cannot read them.",
            },
          ],
        },
        {
          id: "vault",
          eyebrow: "Vault",
          title: "Stronger guarantees for sensitive work",
          lead: "Vault is a separate mode with its own protocol and stricter rules.",
          cards: [
            {
              title: "Per-purpose keys",
              body: "Each Vault has its own 256-bit root key. HKDF-SHA-256 derives separate AES-GCM keys for snapshots, live messages and attachments.",
            },
            {
              title: "Invites are not keys",
              body: "Invitation credentials are kept apart from the content key. The server stores only a hash of each invite to check access.",
            },
            {
              title: "Read-only viewers",
              body: "The server rejects content, snapshot and attachment writes from viewer invites.",
            },
            {
              title: "External calls off by default",
              body: "Inside a Vault, AI, external embeds and remote media are blocked. The one exception is your deployment's managed AI gateway, and only when you use it explicitly.",
            },
            {
              title: "Fails closed",
              body: "Unknown versions, failed decryption and revoked access are refused, never treated as plaintext or downgraded to an ordinary room.",
            },
          ],
        },
        {
          id: "limits",
          eyebrow: "Good to know",
          title: "What encryption does not cover",
          lead: "Knowing the limits helps you pick the right mode.",
          cards: [
            {
              title: "The link is the key",
              body: "Anyone with the full link can open the content. Treat share links and invites like passwords.",
            },
            {
              title: "Revoking does not rotate keys",
              body: "Revoking an invite blocks new access and disconnects current sessions, but a content key that was already disclosed is not rotated automatically.",
            },
            {
              title: "Local drafts",
              body: "Drawings you have not shared or saved to the cloud stay in this browser's storage. They are not uploaded, but not extra-encrypted either, so take care on shared computers.",
            },
            {
              title: "AI providers",
              body: "Outside a Vault, using AI sends the selected content to the model provider you configured, under that provider's policy.",
            },
            {
              title: "Metadata",
              body: "Servers cannot read your content, but they can see metadata such as room IDs, connection times, data sizes and IP addresses.",
            },
          ],
        },
      ],
      closing: {
        title: "Draw with confidence",
        lead: "Use a share link for everyday work and a Vault for anything sensitive.",
        cta: "Open Calileon",
      },
    },
  },
};

const zhCN: BrandCopy = {
  chrome: {
    skipToContent: "跳到正文",
    navLabel: "主导航",
    navPlus: "Calileon+",
    navSecurity: "安全",
    openApp: "打开画布",
    switchLanguage: "English",
    switchLanguageLabel: "Switch to English",
    footer: "Calileon · 手绘风格白板",
  },
  pages: {
    plus: {
      documentTitle: "Calileon+ · AI 工作台、Vault 与实验室",
      description:
        "Calileon+ 为手绘白板带来 AI 工作台、端到端加密的 Vault 空间和实验室功能。",
      hero: {
        eyebrow: "Calileon+",
        title: "不止是一块白板",
        lead: "用 AI 生成内容，在端到端加密的 Vault 里协作，再到实验室试试新玩法。这些都在同一块手绘画布上完成。",
        primary: "打开 Calileon",
        secondary: {
          label: "了解我们如何保护数据",
          href: BRAND_PAGE_URLS.security,
        },
      },
      sections: [
        {
          id: "ai",
          eyebrow: "AI 工作台",
          title: "画布就是提示词",
          lead: "在画布上选中内容，直接作为 AI 的输入。结果以普通元素回到画布，可以继续编辑。",
          cards: [
            {
              title: "创意生成",
              body: "根据提示词生成图像、视频和音频，可配合参考图与提示词模板。",
            },
            {
              title: "局部重绘",
              body: "在图像上涂出蒙版，只重新生成这一块区域。",
            },
            {
              title: "AI助手与智能体",
              body: "在侧边栏与文本智能体、视觉智能体和自定义智能体对话，每个智能体可以带上自己的技能。",
            },
            {
              title: "文字至图表",
              body: "用文字描述流程，生成可以继续编辑的图表。",
            },
            {
              title: "线框图至代码",
              body: "把手绘线框图转换成可运行的 HTML 原型。",
            },
            {
              title: "生成记录",
              body: "每次生成都会保留参数，可以重新载入设置，或把结果加入参考图。",
            },
            {
              title: "接入自己的模型",
              body: "接入你自己的模型服务商，或在部署方提供时使用托管网关。",
            },
          ],
          note: "AI 功能需要先配置模型服务。选中的内容会发送给你配置的服务商。",
        },
        {
          id: "vault",
          eyebrow: "Vault",
          title: "端到端加密，协作也不例外",
          lead: "Vault 是一个独立的加密模式。内容在离开你的设备之前就已在浏览器中加密，服务器只负责存储和转发密文。",
          cards: [
            {
              title: "端到端加密",
              body: "画布快照、实时协作消息和附件都会加密，内容密钥从不发送到服务器。",
            },
            {
              title: "查看者与编辑者邀请",
              body: "按查看者或编辑者角色邀请成员，链接有效期可选 24 小时、7 天或永不过期。",
            },
            {
              title: "随时撤销",
              body: "撤销邀请后，新访问会被阻止，已有连接也会断开。",
            },
            {
              title: "出错即停止",
              body: "遇到任何异常，Vault 会直接停止，不会悄悄降级为明文或普通协作房间。",
            },
            {
              title: "支持自托管",
              body: "配套部署、备份与恢复工具，可以把整套服务运行在你自己的服务器上。",
            },
          ],
          note: "创建 Vault 需要在启用了 Vault 的部署上登录。",
          link: { label: "查看安全细节", href: BRAND_PAGE_URLS.security },
        },
        {
          id: "labs",
          eyebrow: "实验室",
          title: "抢先试试新功能",
          lead: "实验功能放在主菜单的「实验室」子菜单里，也可以在偏好设置中隐藏。",
          cards: [
            {
              title: "光照 Lumina",
              body: "给图形设置玻璃、镜面、自发光等材质，放置光源，观察折射与焦散。",
            },
            {
              title: "Echo 锚点分身",
              body: "把多个元素绑定到同一个锚点，让文字、状态和背景色保持联动。",
            },
            {
              title: "连线语气",
              body: "把连线标记为确定、可能、阻塞或存疑。",
            },
            {
              title: "边画边录",
              body: "记录场景、视口和指针的变化，生成可交互回放，并可导出。",
            },
            {
              title: "异世界视角",
              body: "对同一份输入一次生成多个 AI 视角，再从任意结果继续裂变。",
            },
            {
              title: "嵌入式白板",
              body: "以只读预览、可编辑嵌入或演示模式，把白板嵌入其他页面。",
            },
            {
              title: "单文件白板",
              body: "把白板导出为一个可离线运行、可继续编辑的自包含 HTML 文件。",
            },
            {
              title: "罗夏镜",
              body: "随手涂一团，看它从中读出了什么。",
            },
            {
              title: "便签保质期",
              body: "给矩形便签设个保质期，过期后泛黄，可一键撕掉。",
            },
            {
              title: "通感画布",
              body: "让声音在画布上长出手绘图形。",
            },
          ],
          note: "实验室功能可能随时调整或下线，部分功能需要先配置 AI。",
        },
      ],
      closing: {
        title: "开始画吧",
        lead: "这些能力都在同一块画布里。",
        cta: "打开 Calileon",
      },
    },
    security: {
      documentTitle: "安全 · Calileon",
      description:
        "Calileon 如何在浏览器中加密分享的绘图、实时协作和 Vault 空间。",
      hero: {
        eyebrow: "安全",
        title: "在浏览器里加密，密钥留在你手中",
        lead: "分享和协作的绘图在上传前就已在你的设备上加密。服务器只经手密文，解密密钥随链接传递，不经过服务器。",
        primary: "打开 Calileon",
        secondary: { label: "了解 Calileon+", href: BRAND_PAGE_URLS.plus },
      },
      sections: [
        {
          id: "sharing",
          eyebrow: "分享链接与实时协作",
          title: "密钥藏在 # 后面",
          lead: "创建分享链接或开始实时协作时，Calileon 会在你的浏览器里生成一把随机密钥。",
          cards: [
            {
              title: "上传前加密",
              body: "画布内容先在浏览器中用 AES-GCM（128 位）加密，再上传。",
            },
            {
              title: "密钥在链接片段里",
              body: "密钥位于链接中 # 之后的部分，浏览器不会把这部分发送给服务器。",
            },
            {
              title: "服务器只转发",
              body: "协作服务器只在参与者之间转发加密消息，无法读取其中内容。",
            },
          ],
        },
        {
          id: "vault",
          eyebrow: "Vault",
          title: "为敏感内容提供更强的保障",
          lead: "Vault 是一个独立模式，有自己的协议和更严格的规则。",
          cards: [
            {
              title: "按用途派生密钥",
              body: "每个 Vault 有独立的 256 位根密钥，通过 HKDF-SHA-256 为快照、实时消息和附件分别派生 AES-GCM 密钥。",
            },
            {
              title: "邀请不等于密钥",
              body: "邀请凭据与内容密钥相互独立。服务器只保存邀请的哈希，用来校验访问权限。",
            },
            {
              title: "查看者只读",
              body: "服务器会拒绝查看者邀请写入内容、快照和附件。",
            },
            {
              title: "默认禁止外部调用",
              body: "在 Vault 中，AI、外部嵌入和远程媒体默认被阻止。唯一的例外是部署方提供的托管 AI 网关，而且只在你主动使用时才会调用。",
            },
            {
              title: "出错即拒绝",
              body: "未知版本、解密失败或已撤销的访问都会被拒绝，绝不会当作明文处理，也不会降级为普通协作房间。",
            },
          ],
        },
        {
          id: "limits",
          eyebrow: "需要了解",
          title: "加密覆盖不到的地方",
          lead: "了解这些边界，才能为内容选对模式。",
          cards: [
            {
              title: "链接就是钥匙",
              body: "拿到完整链接的人都能打开内容。请像保护密码一样保护分享链接和邀请链接。",
            },
            {
              title: "撤销不会轮换密钥",
              body: "撤销邀请会阻止新访问并断开现有连接，但已经泄露的内容密钥不会自动轮换。",
            },
            {
              title: "本地草稿",
              body: "未分享、也未保存到云端的绘图保存在当前浏览器的存储中。它们不会被上传，但也没有额外加密，在共用电脑上请注意。",
            },
            {
              title: "AI 服务商",
              body: "在 Vault 之外使用 AI 时，选中的内容会发送给你配置的模型服务商，并适用该服务商的政策。",
            },
            {
              title: "元数据",
              body: "服务器读不到你的内容，但能看到房间 ID、连接时间、数据大小和 IP 地址等元数据。",
            },
          ],
        },
      ],
      closing: {
        title: "画得安心",
        lead: "日常内容用分享链接，敏感内容用 Vault。",
        cta: "打开 Calileon",
      },
    },
  },
};

export const BRAND_COPY: Record<BrandLang, BrandCopy> = {
  en,
  "zh-CN": zhCN,
};
