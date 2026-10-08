## Findings from the selected folder

- **Current approved launch date:** **2026-11-12**  
  - Confirmed in `source://pilot-fixtures/decisions.md:4`
  - Also reflected in `source://pilot-fixtures/brief.md:3`

- **Invited team count:** **24 invited teams**  
  - Confirmed in `source://pilot-fixtures/brief.md:5`
  - Also consistent with `source://pilot-fixtures/research.md:3`, which says 18 of 24 invited teams responded.

- **Verification code near the end of the large source file:** **PILOT-7319**  
  - Found at `source://pilot-fixtures/large-source.md:1206`

## Explanation of the conflicting archived launch date

The archived launch date **2026-10-15** is from an old, superseded draft. The archive file explicitly says it was **superseded by `brief.md`** and that the early draft’s launch date and team count were **not approved**. See `source://pilot-fixtures/archive/old-brief.md:3-4`.

The current approved date is therefore **2026-11-12**, because `decisions.md` says this date “supersedes the archive proposal” at `source://pilot-fixtures/decisions.md:4`.
