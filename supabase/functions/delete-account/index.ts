// Deletes the caller's account and all of their cloud data.
// POST (Authorization: Bearer <user JWT>) -> { ok: true }
//
// folders/links/plans/ai_usage_daily rows reference auth.users with
// ON DELETE CASCADE, so deleting the auth user removes them too.

import { createSupabaseContext } from 'npm:@supabase/server@1';
import { json, preflight } from '../_server/http.ts';

export default {
  async fetch(req: Request): Promise<Response> {
    const pre = preflight(req);
    if (pre) return pre;
    if (req.method !== 'POST') return json(req, { code: 'method_not_allowed' }, 405);

    const { data: ctx, error } = await createSupabaseContext(req, { auth: 'user', cors: 'disabled' });
    if (error || !ctx?.userClaims) {
      return json(req, { code: 'unauthorized', message: error?.message ?? 'Sign in first.' }, error?.status ?? 401);
    }
    const userId = ctx.userClaims.id;

    await ctx.supabaseAdmin.from('rate_limit_buckets').delete().eq('key', 'user:' + userId);
    const { error: delError } = await ctx.supabaseAdmin.auth.admin.deleteUser(userId);
    if (delError) {
      console.error('delete-account failed', delError.message);
      return json(req, { code: 'delete_failed', message: 'Could not delete the account. Try again.' }, 500);
    }
    return json(req, { ok: true });
  },
};
