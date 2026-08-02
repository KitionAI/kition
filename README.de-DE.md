<h1 align="center">
  <a href="https://kition.ai"><img src="public/logo-mark.png" alt="Kition-Logo" width="64" valign="middle" /></a> Kition
</h1>

<p align="center">
  <a href="README.md">English</a> ·
  <a href="README.zh-CN.md">简体中文</a> ·
  <a href="README.ru-RU.md">Русский</a> ·
  <a href="README.ja-JP.md">日本語</a> ·
  <a href="README.vi-VN.md">Tiếng Việt</a> ·
  <a href="README.fr-FR.md">Français</a> ·
  <strong>Deutsch</strong> ·
  <a href="README.es-ES.md">Español</a>
</p>

<p align="center">
  <strong>Dokumente, Tabellen, Agenten und Workflows in einem Desktop-Arbeitsbereich.</strong><br />
  Schreiben Sie vernetztes Wissen, bauen Sie Datenwerkzeuge, recherchieren Sie im Browser und automatisieren Sie wiederkehrende Arbeit.
</p>

<p align="center">
  <a href="https://github.com/KitionAI/kition/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/KitionAI/kition/ci.yml?branch=main&amp;style=flat-square&amp;logo=githubactions&amp;logoColor=white&amp;label=CI" alt="CI-Status" /></a>
  <a href="https://github.com/KitionAI/kition/releases/latest"><img src="https://img.shields.io/github/v/release/KitionAI/kition?include_prereleases&amp;sort=semver&amp;style=flat-square&amp;color=5645d4" alt="Neueste Version" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/KitionAI/kition?style=flat-square&amp;color=5645d4" alt="Lizenz GNU AGPLv3" /></a>
</p>

<h3 align="center"><a href="https://github.com/KitionAI/kition/releases/latest"><ins>Kition herunterladen</ins></a></h3>

<p align="center">
  <a href="https://kition.ai">Website</a> ·
  <a href="https://github.com/KitionAI/kition/releases">Versionen</a> ·
  <a href="CONTRIBUTING.md">Mitwirken</a> ·
  <a href=".github/SUPPORT.md">Support</a> ·
  <a href=".github/SECURITY.md">Sicherheit</a>
</p>

<p align="center"><img src="docs/readme/kition-overview.webp" alt="Kition-Übersicht mit Dokumenten, strukturierten Tabellen, Agentenrecherche und visuellen Workflows" width="100%" /></p>

Kition vereint Markdown-Dokumente, strukturierte Tabellen, einen werkzeugfähigen KI-Agenten, Browserrecherche und visuelle Workflows. Der Agent arbeitet mit bearbeitbaren Projektdateien, typisierten Datensätzen, Anhängen und sichtbaren Prozessen. Dadurch lassen sich Ergebnisse leichter prüfen, korrigieren und wiederholen.

> Kition befindet sich derzeit in der Beta-Phase. Sichern Sie wichtige Arbeitsbereiche und prüfen Sie Änderungen des Agenten vor dem Einsatz in produktiven Abläufen.

## Warum Kition

- **Vernetzte Dokumente.** Markdown mit Live-Vorschau, internen Links, Backlinks, Code, Mathematik, Diagrammen, täglichen Notizen, Suche und Export.
- **Strukturierte Daten neben dem Wissen.** Typisierte Felder, Formeln, Filter, Gruppen, Ansichten, Anhänge und KI-Felder.
- **Ein Agent, der handeln kann.** Er recherchiert im Browser, liest und aktualisiert Dokumente und Tabellen und speichert Ergebnisse im Projekt.
- **Sichtbare Automatisierung.** Kombinieren Sie Auslöser und Aktionen, testen Sie Schritte und prüfen Sie den Ausführungsverlauf.

## Mit der Arbeit beginnen, nicht mit einer leeren Eingabe

Kition hält den Aufgabenkontext in Dokumenten, Tabellenfeldern, Datensätzen, Vorlagen und Workflows fest. Die integrierten Szenarien sind gewöhnliche `.kitable`-Dateien und können an echte Projekte angepasst werden.

