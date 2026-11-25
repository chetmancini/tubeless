export const variants = ["pass", "assertion-failure"] as const;
export type Variant = (typeof variants)[number];
export type Workload = {
  id: "portable-node-check-v1";
  variant: Variant;
  repository: string;
  commit: string;
  treeSha: string;
  lockfileDigest: string;
  planDigest: string;
};

const revisions = {
  pass: {
    commit: "115e87716d640e313e4481ac442a1096a7d0bf69",
    treeSha: "4fcc46d81391f63b1c8be22b2db5f8855c5095f7",
  },
  "assertion-failure": {
    commit: "d49bf983f9b36d5987ed9dd0f87636ef01f9c158",
    treeSha: "a5fad0c320f808b3991870301c91e24134b5bcf2",
  },
} as const;

export function workload(variant: Variant): Workload {
  return {
    id: "portable-node-check-v1",
    variant,
    repository: "chetmancini/tubeless",
    ...revisions[variant],
    lockfileDigest: "o6aigou_MMjFfEGoQYWUPbCeo0pHl3K73p-sP5qJkvo",
    planDigest: "sPrELDQ3XiH-aOApNno0cgz96krMppsK4_iavG71y70",
  };
}
