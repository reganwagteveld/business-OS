import { z } from 'zod';

/** GET /api/v1/health: liveness of the API. Carries no tenant or user data. */
export const HealthResponse = z
  .object({
    status: z.literal('ok'),
    service: z.literal('business-os-api'),
    apiVersion: z.literal('v1'),
  })
  .strict();

export type HealthResponse = z.infer<typeof HealthResponse>;
