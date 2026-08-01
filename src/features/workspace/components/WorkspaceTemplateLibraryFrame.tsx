import type { ComponentType, ReactNode } from 'react'
import { ExternalLink, Search } from 'lucide-react'

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
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-[208px_minmax(0,1fr)] max-lg:grid-cols-[196px_minmax(0,1fr)] max-md:grid-cols-1">
        <aside className="flex min-h-0 flex-col border-r bg-sidebar px-3 py-4 text-sidebar-foreground max-md:hidden">
          <label className="relative block">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <input
              type="search"
              value={query}
              onChange={(event) => onQueryChange(event.target.value)}
              placeholder="Search templates"
              className="h-9 w-full rounded-lg border border-input bg-background/75 pl-9 pr-3 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/15"
            />
          </label>
          <nav className="mt-3 min-h-0 flex-1 space-y-1 overflow-y-auto">
            {categories.map((category) => {
              const active = activeCategory === category.id && !query
              return (
              <button
                key={category.id}
                type="button"
                className={cn(
                  'relative flex h-9 w-full items-center gap-2.5 rounded-md px-3 text-left text-sm font-medium transition-colors',
                  active
                    ? 'bg-sidebar-accent text-foreground shadow-sm'
                    : 'text-sidebar-foreground hover:bg-sidebar-accent/70 hover:text-foreground',
                )}
                onClick={() => onCategoryChange(category.id)}
                data-testid={`workspace-template-category-${category.id}`}
              >
                <span className={cn('absolute left-0 h-5 w-0.5 rounded-full bg-primary transition-opacity', active ? 'opacity-100' : 'opacity-0')} />
                <category.icon className={cn('size-4 shrink-0', active ? 'text-primary' : 'text-muted-foreground')} />
                {category.label}
              </button>
              )
            })}
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