### Kampagnenmaterial stapelweise erzeugen

Erstellen Sie aus einer Kernbotschaft und einem Porträt verknüpfte Miniaturvarianten im Format 16:9 und 9:16 für jeden Datensatz.

<p align="center"><img src="docs/readme/scenarios/thumbnail-generator.webp" alt="Kition-Tabelle zur Erzeugung von Miniaturen" width="100%" /></p>

### Belegbilder in durchsuchbare Datensätze umwandeln

Bildfelder extrahieren Händler, Adresse, Kategorie, strukturiertes JSON und OCR-Text direkt in dieselbe Tabellenzeile.

<p align="center"><img src="docs/readme/scenarios/receipt-ocr.webp" alt="Kition-Tabelle für Beleg-OCR" width="100%" /></p>

### Aus einem Produktbriefing eine vollständige Materialkette erstellen

Erzeugen Sie Designvarianten, orthografische Ansichten, Funktionsbilder, Lifestyle-Szenen, Stiltafeln und Einführungstexte, während alle Ergebnisse mit dem Quelldatensatz verbunden bleiben.

<p align="center"><img src="docs/readme/scenarios/batch-product-designer.webp" alt="Kition-Tabelle für stapelweise Produktgestaltung" width="100%" /></p>

## Hauptfunktionen

- **Dokumente:** Markdown-Bearbeitung, Vorschau, Vorlagen, Suche und PDF/DOCX-Export.
- **Tabellen:** typisierte Felder, Anhänge, Formeln, Filter, Sortierung, Gruppen und mehrere Ansichten.
- **Agent:** Dokumentaktualisierung, Webrecherche, Werkzeugnutzung und Speichern im Arbeitsbereich.
- **Workflows:** visuelle Kombination von Auslösern und Aktionen, Schritttests und Ausführungsverlauf.
- **Einstellungen:** E-Mail, Modelle, Proxy, MCP, Konto, Nutzung, Aktualisierungen und Desktop-Integration.

## Installation

Desktop-Versionen werden über [GitHub Releases](https://github.com/KitionAI/kition/releases/latest) veröffentlicht.

- **macOS:** Laden Sie die neueste `.dmg`-Datei herunter.
- **Windows:** Laden Sie das neueste Installationsprogramm herunter.
- **Frühere Versionen:** Öffnen Sie den [Versionsverlauf](https://github.com/KitionAI/kition/releases).

## Aus dem Quellcode ausführen

Erforderlich sind Node.js 22.19.0 und pnpm 10.33.0.

```bash
pnpm install --frozen-lockfile
pnpm dev
```

Für reine Oberflächenentwicklung ohne Runtime-Integration verwenden Sie `pnpm dev:web`. Weitere Informationen: [Runtime-Entwicklung](docs/runtime-development.md).

## Open-Source-Grenze

Dieses Repository enthält den öffentlichen React/Electron-Client, öffentliche Runtime-Verträge, Mocks, Tests und Paketierung. Der Quellcode der Kition-Runtime wird separat gepflegt und ist nicht enthalten. Der Client kommuniziert ausschließlich über die öffentlichen Verträge in [`contracts/runtime/`](contracts/runtime/).

## Technologie

| Bereich | Technologie |
| --- | --- |
| Desktop | Electron |
| Oberfläche | React, TypeScript, Vite |
| Dokumente | CodeMirror, Marked, Mermaid, KaTeX |
| Daten und Zustand | IndexedDB, Jotai, Zod |
| Tests | Vitest, Playwright |

## Mitwirken

Issues und Pull Requests für den öffentlichen Client sind willkommen. Lesen Sie [CONTRIBUTING.md](CONTRIBUTING.md) und den [Kition-Entwicklungsstandard](docs/development-standard.md) und halten Sie Änderungen innerhalb der Grenze zwischen öffentlichem Client und Runtime-Verträgen.

## Lizenz

Der öffentliche Kition-Client steht unter der [GNU Affero General Public License v3.0 only](LICENSE). Die separat ausgelieferte Kition-Runtime unterliegt einer eigenen Lizenz.
