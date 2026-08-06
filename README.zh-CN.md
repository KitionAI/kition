<h1 align="center">
  <a href="https://kition.ai"><img src="public/logo-mark.png" alt="Kition 标志" width="64" valign="middle" /></a> Kition
</h1>

<p align="center">
  <a href="README.md">English</a> ·
  <strong>简体中文</strong> ·
  <a href="README.ru-RU.md">Русский</a> ·
  <a href="README.ja-JP.md">日本語</a> ·
  <a href="README.vi-VN.md">Tiếng Việt</a> ·
  <a href="README.fr-FR.md">Français</a> ·
  <a href="README.de-DE.md">Deutsch</a> ·
  <a href="README.es-ES.md">Español</a>
</p>

<p align="center">
  <strong>在一个桌面工作区中管理文档、表格、智能体与工作流。</strong><br />
  编写相互连接的知识，构建数据工具，在浏览器中研究，并自动执行可重复的工作。
</p>

<p align="center">
  <a href="https://github.com/KitionAI/kition/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/KitionAI/kition/ci.yml?branch=main&amp;style=flat-square&amp;logo=githubactions&amp;logoColor=white&amp;label=CI" alt="CI 状态" /></a>
  <a href="https://github.com/KitionAI/kition/releases/latest"><img src="https://img.shields.io/github/v/release/KitionAI/kition?include_prereleases&amp;sort=semver&amp;style=flat-square&amp;color=5645d4" alt="最新版本" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/KitionAI/kition?style=flat-square&amp;color=5645d4" alt="许可证：GNU AGPLv3" /></a>
</p>

<h3 align="center"><a href="https://github.com/KitionAI/kition/releases/latest"><ins>下载 Kition</ins></a></h3>

<p align="center">
  <a href="https://kition.ai">网站</a> ·
  <a href="https://github.com/KitionAI/kition/releases">发布版本</a> ·
  <a href="CONTRIBUTING.md">参与贡献</a> ·
  <a href=".github/SUPPORT.md">支持</a> ·
  <a href=".github/SECURITY.md">安全</a>
</p>

<p align="center">
  <img src="docs/readme/kition-overview.webp" alt="Kition 产品概览：文档、结构化表格、智能体研究与可视化工作流" width="100%" />
</p>

Kition 将 Markdown 文档、结构化表格、可调用工具的 AI 智能体、浏览器研究和可视化工作流整合到一个桌面工作区中。智能体可以直接使用可编辑的项目文件、类型化记录、附件和可见流程，让 AI 操作更容易检查、修正和重复执行。

> Kition 目前处于测试阶段。请备份重要工作区，并在生产流程中使用前审查智能体所做的更改。

## 为什么选择 Kition

- **相互连接的文档。** 支持 Markdown 实时预览、内部链接、反向链接、标注、代码、数学公式、图表、每日笔记、搜索与导出。
- **知识旁边的结构化数据。** 使用类型化字段、公式、筛选、分组、视图、附件和 AI 字段整理研究与内容。
- **可以执行操作的智能体。** 在浏览器标签页中研究，读取和修改文档，检查表结构，并将结果保存到当前项目。
- **可审查的文档修改。** 让智能体直接编辑当前文档，逐项查看新增与删除内容，再接受或拒绝每一处变化。
- **可见的自动化。** 构建触发器与动作工作流，测试步骤，查看运行历史，并在启用前解决缺失输入。

## 让智能体直接修改，最终决定权仍由你掌握

Kition 智能体不只是返回一段需要复制粘贴的建议。它可以读取当前 Markdown 文档，按照自然语言要求直接修改真实文件，并在工作区中保留完整的任务执行过程。

<p align="center">
  <img src="docs/readme/agent-document-edit.webp" alt="Kition 开源 AI 智能体读取并修改当前 Markdown 文档，同时展示完整工具执行过程" width="100%" />
</p>

文件在编辑器外部发生变化后，Kition 会打开文档差异审阅界面，清晰标记新增、删除和改写内容。用户可以逐项接受或拒绝修改，也可以一次审核全部变化。

