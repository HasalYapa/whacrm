import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import {
  exchangeSignupCode,
  listWabaPhoneNumbers,
} from '@/lib/whatsapp/embedded-signup'

/**
 * Meta Embedded Signup — the official one-click onboarding flow.
 *
 * GET  /api/whatsapp/embedded-signup
 *        Returns the public config the client needs to open the
 *        Facebook popup: { app_id, config_id }. 503 when Embedded
 *        Signup isn't configured (the manual form remains the path).
 *
 * POST /api/whatsapp/embedded-signup
 *        Body: { code, waba_id?, phone_number_id? }
 *        Exchanges the popup's one-time `code` for a long-lived
 *        access token and discovers the phone number under the WABA.
 *        Returns the same credential shape the manual form posts to
 *        /api/whatsapp/config, so the client can autofill + submit
 *        through the existing verify → register → subscribe pipeline.
 *
 * Tokens never hit the client twice — the access token IS returned
 * here (the manual flow pastes it in a browser too), and it is stored
 * encrypted only via the config endpoint.
 */

function getSignupConfig() {
  const appId = process.env.META_APP_ID
  const configId = process.env.META_EMBEDDED_SIGNUP_CONFIG_ID
  return { appId, configId }
}

export async function GET() {
  const { appId, configId } = getSignupConfig()
  if (!appId || !configId) {
    return NextResponse.json(
      {
        enabled: false,
        message:
          'Embedded Signup is not configured. Set META_APP_ID and META_EMBEDDED_SIGNUP_CONFIG_ID.',
      },
      { status: 503 },
    )
  }
  return NextResponse.json({ enabled: true, app_id: appId, config_id: configId })
}

export async function POST(request: Request) {
  try {
    const { appId, configId } = getSignupConfig()
    const appSecret = process.env.META_APP_SECRET

    if (!appId || !configId || !appSecret) {
      return NextResponse.json(
        { error: 'Embedded Signup is not configured on this deployment.' },
        { status: 503 },
      )
    }

    // Auth — same session requirement as the config endpoint.
    const supabase = await createClient()
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const body = (await request.json().catch(() => null)) as {
      code?: string
      waba_id?: string
      phone_number_id?: string
    } | null

    if (!body?.code) {
      return NextResponse.json(
        { error: "'code' (from the Embedded Signup popup) is required" },
        { status: 400 },
      )
    }

    // Hop 1+2: code → short-lived token → long-lived token.
    let accessToken: string
    try {
      const result = await exchangeSignupCode({
        code: body.code,
        appId,
        appSecret,
      })
      accessToken = result.accessToken
    } catch (err) {
      console.error('[embedded-signup] code exchange failed:', err)
      return NextResponse.json(
        {
          error:
            err instanceof Error
              ? err.message
              : 'Meta token exchange failed',
        },
        { status: 502 },
      )
    }

    const wabaId = body.waba_id || ''
    if (!wabaId) {
      return NextResponse.json(
        {
          error:
            "The signup popup's session message did not include waba_id. Ensure sessionInfoVersion: '3' and the window message listener are wired on the client.",
        },
        { status: 400 },
      )
    }

    // Discover the phone number under the WABA. Prefer the one the
    // popup reported (covers multi-number WABAs); fall back to the
    // first listed number.
    let phoneNumberId = body.phone_number_id || ''
    let displayPhoneNumber: string | null = null
    try {
      const numbers = await listWabaPhoneNumbers({ wabaId, accessToken })
      if (numbers.length > 0) {
        const match = phoneNumberId
          ? numbers.find((n) => n.id === phoneNumberId)
          : numbers[0]
        const chosen = match ?? numbers[0]
        phoneNumberId = chosen.id
        displayPhoneNumber = chosen.display_phone_number
      }
    } catch (err) {
      // Discovery is best-effort: the popup usually reports
      // phone_number_id directly, so don't fail the whole exchange
      // if the list call hiccups.
      console.warn('[embedded-signup] phone number discovery failed:', err)
    }

    if (!phoneNumberId) {
      return NextResponse.json(
        { error: 'No phone number found under the WABA after signup.' },
        { status: 422 },
      )
    }

    return NextResponse.json({
      success: true,
      access_token: accessToken,
      phone_number_id: phoneNumberId,
      waba_id: wabaId,
      display_phone_number: displayPhoneNumber,
    })
  } catch (error) {
    console.error('Error in embedded-signup POST:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}