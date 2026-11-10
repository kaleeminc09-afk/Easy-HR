// NorthShift — client-side billing helpers for the app screens.
// Every screen that gates setup work (schedules, locations, invites)
// loads its billing state the same way. This is advisory only: Stripe
// + the webhook are the record of truth, and the app never blocks
// clock-in, clock-out, viewing, or CSV export on billing state. On any
// load error it fails OPEN (trialing) so a transient network blip never
// locks a paying business out of setup — the Subscription screen shows
// the real state.
import { Linking, Platform } from 'react-native';
import { getBillingState } from '../supabase/functions/hr-ai-bot/logic';

const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL;

export async function fetchBillingState(supabase, businessId) {
  const fallback = { state: 'trialing', daysLeft: 30, trialEndsAtMs: null, graceEndsAtMs: null, plan: 'starter', status: 'trialing', hasStripeCustomer: false };
  try {
    if (!businessId) return fallback;
    const [{ data: biz }, { data: sub }] = await Promise.all([
      supabase.from('businesses').select('created_at').eq('id', businessId).maybeSingle(),
      supabase.from('subscriptions').select('plan, status, trial_end, current_period_end, grace_until, stripe_customer_id').eq('business_id', businessId).maybeSingle(),
    ]);
    const s = getBillingState({ businessCreatedAt: biz?.created_at || null, subscription: sub || null });
    return { ...s, plan: sub?.plan || 'starter', status: sub?.status || 'trialing', hasStripeCustomer: !!sub?.stripe_customer_id };
  } catch {
    return fallback;
  }
}

async function callBillingFunction(supabase, name, body) {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return { error: 'Sign in again, then retry.' };
  const res = await fetch(`${SUPABASE_URL}/functions/v1/${name}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) return { error: out.error || 'Billing could not start. Try again.' };
  return { url: out.url || null };
}

// Start a Stripe Checkout for a plan slug (starter / growth / business).
// Only the slug crosses the wire — the server maps it to a price.
export async function startCheckout(supabase, plan) {
  return callBillingFunction(supabase, 'create-checkout-session', { plan });
}

// Open the Stripe Billing Portal (plan changes, card updates, cancel).
export async function startPortal(supabase) {
  return callBillingFunction(supabase, 'create-portal-session', {});
}

// Hand the browser over to a Stripe URL. Web: full-page redirect
// (Stripe returns to /subscription). Phone: the system browser.
export function openBillingUrl(url) {
  if (!url) return;
  if (Platform.OS === 'web' && typeof window !== 'undefined') window.location.assign(url);
  else Linking.openURL(url);
}
