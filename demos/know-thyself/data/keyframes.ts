// Hand-curated keyframe manifest — moments of significant architectural change
// in trageti's history. The only manual curation in this demo; everything
// else is derived from git. The skeleton ships 3 keyframes; the full demo
// would cover 8–12 across v0.1 through v0.3.

export interface Keyframe {
  hash: string
  position: number
  label: string
  date: string
}

export const keyframes: readonly Keyframe[] = [
  { hash: 'fac4ada', position: 1, label: 'v0.1 initial implementation', date: '2026-05-10' },
  { hash: '5695df6', position: 2, label: 'v0.2 citations + trajectory retrieval', date: '2026-05-10' },
  { hash: '8350531', position: 3, label: 'v0.3.0 — phase 6 release', date: '2026-05-19' },
]
