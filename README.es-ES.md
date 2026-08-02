<h1 align="center">
  <a href="https://kition.ai"><img src="public/logo-mark.png" alt="Logotipo de Kition" width="64" valign="middle" /></a> Kition
</h1>

<p align="center">
  <a href="README.md">English</a> ·
  <a href="README.zh-CN.md">简体中文</a> ·
  <a href="README.ru-RU.md">Русский</a> ·
  <a href="README.ja-JP.md">日本語</a> ·
  <a href="README.vi-VN.md">Tiếng Việt</a> ·
  <a href="README.fr-FR.md">Français</a> ·
  <a href="README.de-DE.md">Deutsch</a> ·
  <strong>Español</strong>
</p>

<p align="center">
  <strong>Documentos, tablas, agentes y flujos de trabajo en un único espacio de escritorio.</strong><br />
  Escribe conocimiento conectado, crea herramientas de datos, investiga en el navegador y automatiza el trabajo repetitivo.
</p>

<p align="center">
  <a href="https://github.com/KitionAI/kition/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/KitionAI/kition/ci.yml?branch=main&amp;style=flat-square&amp;logo=githubactions&amp;logoColor=white&amp;label=CI" alt="Estado de CI" /></a>
  <a href="https://github.com/KitionAI/kition/releases/latest"><img src="https://img.shields.io/github/v/release/KitionAI/kition?include_prereleases&amp;sort=semver&amp;style=flat-square&amp;color=5645d4" alt="Última versión" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/KitionAI/kition?style=flat-square&amp;color=5645d4" alt="Licencia GNU AGPLv3" /></a>
</p>

<h3 align="center"><a href="https://github.com/KitionAI/kition/releases/latest"><ins>Descargar Kition</ins></a></h3>

<p align="center">
  <a href="https://kition.ai">Sitio web</a> ·
  <a href="https://github.com/KitionAI/kition/releases">Versiones</a> ·
  <a href="CONTRIBUTING.md">Contribuir</a> ·
  <a href=".github/SUPPORT.md">Soporte</a> ·
  <a href=".github/SECURITY.md">Seguridad</a>
</p>

<p align="center"><img src="docs/readme/kition-overview.webp" alt="Vista general de Kition con documentos, tablas estructuradas, investigación del agente y flujos visuales" width="100%" /></p>

Kition reúne documentos Markdown, tablas estructuradas, un agente de IA capaz de usar herramientas, investigación en el navegador y flujos de trabajo visuales. El agente trabaja con archivos de proyecto editables, registros tipados, adjuntos y procesos visibles, lo que facilita revisar, corregir y repetir los resultados.

> Kition se encuentra actualmente en beta. Haz copias de seguridad de los espacios importantes y revisa los cambios del agente antes de usarlo en procesos de producción.

## Por qué Kition

- **Documentos conectados.** Markdown con vista previa, enlaces internos, backlinks, código, matemáticas, diagramas, notas diarias, búsqueda y exportación.
- **Datos estructurados junto al conocimiento.** Campos tipados, fórmulas, filtros, grupos, vistas, adjuntos y campos de IA.
- **Un agente que puede actuar.** Investiga en el navegador, lee y actualiza documentos y tablas, y guarda resultados en el proyecto.
- **Automatización visible.** Combina disparadores y acciones, prueba pasos y revisa el historial de ejecución.

## Empieza con el trabajo, no con un mensaje vacío

Kition conserva el contexto en documentos, campos de tabla, registros, plantillas y flujos de trabajo. Los escenarios integrados son archivos `.kitable` normales que se pueden adaptar a proyectos reales.

### Generar recursos de campaña por lotes

A partir de un mensaje clave y un retrato, genera miniaturas relacionadas en formatos 16:9 y 9:16 para cada registro.

<p align="center"><img src="docs/readme/scenarios/thumbnail-generator.webp" alt="Tabla de generación de miniaturas de Kition" width="100%" /></p>

### Convertir recibos en registros consultables

Los campos de visión extraen el comercio, la dirección, la categoría, JSON estructurado y texto OCR directamente en la misma fila.

<p align="center"><img src="docs/readme/scenarios/receipt-ocr.webp" alt="Tabla OCR de recibos de Kition" width="100%" /></p>

### Ampliar una descripción de producto a una cadena completa de recursos

Genera propuestas de diseño, vistas ortográficas, imágenes de características, escenas de uso, paneles de estilo y textos de lanzamiento, manteniendo cada resultado vinculado al registro original.

<p align="center"><img src="docs/readme/scenarios/batch-product-designer.webp" alt="Tabla de diseño de productos por lotes de Kition" width="100%" /></p>

## Funciones principales

- **Documentos:** edición Markdown, vista previa, plantillas, búsqueda y exportación PDF/DOCX.
- **Tablas:** campos tipados, adjuntos, fórmulas, filtros, ordenación, grupos y varias vistas.
- **Agente:** actualización de documentos, investigación web, uso de herramientas y guardado en el espacio de trabajo.
- **Flujos:** composición visual de disparadores y acciones, pruebas por pasos e historial de ejecución.
- **Ajustes:** correo, modelos, proxy, MCP, cuenta, uso, actualizaciones e integración de escritorio.

## Instalación

Las compilaciones de escritorio se publican mediante [GitHub Releases](https://github.com/KitionAI/kition/releases/latest).

- **macOS:** descarga el archivo `.dmg` más reciente.
- **Windows:** descarga el instalador más reciente.
- **Versiones anteriores:** consulta el [historial de versiones](https://github.com/KitionAI/kition/releases).

## Ejecutar desde el código fuente

Requisitos: Node.js 22.19.0 y pnpm 10.33.0.

```bash
pnpm install --frozen-lockfile
pnpm dev
```

Para desarrollar únicamente la interfaz sin integración con el runtime, usa `pnpm dev:web`. Consulta [desarrollo del runtime](docs/runtime-development.md).

## Límite del código abierto

Este repositorio contiene el cliente público React/Electron, contratos públicos del runtime, mocks, pruebas y empaquetado. El código fuente del runtime de Kition se mantiene por separado y no está incluido. El cliente solo se comunica mediante los contratos públicos de [`contracts/runtime/`](contracts/runtime/).

## Tecnología

| Área | Tecnología |
| --- | --- |
| Escritorio | Electron |
| Interfaz | React, TypeScript, Vite |
| Documentos | CodeMirror, Marked, Mermaid, KaTeX |
| Datos y estado | IndexedDB, Jotai, Zod |
| Pruebas | Vitest, Playwright |

## Contribuir

Se aceptan Issues y Pull Requests para el cliente público. Lee [CONTRIBUTING.md](CONTRIBUTING.md) y el [estándar de desarrollo de Kition](docs/development-standard.md), y mantén los cambios dentro del límite entre el cliente público y los contratos del runtime.

## Licencia

El cliente público de Kition se distribuye bajo la [GNU Affero General Public License v3.0 only](LICENSE). El runtime de Kition, distribuido por separado, se rige por su propia licencia.
