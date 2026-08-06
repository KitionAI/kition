<h1 align="center">
  <a href="https://kition.ai"><img src="public/logo-mark.png" alt="Biểu trưng Kition" width="64" valign="middle" /></a> Kition
</h1>

<p align="center">
  <a href="README.md">English</a> ·
  <a href="README.zh-CN.md">简体中文</a> ·
  <a href="README.ru-RU.md">Русский</a> ·
  <a href="README.ja-JP.md">日本語</a> ·
  <strong>Tiếng Việt</strong> ·
  <a href="README.fr-FR.md">Français</a> ·
  <a href="README.de-DE.md">Deutsch</a> ·
  <a href="README.es-ES.md">Español</a>
</p>

<p align="center">
  <strong>Tài liệu, bảng, tác nhân và quy trình trong một không gian làm việc trên máy tính.</strong><br />
  Viết tri thức liên kết, xây dựng công cụ dữ liệu, nghiên cứu trên trình duyệt và tự động hóa công việc lặp lại.
</p>

<p align="center">
  <a href="https://github.com/KitionAI/kition/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/KitionAI/kition/ci.yml?branch=main&amp;style=flat-square&amp;logo=githubactions&amp;logoColor=white&amp;label=CI" alt="Trạng thái CI" /></a>
  <a href="https://github.com/KitionAI/kition/releases/latest"><img src="https://img.shields.io/github/v/release/KitionAI/kition?include_prereleases&amp;sort=semver&amp;style=flat-square&amp;color=5645d4" alt="Bản phát hành mới nhất" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/KitionAI/kition?style=flat-square&amp;color=5645d4" alt="Giấy phép GNU AGPLv3" /></a>
</p>

<h3 align="center"><a href="https://github.com/KitionAI/kition/releases/latest"><ins>Tải Kition</ins></a></h3>

<p align="center">
  <a href="https://kition.ai">Trang web</a> ·
  <a href="https://github.com/KitionAI/kition/releases">Bản phát hành</a> ·
  <a href="CONTRIBUTING.md">Đóng góp</a> ·
  <a href=".github/SUPPORT.md">Hỗ trợ</a> ·
  <a href=".github/SECURITY.md">Bảo mật</a>
</p>

<p align="center"><img src="docs/readme/kition-overview.webp" alt="Tổng quan Kition với tài liệu, bảng dữ liệu, nghiên cứu của tác nhân và quy trình trực quan" width="100%" /></p>

Kition kết hợp tài liệu Markdown, bảng có cấu trúc, tác nhân AI có thể dùng công cụ, nghiên cứu trên trình duyệt và quy trình trực quan trong một không gian làm việc. Tác nhân làm việc với tệp dự án có thể chỉnh sửa, bản ghi có kiểu, tệp đính kèm và quy trình hiển thị rõ ràng, giúp kết quả dễ kiểm tra, sửa đổi và lặp lại.

> Kition hiện đang ở giai đoạn beta. Hãy sao lưu không gian làm việc quan trọng và xem lại thay đổi của tác nhân trước khi dùng trong quy trình sản xuất.

## Vì sao chọn Kition

- **Tài liệu liên kết.** Markdown với xem trước trực tiếp, liên kết nội bộ, backlink, mã, công thức, sơ đồ, ghi chú hằng ngày, tìm kiếm và xuất tệp.
- **Dữ liệu có cấu trúc bên cạnh tri thức.** Trường có kiểu, công thức, bộ lọc, nhóm, chế độ xem, tệp đính kèm và trường AI.
- **Tác nhân có thể hành động.** Nghiên cứu trong trình duyệt, đọc và cập nhật tài liệu hoặc bảng, rồi lưu kết quả vào dự án.
- **Chỉnh sửa tài liệu có thể xem xét.** Cho phép tác nhân sửa tài liệu đang mở, kiểm tra từng phần thêm hoặc xóa, rồi chấp nhận hay từ chối từng thay đổi.
- **Tự động hóa có thể quan sát.** Ghép trình kích hoạt với hành động, kiểm thử từng bước và xem lịch sử chạy.

## Để tác nhân chỉnh sửa — bạn vẫn là người quyết định

Tác nhân Kition không chỉ trả về một gợi ý cần sao chép và dán. Nó có thể đọc tài liệu Markdown đang mở, thực hiện các thay đổi đúng phạm vi và ghi kết quả trở lại không gian làm việc. Tài liệu cùng toàn bộ quá trình thực hiện tác vụ vẫn hiển thị trong khi tác nhân làm việc.

<p align="center">
  <img src="docs/readme/agent-document-edit.webp" alt="Tác nhân AI mã nguồn mở Kition đọc và chỉnh sửa tài liệu Markdown đang mở bên cạnh nhật ký thực thi công cụ" width="100%" />
</p>

Khi tệp được thay đổi bên ngoài trình chỉnh sửa, Kition mở giao diện xem xét tài liệu, làm nổi bật nội dung thêm, xóa và viết lại. Bạn có thể chấp nhận hoặc từ chối từng thay đổi, hoặc xem xét toàn bộ lần chỉnh sửa cùng lúc.

