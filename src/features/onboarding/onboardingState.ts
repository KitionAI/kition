import { getWorkspaceStorageKey } from './workspaceStorageKey'

export type OnboardingProviderChoice = 'cloud' | 'byo' | 'local'
export type OnboardingStatus = 'pending' | 'completed' | 'skipped'

export type WorkspaceOnboardingState = {
  version: 1
  status: OnboardingStatus
  providerChoice?: OnboardingProviderChoice
  updatedAt: string
}

function storageKey(workspacePath: string) {
  return getWorkspaceStorageKey(workspacePath, 'onboarding.v1')
}

export function readWorkspaceOnboardingState(workspacePath: string): WorkspaceOnboardingState | null {
  if (!workspacePath) return null
  try {
    const value = JSON.parse(localStorage.getItem(storageKey(workspacePath)) || 'null') as Partial<WorkspaceOnboardingState> | null
    if (!value || value.version !== 1) return null
    if (value.status !== 'pending' && value.status !== 'completed' && value.status !== 'skipped') return null
    return {
      version: 1,
      status: value.status,
      providerChoice: value.providerChoice,
      updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : '',
    }
  } catch {
    return null
  }
}

function writeWorkspaceOnboardingState(
  workspacePath: string,
  status: OnboardingStatus,
  providerChoice?: OnboardingProviderChoice,
) {
  if (!workspacePath) return
  try {
    localStorage.setItem(storageKey(workspacePath), JSON.stringify({
      version: 1,
      status,
      ...(providerChoice ? { providerChoice } : {}),
      updatedAt: new Date().toISOString(),
    } satisfies WorkspaceOnboardingState))
  } catch {
    // Onboarding never blocks workspace use when local storage is unavailable.
  }
}

export function markWorkspaceOnboardingPending(workspacePath: string) {
  if (!readWorkspaceOnboardingState(workspacePath)) {
    writeWorkspaceOnboardingState(workspacePath, 'pending')
  }
}

export function completeWorkspaceOnboarding(workspacePath: string, providerChoice: OnboardingProviderChoice) {
  writeWorkspaceOnboardingState(workspacePath, 'completed', providerChoice)
}

export function skipWorkspaceOnboarding(workspacePath: string) {
  writeWorkspaceOnboardingState(workspacePath, 'skipped')
}

export function shouldShowWorkspaceOnboarding(workspacePath: string) {
  return readWorkspaceOnboardingState(workspacePath)?.status === 'pending'
}