<p align="center">
  <img src="docs/readme/agent-document-diff-review.webp" alt="Kition 文档差异审阅界面，展示 AI 新增和删除内容以及逐项接受或拒绝修改的控件" width="100%" />
</p>

整个流程形成一次可控的文档协作：用自然语言说明目标，让智能体修改真实文件，通过文本差异检查结果，再决定最终保留哪些内容。

## 从工作开始，而不是从空白提示词开始

Kition 把任务上下文放进熟悉的工作界面：文档、表格字段、记录、模板和工作流。内置场景使用普通 `.kitable` 文件，提示词、字段关系、生成资源和审核状态都保持可见，并可直接改造成真实项目。

### 批量生成活动素材

从核心信息和人物照片开始，通过类型化字段声明内容类型与目标情绪，再用 AI 字段为每条记录生成关联的 16:9 和 9:16 缩略图。

<p align="center"><img src="docs/readme/scenarios/thumbnail-generator.webp" alt="Kition 批量缩略图生成表" width="100%" /></p>

### 将票据图片转换为可搜索记录

把票据照片放入附件字段，视觉字段会在同一行中提取商户、地址、类别、结构化 JSON 和 OCR 文本。

<p align="center"><img src="docs/readme/scenarios/receipt-ocr.webp" alt="Kition 票据 OCR 表格" width="100%" /></p>

### 从一份产品简介扩展出完整素材流程

一个产品概念可以生成多个设计方案、正交视图、功能图、生活方式图片、风格板和发布文案，所有结果都会保留在源记录旁边。

<p align="center"><img src="docs/readme/scenarios/batch-product-designer.webp" alt="Kition 批量产品设计表" width="100%" /></p>

## 产品功能

- **文档：** Markdown 编辑、实时预览、标签页、模板、每日笔记、全文搜索以及 PDF/DOCX 导出。
- **表格：** 类型化字段、附件、公式、筛选、排序、分组、多视图和快速记录编辑。
- **智能体：** 读取和更新文档、研究网页、使用工具，并将输出写回工作区。
- **工作流：** 在可视化画布上组合触发器与动作，测试步骤并查看运行历史。
- **连接与设置：** 邮件连接、模型、代理、MCP、账户、用量、更新与桌面集成设置。

## 安装

桌面版本通过 [GitHub Releases](https://github.com/KitionAI/kition/releases/latest) 发布。

- **macOS：** 下载最新的 `.dmg`。
- **Windows：** 下载最新安装程序。
- **历史版本：** 浏览完整的[发布记录](https://github.com/KitionAI/kition/releases)。

## 从源码运行

要求：Node.js 22.19.0、pnpm 10.33.0。

```bash
pnpm install --frozen-lockfile
pnpm dev
```

仅进行渲染器、组件、编辑器或样式开发时，可以运行：

```bash
pnpm dev:web
```

更多说明参见[运行时开发](docs/runtime-development.md)。

## 开源边界

本仓库包含公开的 React/Electron 客户端、公共运行时契约、模拟数据、测试和打包流程。Kition 运行时在单独的私有仓库中维护，其源码不包含在本仓库内。客户端仅通过 [`contracts/runtime/`](contracts/runtime/) 中的公共契约与运行时通信。

## 技术栈

| 领域 | 技术 |
| --- | --- |
| 桌面端 | Electron |
| 界面 | React、TypeScript、Vite |
| 文档 | CodeMirror、Marked、Mermaid、KaTeX |
| 数据与状态 | IndexedDB、Jotai、Zod |
| 测试 | Vitest、Playwright |

## 参与贡献

欢迎为公开客户端提交 Issue 和 Pull Request。请先阅读 [CONTRIBUTING.md](CONTRIBUTING.md) 和 [Kition 开发标准](docs/development-standard.md)，并保持修改位于公开客户端与运行时契约边界内。

## 许可证

Kition 公开客户端采用 [GNU Affero General Public License v3.0 only](LICENSE) 许可证。单独分发的 Kition 运行时遵循其自身许可证，不包含在本仓库中。
