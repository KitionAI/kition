<h1 align="center">
  <a href="https://kition.ai"><img src="public/logo-mark.png" alt="Logo Kition" width="64" valign="middle" /></a> Kition
</h1>

<p align="center">
  <a href="README.md">English</a> ·
  <a href="README.zh-CN.md">简体中文</a> ·
  <a href="README.ru-RU.md">Русский</a> ·
  <a href="README.ja-JP.md">日本語</a> ·
  <a href="README.vi-VN.md">Tiếng Việt</a> ·
  <strong>Français</strong> ·
  <a href="README.de-DE.md">Deutsch</a> ·
  <a href="README.es-ES.md">Español</a>
</p>

<p align="center">
  <strong>Documents, tableaux, agents et workflows dans un seul espace de travail.</strong><br />
  Rédigez des connaissances reliées, créez des outils de données, effectuez des recherches dans le navigateur et automatisez le travail répétitif.
</p>

<p align="center">
  <a href="https://github.com/KitionAI/kition/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/KitionAI/kition/ci.yml?branch=main&amp;style=flat-square&amp;logo=githubactions&amp;logoColor=white&amp;label=CI" alt="État de la CI" /></a>
  <a href="https://github.com/KitionAI/kition/releases/latest"><img src="https://img.shields.io/github/v/release/KitionAI/kition?include_prereleases&amp;sort=semver&amp;style=flat-square&amp;color=5645d4" alt="Dernière version" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/KitionAI/kition?style=flat-square&amp;color=5645d4" alt="Licence GNU AGPLv3" /></a>
</p>

<h3 align="center"><a href="https://github.com/KitionAI/kition/releases/latest"><ins>Télécharger Kition</ins></a></h3>

<p align="center">
  <a href="https://kition.ai">Site web</a> ·
  <a href="https://github.com/KitionAI/kition/releases">Versions</a> ·
  <a href="CONTRIBUTING.md">Contribuer</a> ·
  <a href=".github/SUPPORT.md">Assistance</a> ·
  <a href=".github/SECURITY.md">Sécurité</a>
</p>

<p align="center"><img src="docs/readme/kition-overview.webp" alt="Vue d’ensemble de Kition avec documents, tableaux structurés, recherches de l’agent et workflows visuels" width="100%" /></p>

Kition réunit des documents Markdown, des tableaux structurés, un agent IA capable d’utiliser des outils, la recherche dans le navigateur et des workflows visuels. L’agent travaille avec des fichiers de projet modifiables, des enregistrements typés, des pièces jointes et des processus visibles, ce qui facilite la vérification, la correction et la répétition des résultats.

> Kition est actuellement en version bêta. Sauvegardez les espaces de travail importants et vérifiez les modifications de l’agent avant une utilisation en production.

## Pourquoi Kition

- **Documents reliés.** Markdown avec aperçu en direct, liens internes, backlinks, code, mathématiques, diagrammes, notes quotidiennes, recherche et export.
- **Données structurées à côté des connaissances.** Champs typés, formules, filtres, groupes, vues, pièces jointes et champs IA.
- **Un agent qui peut agir.** Il recherche dans le navigateur, lit et modifie les documents et tableaux, puis enregistre les résultats dans le projet.
- **Modifications de documents contrôlables.** Laissez l’agent modifier le document actif, examinez chaque ajout et suppression, puis acceptez ou refusez les changements individuellement.
- **Automatisation visible.** Assemblez des déclencheurs et des actions, testez les étapes et consultez l’historique d’exécution.

## Laissez l’agent modifier, gardez le dernier mot

Au lieu de renvoyer une nouvelle suggestion à copier-coller, l’agent Kition peut lire le document Markdown actif, effectuer des changements ciblés et réécrire le résultat dans l’espace de travail. Le document et le déroulement complet de la tâche restent visibles pendant son intervention.

<p align="center">
  <img src="docs/readme/agent-document-edit.webp" alt="L’agent IA open source Kition lit et modifie le document Markdown actif à côté de la trace visible d’exécution des outils" width="100%" />
</p>

