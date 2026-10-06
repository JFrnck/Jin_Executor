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

const DirSchema = z
  .string()
  .max(200)
  .refine(
    (dir) =>
      dir === '.' || (!dir.startsWith('/') && !dir.split('/').includes('..')),
    'carpeta no válida',
  )
  .optional();
const BranchSchema = z.string().min(1).max(100);

/** POST /github/workspaces/:id/clone */
export const CloneRequestSchema = z.object({
  repo: z.string().regex(REPO_PATTERN),
  ref: BranchSchema.optional(),
  dir: DirSchema,
});
export type CloneRequest = z.infer<typeof CloneRequestSchema>;

/** GET /github/workspaces/:id/{status,branches}?dir= */
export const RepoDirQuerySchema = z.object({ dir: DirSchema });
export type RepoDirQuery = z.infer<typeof RepoDirQuerySchema>;

export const CheckoutRequestSchema = z.object({
  dir: DirSchema,
  branch: BranchSchema,
  create: z.boolean().optional(),
});
export type CheckoutRequest = z.infer<typeof CheckoutRequestSchema>;

export const PullRequestSchema = z.object({ dir: DirSchema });
export type PullRequest = z.infer<typeof PullRequestSchema>;

export const PushRequestSchema = z.object({
  dir: DirSchema,
  branch: BranchSchema,
  message: z.string().min(1).max(200),
});
export type PushRequest = z.infer<typeof PushRequestSchema>;
