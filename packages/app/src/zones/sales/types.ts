import type { Pipeline, Stage } from '@business-os/contracts';
import type { Member } from '../../api/customers';

/** Pipelines with their stages, and the team (for owners), loaded once per Sales Zone visit. */
export interface SalesRef {
  pipelines: { pipeline: Pipeline; stages: Stage[] }[];
  members: Member[];
}

/** Names of linked Customer Zone records, looked up by id and kept for this business only. */
export interface Names {
  customer: (id: string | null) => string | null;
  contact: (id: string | null) => string | null;
  want: (ids: { customers?: (string | null)[]; contacts?: (string | null)[] }) => void;
}
