import type { TFunction } from 'i18next'

export type DocumentTemplateCategory = 'work' | 'planning' | 'customer' | 'personal'
export type DocumentTemplateIcon =
  | 'brief'
  | 'calendar'
  | 'checklist'
  | 'client'
  | 'launch'
  | 'meeting'
  | 'research'
  | 'review'
export type DocumentTemplateTone =
  | 'cream'
  | 'gray'
  | 'lavender'
  | 'mint'
  | 'peach'
  | 'rose'
  | 'sky'
  | 'yellow'

export type BuiltinDocumentTemplate = {
  id: string
  title: string
  description: string
  category: DocumentTemplateCategory
  icon: DocumentTemplateIcon
  tone: DocumentTemplateTone
  content: string
}

export function renderDocumentTemplatePlaceholders(
  body: string,
  title: string,
  now = new Date(),
): string {
  const pad = (value: number) => value.toString().padStart(2, '0')
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
  const time = `${pad(now.getHours())}:${pad(now.getMinutes())}`

  return body
    .replace(/\{\{date\}\}/g, date)
    .replace(/\{\{time\}\}/g, time)
    .replace(/\{\{title\}\}/g, title)
}

export function getBuiltinDocumentTemplates(
  t: TFunction<'document'>,
): BuiltinDocumentTemplate[] {
  return [
    {
      id: 'project-brief',
      title: t('templateLibrary.templates.projectBrief.title'),
      description: t('templateLibrary.templates.projectBrief.description'),
      category: 'work',
      icon: 'brief',
      tone: 'lavender',
      content: `# {{title}}

> Created {{date}}

## Overview

Describe the problem, the opportunity, and the outcome this project should create.

## Goals

- [ ] Goal one
- [ ] Goal two
- [ ] Goal three

## Scope

### Included

- <!-- Add item -->

### Not included

- <!-- Add item -->

## Owners

| Area | Owner | Status |
| --- | --- | --- |
| Project lead |  | Not started |
| Design |  | Not started |
| Delivery |  | Not started |

## Milestones

| Milestone | Target date | Notes |
| --- | --- | --- |
| Kickoff |  |  |
| Review |  |  |
| Launch |  |  |
`,
    },
    {
      id: 'meeting-notes',
      title: t('templateLibrary.templates.meetingNotes.title'),
      description: t('templateLibrary.templates.meetingNotes.description'),
      category: 'work',
      icon: 'meeting',
      tone: 'sky',
      content: `# {{title}}

**Date:** {{date}}<br>
**Time:** {{time}}<br>
**Attendees:**

## Agenda

1. <!-- Add item -->
2. <!-- Add item -->
3. <!-- Add item -->

## Notes

- <!-- Add item -->

## Decisions

- <!-- Add item -->

## Action items

| Action | Owner | Due date | Status |
| --- | --- | --- | --- |
|  |  |  | Open |
`,
    },
    {
      id: 'task-tracker',
      title: t('templateLibrary.templates.taskTracker.title'),
      description: t('templateLibrary.templates.taskTracker.description'),
      category: 'planning',
      icon: 'checklist',
      tone: 'mint',
      content: `# {{title}}

## This week

| Task | Owner | Priority | Due date | Status |
| --- | --- | --- | --- | --- |
|  |  | High |  | Not started |
|  |  | Medium |  | Not started |

## Waiting on

- [ ] <!-- Add item -->

## Completed

- [ ] <!-- Add item -->

## Notes

- <!-- Add item -->
`,
    },
    {
      id: 'weekly-plan',
      title: t('templateLibrary.templates.weeklyPlan.title'),
      description: t('templateLibrary.templates.weeklyPlan.description'),
      category: 'planning',
      icon: 'calendar',
      tone: 'yellow',
      content: `# {{title}}

**Week of:** {{date}}

## Top outcomes

1. <!-- Add item -->
2. <!-- Add item -->
3. <!-- Add item -->

## Schedule

| Day | Focus | Commitments |
| --- | --- | --- |
| Monday |  |  |
| Tuesday |  |  |
| Wednesday |  |  |
| Thursday |  |  |
| Friday |  |  |

## Risks and blockers

- <!-- Add item -->

## Notes for next week

- <!-- Add item -->
`,
    },
    {
      id: 'product-launch',
      title: t('templateLibrary.templates.productLaunch.title'),
      description: t('templateLibrary.templates.productLaunch.description'),
      category: 'planning',
      icon: 'launch',
      tone: 'peach',
      content: `# {{title}}

## Launch summary

**Target date:**<br>
**Audience:**<br>
**Primary message:**

## Readiness checklist

- [ ] Product scope approved
- [ ] Quality review complete
- [ ] Documentation ready
- [ ] Support briefed
- [ ] Announcement scheduled

## Launch plan

| Workstream | Owner | Deadline | Status |
| --- | --- | --- | --- |
| Product |  |  | Not started |
| Marketing |  |  | Not started |
| Sales |  |  | Not started |
| Support |  |  | Not started |

## Success measures

- <!-- Add item -->

## Post-launch review

- <!-- Add item -->
`,
    },
    {
      id: 'client-brief',
      title: t('templateLibrary.templates.clientBrief.title'),
      description: t('templateLibrary.templates.clientBrief.description'),
      category: 'customer',
      icon: 'client',
      tone: 'rose',
      content: `# {{title}}

## Account overview

**Company:**<br>
**Primary contact:**<br>
**Relationship owner:**<br>
**Last updated:** {{date}}

## Goals

- <!-- Add item -->

## Current priorities

- <!-- Add item -->

## Stakeholders

| Name | Role | Contact | Notes |
| --- | --- | --- | --- |
|  |  |  |  |

## Opportunities

- <!-- Add item -->

## Risks

- <!-- Add item -->

## Next actions

- [ ] <!-- Add item -->
`,
    },
    {
      id: 'research-notes',
      title: t('templateLibrary.templates.researchNotes.title'),
      description: t('templateLibrary.templates.researchNotes.description'),
      category: 'personal',
      icon: 'research',
      tone: 'cream',
      content: `# {{title}}

## Research question



## Sources

1. <!-- Add item -->
2. <!-- Add item -->
3. <!-- Add item -->

## Key findings

- <!-- Add item -->

## Evidence

| Finding | Source | Confidence |
| --- | --- | --- |
|  |  | Medium |

## Open questions

- <!-- Add item -->

## Synthesis


`,
    },
    {
      id: 'weekly-review',
      title: t('templateLibrary.templates.weeklyReview.title'),
      description: t('templateLibrary.templates.weeklyReview.description'),
      category: 'personal',
      icon: 'review',
      tone: 'gray',
      content: `# {{title}}

**Review date:** {{date}}

## Wins

- <!-- Add item -->

## What I learned

- <!-- Add item -->

## What felt difficult

- <!-- Add item -->

## Progress on goals

| Goal | Progress | Next step |
| --- | --- | --- |
|  |  |  |

## Priorities for next week

1. <!-- Add item -->
2. <!-- Add item -->
3. <!-- Add item -->

## Notes

- <!-- Add item -->
`,
    },
  ]
}
