import { z } from 'zod';
import { REPO_PATTERN, SLUG_PATTERN } from './github.constants';

/** POST /github/demos: guarda la demo (pod de servicio) `serviceId` como rama demo/<slug>. */
export const SaveDemoRequestSchema = z.object({
  serviceId: z.string().uuid(),
  slug: z.string().regex(SLUG_PATTERN),
  repo: z.string().regex(REPO_PATTERN).optional(),
});
export type SaveDemoRequest = z.infer<typeof SaveDemoRequestSchema>;

export const ListDemosQuerySchema = z.object({
  repo: z.string().regex(REPO_PATTERN).optional(),
});
export type ListDemosQuery = z.infer<typeof ListDemosQuerySchema>;