Lorsqu’un fichier change en dehors de l’éditeur, Kition ouvre une interface de révision qui met en évidence les ajouts, les suppressions et les réécritures. Chaque changement peut être accepté ou refusé séparément, ou l’ensemble de la modification peut être examiné en une seule fois.

<p align="center">
  <img src="docs/readme/agent-document-diff-review.webp" alt="Révision des différences d’un document dans Kition avec les ajouts et suppressions de l’IA et les commandes pour accepter ou refuser chaque changement" width="100%" />
</p>

Le travail documentaire devient ainsi contrôlable : décrivez l’objectif en langage naturel, laissez l’agent modifier le vrai fichier, examinez les différences et décidez précisément de ce qui restera dans le document final.

## Commencez par le travail, pas par une invite vide

Kition conserve le contexte dans les documents, les champs de tableau, les enregistrements, les modèles et les workflows. Les scénarios intégrés sont de simples fichiers `.kitable` adaptables à un projet réel.

### Générer des ressources de campagne par lots

À partir d’un message clé et d’un portrait, générez des miniatures 16:9 et 9:16 reliées à chaque enregistrement.

<p align="center"><img src="docs/readme/scenarios/thumbnail-generator.webp" alt="Tableau de génération de miniatures Kition" width="100%" /></p>

### Transformer des reçus en enregistrements recherchables

Les champs de vision extraient le commerçant, l’adresse, la catégorie, le JSON structuré et le texte OCR dans la même ligne.

<p align="center"><img src="docs/readme/scenarios/receipt-ocr.webp" alt="Tableau OCR de reçus Kition" width="100%" /></p>

### Déployer une présentation produit en chaîne de ressources complète

Créez des propositions de design, vues orthographiques, images de fonctionnalité, scènes d’usage, planches de style et textes de lancement tout en conservant le lien avec l’enregistrement source.

<p align="center"><img src="docs/readme/scenarios/batch-product-designer.webp" alt="Tableau de conception produit par lots Kition" width="100%" /></p>

## Fonctionnalités principales

- **Documents :** édition Markdown, aperçu, modèles, recherche, export PDF/DOCX.
- **Tableaux :** champs typés, pièces jointes, formules, filtres, tri, groupes et vues multiples.
- **Agent :** modification de documents, recherche web, utilisation d’outils et sauvegarde dans l’espace de travail.
- **Workflows :** composition visuelle de déclencheurs et d’actions, tests et historique d’exécution.
- **Réglages :** e-mail, modèles, proxy, MCP, compte, consommation, mises à jour et intégration au bureau.

## Installation

Les versions de bureau sont publiées dans [GitHub Releases](https://github.com/KitionAI/kition/releases/latest).

- **macOS :** téléchargez le dernier fichier `.dmg`.
- **Windows :** téléchargez le dernier programme d’installation.
- **Anciennes versions :** consultez l’[historique des versions](https://github.com/KitionAI/kition/releases).

## Exécuter depuis les sources

Prérequis : Node.js 22.19.0 et pnpm 10.33.0.

```bash
pnpm install --frozen-lockfile
pnpm dev
```

Pour le développement de l’interface sans intégration au runtime, utilisez `pnpm dev:web`. Voir [Développement du runtime](docs/runtime-development.md).

## Périmètre open source

Ce dépôt contient le client public React/Electron, les contrats publics du runtime, les mocks, les tests et l’empaquetage. Le code source du runtime Kition est maintenu séparément et n’est pas inclus. Le client communique uniquement à travers les contrats publics de [`contracts/runtime/`](contracts/runtime/).

## Technologies

| Domaine | Technologies |
| --- | --- |
| Bureau | Electron |
| Interface | React, TypeScript, Vite |
| Documents | CodeMirror, Marked, Mermaid, KaTeX |
| Données et état | IndexedDB, Jotai, Zod |
| Tests | Vitest, Playwright |

## Contribuer

Les Issues et Pull Requests concernant le client public sont les bienvenues. Consultez [CONTRIBUTING.md](CONTRIBUTING.md) et le [standard de développement Kition](docs/development-standard.md), en respectant la frontière entre le client public et les contrats du runtime.

## Licence

Le client public Kition est distribué sous la licence [GNU Affero General Public License v3.0 only](LICENSE). Le runtime Kition distribué séparément possède sa propre licence.
