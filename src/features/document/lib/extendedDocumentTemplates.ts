import type { TFunction } from 'i18next'

import type { BuiltinDocumentTemplateSeed } from './documentTemplates'

export function getExtendedDocumentTemplates(
  t: TFunction<'document'>,
): BuiltinDocumentTemplateSeed[] {
  return [
    {
      id: 'team-daily-report',
      title: t('templateLibrary.templates.teamDailyReport.title'),
      description: t('templateLibrary.templates.teamDailyReport.description'),
      category: 'work',
      icon: 'report',
      tone: 'sky',
      preview: 'team-report',
      content: `# {{title}}

**Team:** <!-- Add team name --><br>
**Report date:** {{date}}

## Team summary

> Summarize progress, changes, and the most important outcome from today.

## Work completed

| Work item | Owner | Result | Status |
| --- | --- | --- | --- |
|  |  |  | Done |

## In progress

| Work item | Owner | Next step | Expected finish |
| --- | --- | --- | --- |
|  |  |  |  |

## Blockers and requests

- <!-- Add item -->

## Tomorrow

1. <!-- Add priority -->
2. <!-- Add priority -->
`,
    },
    {
      id: 'personal-daily-report',
      title: t('templateLibrary.templates.personalDailyReport.title'),
      description: t('templateLibrary.templates.personalDailyReport.description'),
      category: 'personal',
      icon: 'daily',
      tone: 'yellow',
      preview: 'daily-report',
      content: `# {{title}}

**Date:** {{date}}

## Main outcome



## Completed today

- [x] <!-- Add item -->

## Still in progress

- [ ] <!-- Add item -->

## Notes and decisions

- <!-- Add item -->

## Plan for tomorrow

1. <!-- Add priority -->
2. <!-- Add priority -->
3. <!-- Add priority -->
`,
    },
    {
      id: 'brainstorming-session',
      title: t('templateLibrary.templates.brainstormingSession.title'),
      description: t('templateLibrary.templates.brainstormingSession.description'),
      category: 'work',
      icon: 'brainstorm',
      tone: 'peach',
      preview: 'brainstorm',
      content: `# {{title}}

**Question:** <!-- What are we trying to solve? --><br>
**Participants:**<br>
**Date:** {{date}}

## Constraints

- <!-- Add constraint -->

## Ideas

| Idea | Value | Effort | Notes |
| --- | --- | --- | --- |
|  | High | Medium |  |
|  | Medium | Low |  |

## Promising directions

1. <!-- Add direction -->
2. <!-- Add direction -->

## Experiments

- [ ] <!-- Add experiment -->
`,
    },
    {
      id: 'quarterly-business-review',
      title: t('templateLibrary.templates.quarterlyBusinessReview.title'),
      description: t('templateLibrary.templates.quarterlyBusinessReview.description'),
      category: 'work',
      icon: 'analytics',
      tone: 'mint',
      preview: 'analytics',
      content: `# {{title}}

**Period:** <!-- Add quarter --><br>
**Owner:**<br>
**Review date:** {{date}}

## Executive summary



## Performance

| Metric | Target | Actual | Change | Status |
| --- | ---: | ---: | ---: | --- |
| Revenue |  |  |  | On track |
| Retention |  |  |  | On track |
| Delivery |  |  |  | At risk |

## What worked

- <!-- Add item -->

## What needs attention

- <!-- Add item -->

## Next-quarter priorities

1. <!-- Add priority -->
2. <!-- Add priority -->
`,
    },
    {
      id: 'meeting-action-tracker',
      title: t('templateLibrary.templates.meetingActionTracker.title'),
      description: t('templateLibrary.templates.meetingActionTracker.description'),
      category: 'work',
      icon: 'action',
      tone: 'rose',
      preview: 'action-list',
      content: `# {{title}}

**Meeting:**<br>
**Date:** {{date}}<br>
**Facilitator:**

## Decisions

| Decision | Owner | Date |
| --- | --- | --- |
|  |  | {{date}} |

## Action items

| Action | Owner | Due date | Priority | Status |
| --- | --- | --- | --- | --- |
|  |  |  | High | Open |
|  |  |  | Medium | Open |

## Follow-up agenda

- <!-- Add item -->
`,
    },
    {
      id: 'okr-plan',
      title: t('templateLibrary.templates.okrPlan.title'),
      description: t('templateLibrary.templates.okrPlan.description'),
      category: 'planning',
      icon: 'okr',
      tone: 'lavender',
      preview: 'okr',
      content: `# {{title}}

**Cycle:** <!-- Add cycle --><br>
**Owner:**<br>
**Last updated:** {{date}}

## Objective 1

> Write a clear, motivating outcome.

| Key result | Baseline | Target | Current | Confidence |
| --- | ---: | ---: | ---: | --- |
| KR 1 |  |  |  | High |
| KR 2 |  |  |  | Medium |

### Initiatives

- [ ] <!-- Add initiative -->

## Objective 2

> Add another outcome.

| Key result | Target | Current | Owner |
| --- | ---: | ---: | --- |
| KR 1 |  |  |  |
`,
    },
    {
      id: 'product-requirements',
      title: t('templateLibrary.templates.productRequirements.title'),
      description: t('templateLibrary.templates.productRequirements.description'),
      category: 'work',
      icon: 'product',
      tone: 'cream',
      preview: 'product-brief',
      content: `# {{title}}

**Product owner:**<br>
**Status:** Draft<br>
**Last updated:** {{date}}

## Problem



## Users and needs

| User | Need | Current pain |
| --- | --- | --- |
|  |  |  |

## Proposed solution



## Requirements

- [ ] Requirement one
- [ ] Requirement two

## User flow

1. <!-- Add step -->
2. <!-- Add step -->

## Success metrics

| Metric | Target |
| --- | ---: |
|  |  |

## Risks and open questions

- <!-- Add item -->
`,
    },
    {
      id: 'flowchart',
      title: t('templateLibrary.templates.flowchart.title'),
      description: t('templateLibrary.templates.flowchart.description'),
      category: 'planning',
      icon: 'flowchart',
      tone: 'yellow',
      preview: 'flowchart',
      content: `# {{title}}

> Edit the Mermaid source to match your process.

## Diagram

\`\`\`mermaid
flowchart LR
  start([Open app]) --> login[Sign in]
  login --> account{Existing account?}
  account -- Yes --> credentials[Enter credentials]
  account -- No --> register[Complete registration]
  register --> registered{Registration successful?}
  registered -- No --> register
  registered -- Yes --> login
  credentials --> valid{Credentials valid?}
  valid -- Yes --> home([Open workspace])
  valid -- No --> credentials
  credentials --> forgot[Forgot password]
  forgot --> reset[Reset password]
  reset --> credentials
\`\`\`

## Process notes

- **Owner:**
- **Trigger:**
- **Success condition:**
- **Exceptions:**
`,
    },
    {
      id: 'project-timeline',
      title: t('templateLibrary.templates.projectTimeline.title'),
      description: t('templateLibrary.templates.projectTimeline.description'),
      category: 'planning',
      icon: 'timeline',
      tone: 'sky',
      preview: 'timeline',
      content: `# {{title}}

**Project:**<br>
**Target release:**<br>
**Updated:** {{date}}

## Timeline

\`\`\`mermaid
timeline
  title Delivery timeline
  Discovery : Research : Requirements
  Design : User flows : Prototype
  Build : Implementation : Integration
  Launch : Readiness review : Release
\`\`\`

## Milestone details

| Milestone | Owner | Target date | Dependency | Status |
| --- | --- | --- | --- | --- |
| Discovery complete |  |  |  | Not started |
| Design approved |  |  | Discovery | Not started |
| Release ready |  |  | Build | Not started |
`,
    },
    {
      id: 'organization-chart',
      title: t('templateLibrary.templates.organizationChart.title'),
      description: t('templateLibrary.templates.organizationChart.description'),
      category: 'work',
      icon: 'organization',
      tone: 'gray',
      preview: 'organization',
      content: `# {{title}}

**Organization:**<br>
**Effective date:** {{date}}

## Structure

\`\`\`mermaid
flowchart TB
  lead[Executive lead]
  lead --> product[Product]
  lead --> engineering[Engineering]
  lead --> operations[Operations]
  product --> design[Design]
  product --> research[Research]
  engineering --> platform[Platform]
  engineering --> applications[Applications]
  operations --> finance[Finance]
  operations --> people[People]
\`\`\`

## Team directory

| Team | Lead | Mission | Contact |
| --- | --- | --- | --- |
| Product |  |  |  |
| Engineering |  |  |  |
| Operations |  |  |  |
`,
    },
    {
      id: 'system-architecture',
      title: t('templateLibrary.templates.systemArchitecture.title'),
      description: t('templateLibrary.templates.systemArchitecture.description'),
      category: 'work',
      icon: 'architecture',
      tone: 'lavender',
      preview: 'architecture',
      content: `# {{title}}

**System:**<br>
**Owner:**<br>
**Updated:** {{date}}

## Architecture

\`\`\`mermaid
flowchart LR
  user[User] --> client[Client application]
  client --> gateway[API gateway]
  gateway --> auth[Authentication]
  gateway --> service[Core service]
  service --> database[(Database)]
  service --> queue[Job queue]
  queue --> worker[Background worker]
  worker --> storage[(Object storage)]
\`\`\`

## Components

| Component | Responsibility | Owner | Critical dependency |
| --- | --- | --- | --- |
| Client application |  |  |  |
| Core service |  |  |  |
| Data layer |  |  |  |

## Reliability notes

- <!-- Add item -->
`,
    },
    {
      id: 'product-development-swimlane',
      title: t('templateLibrary.templates.productDevelopmentSwimlane.title'),
      description: t('templateLibrary.templates.productDevelopmentSwimlane.description'),
      category: 'planning',
      icon: 'swimlane',
      tone: 'rose',
      preview: 'swimlane',
      content: `# {{title}}

> Use the lanes to clarify ownership and handoffs.

## Workflow

\`\`\`mermaid
flowchart LR
  subgraph Product
    brief[Define problem] --> scope[Approve scope]
  end
  subgraph Design
    explore[Explore solutions] --> prototype[Validate prototype]
  end
  subgraph Engineering
    plan[Technical plan] --> build[Build and test]
  end
  subgraph Launch
    ready[Readiness review] --> release[Release]
  end
  scope --> explore
  prototype --> plan
  build --> ready
\`\`\`

## Handoffs

| From | To | Required output | Approval |
| --- | --- | --- | --- |
| Product | Design | Approved scope | Product lead |
| Design | Engineering | Validated prototype | Design lead |
| Engineering | Launch | Tested release | Engineering lead |
`,
    },
  ]
}
