/**
 * The share dialog of a co-edited document: the link to send (what it lets people do: edit,
 * comment, or view), and the room's members. The room's owner changes a member's role, removes
 * a member, and revokes a link; an editor sees the members; anyone else sees only their link.
 */
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { LoaderCircleIcon as LoaderCircle, TrashIcon as Trash2, UserMinusIcon as UserMinus } from '@kition/tessera-icons/react'
import { Button, Input } from '@kition/app-ui'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@kition/app-ui/dialog'
import { notify } from '@/lib/notify'
import { ROLE_RANK, type Member, type Role } from '@/lib/sync'
import { useDocumentCollab } from './collabStore'
import { changeMemberRole, createShareLink, listRoomMembers, ownPrincipalId, removeRoomMember, revokeShareLink, type LinkRole } from './shareActions'

/** The document being shared: its room, the editing link sharing answered, and this person's role. */
export type SharedDialogDocument = { docId: string; path: string; shareLink: string; role: Role }

const LINK_ROLES: readonly LinkRole[] = ['editor', 'commenter', 'viewer']
const ACCESS_TEST_ID: Record<LinkRole, string> = { editor: 'edit', commenter: 'comment', viewer: 'view' }

async function copyText(text: string) {
  try {
    await navigator.clipboard?.writeText(text)
    return true
  } catch {
    return false
  }
}

function initials(name: string) {
  const words = name.trim().split(/\s+/).filter(Boolean)
  return (words.length > 1 ? `${words[0][0]}${words[1][0]}` : (words[0] ?? '?').slice(0, 2)).toUpperCase()
}

