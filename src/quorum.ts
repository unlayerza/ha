import type { Member, QuorumState } from "./types";

export function majority(n: number) {
  return Math.floor(n / 2) + 1;
}

export function quorum(
  size: number,
  healthy: number,
  serviceHealthy = healthy,
): QuorumState {
  return {
    membership: healthy >= majority(size),
    election: healthy >= majority(size),
    service: serviceHealthy >= majority(size),
    size,
    required: majority(size),
  };
}
