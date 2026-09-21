# Audiobookshelf native chat tools

EchoLink exposes Audiobookshelf as structured chat tools when all server-side
configuration is present. The model never receives `AUDIOBOOKSHELF_API_KEY`,
`AUDIOBOOKSHELF_URL` or `ECHO_API_KEY`.

Tools:

- `audiobookshelf_status` — read-only connectivity/library summary.
- `audiobookshelf_list_libraries` — read-only library inventory.
- `audiobookshelf_list_items` — read-only paginated compact item inventory.
- `audiobookshelf_get_item` — read-only single-item metadata and `updatedAt`.
- `audiobookshelf_update_metadata` — write tool. The model supplies only item
  IDs plus intended metadata. Approval preparation re-reads every requested
  item, binds the action to the fresh `updatedAt`, renders an old-to-new card,
  and performs no write until the user clicks Approve. The apply route checks
  those bound timestamps again immediately before writing.

The tools call only EchoLink's loopback `/api/audiobookshelf` adapter. That
adapter is still the only component that talks to the configured ABS API and
it retains the existing 25-item batch cap, stale-preview preflight and rollback
attempt on partial upstream failure.

For clear, unambiguous metadata fixes, the model calls the write-preparation
tool as soon as the audit/plan is complete. The old-to-new Approve/Deny card is
the user's single confirmation. The model must not ask for an additional
natural-language "apply"/"anwenden"/"yes" before presenting that card. A
normal-chat follow-up is reserved for genuinely ambiguous metadata choices.

The previous `skills/audiobookshelf/SKILL.md` is removed because EchoLink's
legacy skill loader reads matching skills with the terminal tool. The native
runtime policy now carries the same workflow constraints without any shell or
`curl` step.
