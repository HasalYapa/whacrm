import { NextResponse } from 'next/server'
import {
  getCurrentAccount,
  requireRole,
  toErrorResponse,
} from '@/lib/auth/account'
import { decrypt } from '@/lib/whatsapp/encryption'
import { supabaseAdmin } from '@/lib/ai/admin-client'

// ============================================================
// GET/POST /api/whatsapp/profile-photo  (admin+ for POST)
//
// Manage the business profile photo of the connected WhatsApp number.
// Meta's Cloud API exposes it on the `whatsapp_business_profile` edge
// of the phone number: GET returns the current `profile_picture_url`,
// POST accepts a multipart `file` upload and forwards it to Meta.
// ============================================================

const META_API_VERSION = 'v21.0'

async function loadNumberAndToken(accountId: string) {
  const { data: config, error } = await supabaseAdmin()
    .from('whatsapp_config')
    .select('phone_number_id, access_token')
    .eq('account_id', accountId)
    .maybeSingle()
  if (error || !config?.phone_number_id || !config.access_token) {
    return null
  }
  let accessToken: string
  try {
    accessToken = decrypt(config.access_token)
  } catch {
    return null
  }
  return {
    phoneNumberId: config.phone_number_id as string,
    accessToken,
  }
}

export async function GET() {
  try {
    const { accountId } = await getCurrentAccount()
    const cfg = await loadNumberAndToken(accountId)
    if (!cfg) {
      return NextResponse.json({ configured: false })
    }
    const url = `https://graph.facebook.com/${META_API_VERSION}/${cfg.phoneNumberId}/whatsapp_business_profile?fields=profile_picture_url,about,description&access_token=${encodeURIComponent(cfg.accessToken)}`
    const res = await fetch(url, { cache: 'no-store' })
    const data = (await res.json().catch(() => null)) as {
      data?: Array<{
        profile_picture_url?: string
        about?: string
        description?: string
      }>
      error?: { message?: string }
    } | null
    if (!res.ok) {
      return NextResponse.json(
        { error: data?.error?.message || `Meta API error (${res.status})` },
        { status: 502 },
      )
    }
    const profile = data?.data?.[0]
    return NextResponse.json({
      configured: true,
      photo_url: profile?.profile_picture_url ?? null,
      about: profile?.about ?? null,
      description: profile?.description ?? null,
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function POST(request: Request) {
  try {
    const { userId } = await requireRole('admin')
    void userId

    const form = await request.formData()
    const file = form.get('file')
    if (!(file instanceof File)) {
      return NextResponse.json(
        { error: 'A photo file is required under the "file" field.' },
        { status: 400 },
      )
    }
    // Meta accepts common raster formats; keep a sane 5 MB ceiling
    // (matches the image cap Meta enforces for message media).
    if (file.size > 5 * 1024 * 1024) {
      return NextResponse.json(
        { error: 'Photo must be 5 MB or smaller.' },
        { status: 400 },
      )
    }

    const { accountId } = await getCurrentAccount()
    const cfg = await loadNumberAndToken(accountId)
    if (!cfg) {
      return NextResponse.json(
        { error: 'WhatsApp is not connected for this account.' },
        { status: 400 },
      )
    }

    const upstream = new FormData()
    upstream.append('messaging_product', 'whatsapp')
    upstream.append('file', file, file.name)
    const res = await fetch(
      `https://graph.facebook.com/${META_API_VERSION}/${cfg.phoneNumberId}/whatsapp_business_profile`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${cfg.accessToken}` },
        body: upstream,
      },
    )
    const data = (await res.json().catch(() => null)) as {
      success?: boolean
      error?: { message?: string }
    } | null
    if (!res.ok || !data?.success) {
      return NextResponse.json(
        { error: data?.error?.message || `Meta API error (${res.status})` },
        { status: 502 },
      )
    }
    return NextResponse.json({ success: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