export function ShareDialog({ shared, onClose, errorText }: { shared: SharedDialogDocument | null; onClose: () => void; errorText: (error: unknown) => string }) {
  const { t } = useTranslation('workspace')
  const docId = shared?.docId ?? null
  const own = shared?.role ?? 'owner'
  const isOwner = own === 'owner'
  const canList = own === 'owner' || own === 'editor'
  /** The working link for each role, as far as this dialog knows. */
  const [links, setLinks] = useState<Partial<Record<LinkRole, string>>>({})
  const [access, setAccess] = useState<LinkRole>('editor')
  const [busy, setBusy] = useState(false)
  const [members, setMembers] = useState<Member[] | null>(null)
  const [me, setMe] = useState<string | null>(null)
  const collab = useDocumentCollab(shared?.path)
  const peers = collab?.peers.map((peer) => peer.principalId).sort().join(',') ?? ''
  const allowed = LINK_ROLES.filter((role) => ROLE_RANK[role] <= ROLE_RANK[own])

  useEffect(() => {
    if (!shared) return
    const first = allowed.includes('editor') ? 'editor' : allowed[0]
    setLinks(first === 'editor' ? { editor: shared.shareLink } : { [first]: shared.shareLink })
    setAccess(first)
    setMembers(null)
    void ownPrincipalId().then(setMe, () => setMe(null))
    // A new document to share resets the dialog.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shared?.docId, shared?.shareLink])

  const refresh = useCallback(() => {
    if (!docId || !canList) return
    void listRoomMembers(docId).then(
      (result) => {
        setMembers(result.members)
        // Links the room already has are shown rather than minting more.
        setLinks((current) => {
          const next = { ...current }
          for (const link of result.links) if (!next[link.role as LinkRole]) next[link.role as LinkRole] = link.shareLink
          for (const role of LINK_ROLES) if (next[role] && !result.links.some((link) => link.shareLink === next[role])) delete next[role]
          return next
        })
      },
      () => setMembers((current) => current ?? []),
    )
  }, [docId, canList])

  // Again whenever someone joins or leaves the document.
  useEffect(refresh, [refresh, peers])

  const failed = (error: unknown) => notify.error(t('collab.shareFailed'), { description: errorText(error) })

  /** Shows the link for `role`, minting it on first use. */
  const choose = (role: LinkRole) => {
    if (!docId || busy) return
    setAccess(role)
    if (links[role]) return
    setBusy(true)
    void createShareLink(docId, role).then(
      async (link) => {
        await copyText(link)
        setLinks((current) => ({ ...current, [role]: link }))
        setBusy(false)
      },
      (error: unknown) => {
        setBusy(false)
        failed(error)
      },
    )
  }

  const revoke = () => {
    const link = links[access]
    if (!docId || !link || busy) return
    setBusy(true)
    void revokeShareLink(docId, link).then(
      () => {
        setLinks((current) => {
          const next = { ...current }
          delete next[access]
          return next
        })
        setBusy(false)
        notify.success(t('collab.linkRevoked'))
      },
      (error: unknown) => {
        setBusy(false)
        failed(error)
      },
    )
  }

  const setRole = (member: Member, role: LinkRole) => {
    if (!docId) return
    void changeMemberRole(docId, member.principalId, role).then(refresh, failed)
  }

  const remove = (member: Member) => {
    if (!docId) return
    void removeRoomMember(docId, member.principalId).then(refresh, failed)
  }

  const shown = links[access] ?? ''
  const roleLabel = (role: Role) => t(`collab.role.${role}`)

  return (
    <Dialog open={Boolean(shared)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent size="sm" className="gap-0 p-0" data-testid="collab-share-dialog">
        <DialogHeader className="space-y-2 border-b px-5 py-4">
          <DialogTitle>{t('collab.sharedTitle')}</DialogTitle>
          <DialogDescription>{t('collab.sharedDescription')}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3 px-5 py-4">
          <div className="inline-flex gap-1 rounded-lg border border-border p-0.5" role="radiogroup" aria-label={t('collab.accessLabel')}>
            {allowed.map((role) => (
              <Button
                key={role}
                type="button"
                size="sm"
                variant={access === role ? 'secondary' : 'ghost'}
                role="radio"
                aria-checked={access === role}
                disabled={busy}
                data-testid={`collab-share-access-${ACCESS_TEST_ID[role]}`}
                onClick={() => choose(role)}
              >
                {t(`collab.access.${role}`)}
              </Button>
            ))}
          </div>
          <div className="flex items-center gap-2">
            {shown ? (
              <Input readOnly value={shown} aria-label={t('collab.linkLabel')} data-testid="collab-share-link" onFocus={(event) => event.currentTarget.select()} />
            ) : (
              <Button type="button" variant="outline" className="w-full" disabled={busy} data-testid="collab-share-new-link" onClick={() => choose(access)}>
                {busy ? <LoaderCircle className="size-4 animate-spin" /> : null}
                {t('collab.newLink')}
              </Button>
            )}
            {isOwner && shown ? (
              <Button type="button" variant="ghost" size="icon" title={t('collab.revokeLink')} aria-label={t('collab.revokeLink')} disabled={busy} data-testid="collab-share-revoke" onClick={revoke}>
                <Trash2 className="size-4" />
              </Button>
            ) : null}
          </div>
          {canList ? (
            <div className="space-y-1 pt-1" data-testid="collab-members">
              <div className="text-[12px] font-medium text-muted-foreground">{t('collab.members')}</div>
              {members === null ? <LoaderCircle className="size-4 animate-spin text-muted-foreground" /> : null}
              {(members ?? []).map((member) => {
                const self = member.principalId === me
                const name = member.name || member.principalId
                return (
                  <div key={member.principalId} className="flex items-center gap-2 rounded-lg px-1 py-1" data-testid="collab-member" data-member={name} data-role={member.role}>
                    <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-[11px] font-medium">{initials(name)}</span>
                    <span className="min-w-0 flex-1 truncate text-[13px]">{self ? t('collab.memberYou', { name }) : name}</span>
                    {isOwner && member.role !== 'owner' ? (
                      <>
                        <select
                          className="h-7 rounded-lg border border-border bg-background px-1.5 text-[12px]"
                          value={member.role}
                          aria-label={t('collab.memberRole', { name })}
                          data-testid="collab-member-role"
                          onChange={(event) => setRole(member, event.target.value as LinkRole)}
                        >
                          {LINK_ROLES.map((role) => (
                            <option key={role} value={role}>
                              {roleLabel(role)}
                            </option>
                          ))}
                        </select>
                        <Button type="button" variant="ghost" size="icon" className="size-7" title={t('collab.removeMember', { name })} aria-label={t('collab.removeMember', { name })} data-testid="collab-member-remove" onClick={() => remove(member)}>
                          <UserMinus className="size-4" />
                        </Button>
                      </>
                    ) : (
                      <span className="text-[12px] text-muted-foreground">{roleLabel(member.role)}</span>
                    )}
                  </div>
                )
              })}
            </div>
          ) : null}
        </div>
        <DialogFooter className="border-t px-5 py-4">
          <Button type="button" variant="outline" onClick={onClose}>
            {t('collab.close')}
          </Button>
          <Button
            type="button"
            disabled={!shown}
            onClick={() => {
              if (shown) void copyText(shown).then((copied) => copied && notify.success(t('collab.linkCopied')))
            }}
          >
            {t('collab.copyLink')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
