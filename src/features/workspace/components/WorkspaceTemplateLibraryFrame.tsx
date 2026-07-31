import type { ComponentType, ReactNode } from 'react'
import { ChevronDown, ExternalLink, Search } from 'lucide-react'

import { cn } from '@/lib/utils'
import { DialogDescription, DialogTitle } from '@/registry/ui/dialog'

export type WorkspaceTemplateCategoryItem<CategoryId extends string> = {
  id: CategoryId
  label: string
  icon: ComponentType<{ className?: string }>
}

export const WORKSPACE_TEMPLATE_LIBRARY_DIALOG_CLASSNAME =
  'h-[min(700px,calc(100vh-4rem))] max-h-none w-[calc(100vw-2rem)] max-w-none gap-0 overflow-hidden p-0 md:w-[min(1040px,calc(100vw-8rem))]'

export function WorkspaceTemplateLibraryFrame<CategoryId extends string>({
  title,
  description,
  resourceLabel,
  icon: Icon,
  query,
  onQueryChange,
  categories,
  activeCategory,
  onCategoryChange,
  marketplaceLabel,
  children,
}: {
  title: string
  description: string
  resourceLabel: string
  icon: ComponentType<{ className?: string }>
  query: string
  onQueryChange: (value: string) => void
  categories: Array<WorkspaceTemplateCategoryItem<CategoryId>>
  activeCategory: CategoryId
  onCategoryChange: (category: CategoryId) => void
  marketplaceLabel?: string
  children: ReactNode
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-14 shrink-0 items-center gap-4 border-b px-5">
        <span className="grid size-8 place-items-center rounded-lg bg-primary text-primary-foreground">
          <Icon className="size-4" />
        </span>
        <DialogTitle className="text-lg font-semibold text-foreground">{title}</DialogTitle>
        <DialogDescription className="sr-only">{description}</DialogDescription>
        <span className="h-5 w-px bg-border" />
        <span className="inline-flex items-center gap-1 text-sm text-muted-foreground">
          {resourceLabel} <ChevronDown className="size-4" />
        </span>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-[230px_minmax(0,1fr)] max-lg:grid-cols-[210px_minmax(0,1fr)] max-md:grid-cols-1">
        <aside className="flex min-h-0 flex-col border-r bg-background px-4 py-5 max-md:hidden">
          <label className="relative block">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <input
              type="search"
              value={query}
              onChange={(event) => onQueryChange(event.target.value)}
              placeholder="Search templates"
              className="h-10 w-full rounded-lg border border-input bg-background pl-9 pr-3 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/15"
            />
          </label>
          <nav className="mt-4 min-h-0 flex-1 space-y-1 overflow-y-auto pr-1">
            {categories.map((category) => (
              <button
                key={category.id}
                type="button"
                className={cn(
                  'flex h-10 w-full items-center gap-3 rounded-lg px-3 text-left text-sm font-medium transition-colors',
                  activeCategory === category.id && !query
                    ? 'bg-accent text-primary'
                    : 'text-foreground hover:bg-muted',
                )}
                onClick={() => onCategoryChange(category.id)}
                data-testid={`workspace-template-category-${category.id}`}
              >
                <category.icon className="size-4.5 shrink-0" />
                {category.label}
              </button>
            ))}
          </nav>
          {marketplaceLabel ? (
            <span className="mt-4 flex items-center gap-3 border-t px-3 pt-5 text-sm font-medium text-muted-foreground">
              <ExternalLink className="size-4" /> {marketplaceLabel}
            </span>
          ) : null}
        </aside>

        <main className="min-h-0 overflow-y-auto bg-background px-6 pb-8 pt-6">
          {children}
        </main>
      </div>
    </div>
  )
}
