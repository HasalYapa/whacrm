// ============================================================
// Meta Embedded Signup helpers
//
// Embedded Signup is Meta's official one-click onboarding flow: a
// customer clicks "Connect with Meta" in the CRM, a Facebook popup
// walks them through creating/authorising a WABA + phone number,
// and the popup returns a one-time `code`. This module completes
// the server-side half of the handshake:
//
//   1. exchangeSignupCode — swap the popup's `code` for a short-
//      lived access token, then immediately upgrade it to a
//      long-lived (60-day, auto-refreshable via the app) token.
//   2. listWabaPhoneNumbers — discover the phone_number_id under
//      the newly created WABA so the customer never has to open
//      Meta Business Manager and copy IDs by hand.
//
// The resulting credentials are shaped exactly like the manual
// entry form's payload, so the caller just posts them to
// POST /api/whatsapp/config and the existing verify → register →
// subscribe pipeline takes over unchanged.
// ============================================================

const META_API_VERSION = 'v21.0';
const META_API_BASE = `https://graph.facebook.com/${META_API_VERSION}`;

interface MetaErrorResponse {
  error?: { message?: string; code?: number; type?: string };
}

async function throwMetaError(response: Response, fallback: string): Promise<never> {
  let message = fallback;
  try {
    const data = (await response.json()) as MetaErrorResponse;
    if (data.error?.message) message = data.error.message;
  } catch {
    // response body wasn't JSON — keep the fallback
  }
  throw new Error(message);
}

export interface ExchangeSignupCodeArgs {
  /** The one-time code returned by the Embedded Signup popup. */
  code: string
  appId: string
  appSecret: string
}

export interface ExchangeSignupCodeResult {
  accessToken: string
  expiresIn: number | null
}

/**
 * Swap an Embedded Signup `code` for a long-lived access token.
 *
 * Two hops: code → short-lived token, then short-lived → long-lived
 * via `fb_exchange_token`. The long-lived form is what the manual
 * flow expects users to paste, so wacrm stores the same kind of
 * credential regardless of how the customer connected.
 */
export async function exchangeSignupCode(
  args: ExchangeSignupCodeArgs
): Promise<ExchangeSignupCodeResult> {
  const { code, appId, appSecret } = args;

  const shortUrl = new URL(`${META_API_BASE}/oauth/access_token`);
  shortUrl.searchParams.set('client_id', appId);
  shortUrl.searchParams.set('client_secret', appSecret);
  shortUrl.searchParams.set('code', code);

  const shortRes = await fetch(shortUrl.toString());
  if (!shortRes.ok) {
    await throwMetaError(shortRes, `Meta code exchange failed: ${shortRes.status}`);
  }
  const shortData = (await shortRes.json()) as {
    access_token?: string
    expires_in?: number
  };
  if (!shortData.access_token) {
    throw new Error('Meta code exchange returned no access token');
  }

  const longUrl = new URL(`${META_API_BASE}/oauth/access_token`);
  longUrl.searchParams.set('grant_type', 'fb_exchange_token');
  longUrl.searchParams.set('client_id', appId);
  longUrl.searchParams.set('client_secret', appSecret);
  longUrl.searchParams.set('fb_exchange_token', shortData.access_token);

  const longRes = await fetch(longUrl.toString());
  if (!longRes.ok) {
    await throwMetaError(longRes, `Meta token upgrade failed: ${longRes.status}`);
  }
  const longData = (await longRes.json()) as {
    access_token?: string
    expires_in?: number
  };
  if (!longData.access_token) {
    throw new Error('Meta token upgrade returned no access token');
  }

  return {
    accessToken: longData.access_token,
    // Long-lived page/system-style tokens can omit expires_in — treat
    // that as "no known expiry" rather than failing.
    expiresIn: longData.expires_in ?? null,
  };
}

export interface ListWabaPhoneNumbersArgs {
  wabaId: string
  accessToken: string
}

export interface EmbeddedSignupPhone {
  id: string
  display_phone_number: string
  verified_name?: string
}

/**
 * List the phone numbers registered under a WABA. After Embedded
 * Signup there is normally exactly one; the caller picks the first
 * (or matches the `phone_number_id` reported by the popup's
 * session-info message when one was supplied).
 */
export async function listWabaPhoneNumbers(
  args: ListWabaPhoneNumbersArgs
): Promise<EmbeddedSignupPhone[]> {
  const { wabaId, accessToken } = args;
  const url = `${META_API_BASE}/${wabaId}/phone_numbers?fields=id,display_phone_number,verified_name`;
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    await throwMetaError(response, `Meta API error: ${response.status}`);
  }
  const data = (await response.json()) as { data?: EmbeddedSignupPhone[] };
  return data.data ?? [];
}