<p align="center">
  <img src="docs/readme/agent-document-diff-review.webp" alt="Giao diện xem xét khác biệt tài liệu của Kition hiển thị phần AI thêm và xóa cùng nút chấp nhận hoặc từ chối từng thay đổi" width="100%" />
</p>

Quy trình tài liệu trở nên có kiểm soát: mô tả mục tiêu bằng ngôn ngữ tự nhiên, để tác nhân sửa tệp thật, xem lại phần khác biệt và quyết định chính xác nội dung nào được giữ trong tài liệu cuối cùng.

## Bắt đầu từ công việc, không phải lời nhắc trống

Kition lưu ngữ cảnh trong tài liệu, trường bảng, bản ghi, mẫu và quy trình. Các kịch bản tích hợp là tệp `.kitable` thông thường và có thể được điều chỉnh cho dự án thực tế.

### Tạo hàng loạt nội dung chiến dịch

Từ thông điệp chính và ảnh chân dung, tạo các biến thể hình thu nhỏ 16:9 và 9:16 cho từng bản ghi.

<p align="center"><img src="docs/readme/scenarios/thumbnail-generator.webp" alt="Bảng tạo hình thu nhỏ Kition" width="100%" /></p>

### Chuyển ảnh hóa đơn thành bản ghi có thể tìm kiếm

Các trường thị giác trích xuất nhà cung cấp, địa chỉ, danh mục, JSON có cấu trúc và văn bản OCR ngay trong cùng một hàng.

<p align="center"><img src="docs/readme/scenarios/receipt-ocr.webp" alt="Bảng OCR hóa đơn Kition" width="100%" /></p>

### Mở rộng một bản mô tả sản phẩm thành chuỗi nội dung hoàn chỉnh

Tạo phương án thiết kế, hình chiếu, ảnh tính năng, ảnh phong cách sống, bảng phong cách và nội dung ra mắt, đồng thời giữ mọi kết quả gắn với bản ghi nguồn.

<p align="center"><img src="docs/readme/scenarios/batch-product-designer.webp" alt="Bảng thiết kế sản phẩm hàng loạt Kition" width="100%" /></p>

## Tính năng chính

- **Tài liệu:** chỉnh sửa Markdown, xem trước, mẫu, tìm kiếm, xuất PDF/DOCX.
- **Bảng:** trường có kiểu, tệp đính kèm, công thức, bộ lọc, sắp xếp, nhóm và nhiều chế độ xem.
- **Tác nhân:** cập nhật tài liệu, nghiên cứu web, dùng công cụ và lưu kết quả vào không gian làm việc.
- **Quy trình:** xây dựng trực quan từ trình kích hoạt và hành động, kiểm thử bước và xem lịch sử chạy.
- **Cài đặt:** email, mô hình, proxy, MCP, tài khoản, mức sử dụng, cập nhật và tích hợp máy tính.

## Cài đặt

Bản dựng máy tính được phát hành qua [GitHub Releases](https://github.com/KitionAI/kition/releases/latest).

- **macOS:** tải tệp `.dmg` mới nhất.
- **Windows:** tải trình cài đặt mới nhất.
- **Phiên bản trước:** xem [lịch sử phát hành](https://github.com/KitionAI/kition/releases).

## Chạy từ mã nguồn

Yêu cầu Node.js 22.19.0 và pnpm 10.33.0.

```bash
pnpm install --frozen-lockfile
pnpm dev
```

Để phát triển giao diện mà không cần tích hợp runtime, dùng `pnpm dev:web`. Xem thêm tại [phát triển runtime](docs/runtime-development.md).

## Phạm vi mã nguồn mở

Kho này chứa ứng dụng React/Electron công khai, hợp đồng runtime công khai, mock, kiểm thử và quy trình đóng gói. Mã nguồn Kition runtime được duy trì riêng và không nằm trong kho này. Ứng dụng chỉ giao tiếp qua các hợp đồng công khai trong [`contracts/runtime/`](contracts/runtime/).

## Công nghệ

| Lĩnh vực | Công nghệ |
| --- | --- |
| Máy tính | Electron |
| Giao diện | React, TypeScript, Vite |
| Tài liệu | CodeMirror, Marked, Mermaid, KaTeX |
| Dữ liệu và trạng thái | IndexedDB, Jotai, Zod |
| Kiểm thử | Vitest, Playwright |

## Đóng góp

Chúng tôi hoan nghênh Issue và Pull Request cho ứng dụng công khai. Hãy đọc [CONTRIBUTING.md](CONTRIBUTING.md) và [tiêu chuẩn phát triển Kition](docs/development-standard.md), đồng thời giữ thay đổi trong ranh giới ứng dụng công khai và hợp đồng runtime.

## Giấy phép

Ứng dụng Kition công khai được cấp phép theo [GNU Affero General Public License v3.0 only](LICENSE). Kition runtime được phân phối riêng theo giấy phép riêng.
