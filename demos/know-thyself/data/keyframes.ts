// Hand-curated keyframe manifest: moments of significant architectural change
// in trageti's history. Source documents and episodes are derived from these
// commits; the manifest is the only manual selection step.

export interface Keyframe {
  hash: string;
  position: number;
  label: string;
  date: string;
}

export const defaultKeyframes: readonly string[] = [
  'fac4ada',
  '5695df6',
  '24dc5e7',
  'bd973d5',
  '1924f45',
  'b73f7c6',
  '8350531',
  'cfeb3ac',
  '608f13e',
  'ba34a58',
];

// export const keyframes: readonly Keyframe[] = [
//   { hash: 'fac4ada', position: 1, label: 'v0.1 implementation', date: '2026-04-29' },
//   { hash: '5695df6', position: 2, label: 'v0.2 citations and trajectory retrieval', date: '2026-05-10' },
//   { hash: '24dc5e7', position: 3, label: 'v0.3 phase 1 async contract and lifecycle', date: '2026-05-19' },
//   { hash: 'bd973d5', position: 4, label: 'v0.3 phase 2 vectorless namespaces', date: '2026-05-19' },
//   { hash: '1924f45', position: 5, label: 'v0.3 phase 3 provider-driven indexing', date: '2026-05-19' },
//   { hash: 'b73f7c6', position: 6, label: 'v0.3 phase 4 retrieval routing', date: '2026-05-19' },
//   { hash: '8350531', position: 7, label: 'v0.3.0 release gate', date: '2026-05-19' },
//   { hash: 'cfeb3ac', position: 8, label: 'v0.3 remediation R1 fail-closed contracts', date: '2026-05-19' },
//   { hash: '608f13e', position: 9, label: 'v0.3 remediation R6 schema rename', date: '2026-05-20' },
//   { hash: 'ba34a58', position: 10, label: 'v0.3 polish determinism and graph fixes', date: '2026-05-21' },
// ];
