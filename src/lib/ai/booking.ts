// ============================================================
// AI booking capture — the "AI receptionist" lead-extraction flow.
//
// After each successful auto-reply turn we ask the same BYO provider
// (one extra cheap call) to pull a structured service booking out of
// the conversation so far: who, where, what, when. When all required
// fields are present we persist a `service_bookings` row and fire an
// instant WhatsApp alert to the business owner's personal number.
//
// Everything here is best-effort: extraction or alerting must never
// break the customer-facing reply that already went out, and must
// never throw out of the caller's fire-and-forget dispatch.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'
import { aiRequestTimeoutMs, MAX_OUTPUT_TOKENS } from './defaults'
import { supabaseAdmin } from './admin-client'
import { decrypt } from '@/lib/whatsapp/encryption'
import {
  sanitizePhoneForMeta,
  isValidE164,
  phoneVariants,
} from '@/lib/whatsapp/phone-utils'
import { sendTextMessage } from '@/lib/whatsapp/meta-api'
import type { AiConfig, AiUsage, ChatMessage } from './types'

/** The fields that make a booking "complete" (location is optional). */
export interface ExtractedBooking {
  customer_name: string
  location: string | null
  service_type: string
  preferred_datetime: string
  unit_count?: number
}

interface ExtractionResponse {
  booking: ExtractedBooking | null
}

const EXTRACTION_SYSTEM_PROMPT = `You are a booking-extraction engine for a WhatsApp CRM. You read a WhatsApp conversation between a business (assistant) and a customer (user) and decide whether it contains a complete service booking request.

The customer may write in English, Sinhala script, or Romanized Sinhala ("Singlish" — e.g. "macho 2 ACs service karaganna ona Rajagiriye Saturday slot ekak thiyenawada"). Understand all of them.

A booking is complete only when the conversation contains ALL of:
- customer_name — the customer's own name (not the business's)
- location — the city, suburb, or street the job is at (null if never stated — but then the booking is incomplete)
- service_type — what they want done (e.g. "AC servicing x2", "termite treatment")
- preferred_datetime — a date/time slot, even informal ("Saturday morning")

Return ONLY a JSON object, no other text:
{"booking": {"customer_name": string, "location": string|null, "service_type": string, "preferred_datetime": string, "unit_count": number|null}}
with "booking": null when the conversation is not a complete booking. If a required field was never stated, the booking is not complete. unit_count defaults to 1; only set it above 1 when the customer states a quantity. Copy names/locations/slots as the customer wrote them (Latin script). Never invent values.`

/** Flatten the conversation turns into one readable transcript. */
function serializeConversation(messages: ChatMessage[]): string {
  return messages
    .map((m) => `${m.role === 'assistant' ? 'Business' : 'Customer'}: ${m.content}`)
    .join('\n')
}

/** Lenient JSON parse — strips code fences, ignores garbage. */
function parseBookingJson(raw: string): ExtractedBooking | null {
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '')
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start === -1 || end <= start) return null
  try {
    const parsed = JSON.parse(cleaned.slice(start, end + 1)) as ExtractionResponse
    const b = parsed?.booking
    if (!b || typeof b !== 'object') return null
    if (
      typeof b.customer_name !== 'string' ||
      !b.customer_name.trim() ||
      typeof b.service_type !== 'string' ||
      !b.service_type.trim() ||
      typeof b.preferred_datetime !== 'string' ||
      !b.preferred_datetime.trim()
    ) {
      return null
    }
    return {
      customer_name: b.customer_name.trim(),
      location:
        typeof b.location === 'string' && b.location.trim() ? b.location.trim() : null,
      service_type: b.service_type.trim(),
      preferred_datetime: b.preferred_datetime.trim(),
      unit_count:
        Number.isFinite(b.unit_count) && (b.unit_count as number) > 0
          ? Math.min(500, Math.floor(b.unit_count as number))
          : 1,
    }
  } catch {
    return null
  }
}
/**
 * Ask the account's configured provider for a structured booking.
 * OpenAI uses JSON mode; Anthropic gets the same instruction and a
 * strict JSON parse (JSON-in-text keeps one code path across both).
 */
async function extractBooking(
  config: AiConfig,
  messages: ChatMessage[],
): Promise<{ booking: ExtractedBooking | null; usage: AiUsage | null }> {
  const timeoutMs = aiRequestTimeoutMs()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    if (config.provider === 'openai') {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: config.model,
          response_format: { type: 'json_object' },
          max_completion_tokens: MAX_OUTPUT_TOKENS,
          messages: [
            { role: 'system', content: EXTRACTION_SYSTEM_PROMPT },
            { role: 'user', content: serializeConversation(messages) },
          ],
        }),
      })
      if (!res.ok) {
        console.error('[ai booking] openai extraction failed:', res.status)
        return { booking: null, usage: null }
      }
      const data = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>
        usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
      }
      const text = data.choices?.[0]?.message?.content ?? ''
      return {
        booking: parseBookingJson(text),
        usage: data.usage
          ? {
              promptTokens: data.usage.prompt_tokens ?? 0,
              completionTokens: data.usage.completion_tokens ?? 0,
              totalTokens: data.usage.total_tokens ?? 0,
            }
          : null,
      }
    }

    // Anthropic
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'x-api-key': config.apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: config.model,
        max_tokens: MAX_OUTPUT_TOKENS,
        system: EXTRACTION_SYSTEM_PROMPT,
        messages: [
          {
            role: 'user',
            content:
              serializeConversation(messages) +
              '\n\nRespond with ONLY the JSON object described in the system prompt.',
          },
        ],
      }),
    })
    if (!res.ok) {
      console.error('[ai booking] anthropic extraction failed:', res.status)
      return { booking: null, usage: null }
    }
    const data = (await res.json()) as {
      content?: Array<{ type: string; text?: string }>
      usage?: { input_tokens?: number; output_tokens?: number }
    }
    const text =
      data.content?.map((b) => (b.type === 'text' ? b.text ?? '' : '')).join('') ?? ''
    return {
      booking: parseBookingJson(text),
      usage: data.usage
        ? {
            promptTokens: data.usage.input_tokens ?? 0,
            completionTokens: data.usage.output_tokens ?? 0,
            totalTokens:
              (data.usage.input_tokens ?? 0) + (data.usage.output_tokens ?? 0),
          }
        : null,
    }
  } catch (err) {
    console.error('[ai booking] extraction error:', err)
    return { booking: null, usage: null }
  } finally {
    clearTimeout(timer)
  }
}


/**
 * Upsert the booking for this conversation. At most one *pending*
 * booking per conversation: a later, richer turn updates the existing
 * row rather than creating a duplicate lead. Returns the row id (null
 * when nothing changed).
 */
async function upsertBooking(
  db: SupabaseClient,
  args: {
    accountId: string
    conversationId: string
    contactId: string
    contactName: string | null
    contactPhone: string | null
    booking: ExtractedBooking
    sourceMessageId: string | null
  },
): Promise<string | null> {
  const {
    accountId,
    conversationId,
    contactId,
    contactName,
    contactPhone,
    booking,
    sourceMessageId,
  } = args

  const { data: existing } = await db
    .from('service_bookings')
    .select(
      'id, customer_name, location, service_type, preferred_datetime, unit_count, status',
    )
    .eq('conversation_id', conversationId)
    .eq('status', 'pending_confirmation')
    .maybeSingle()

  const values = {
    customer_name: booking.customer_name || contactName || 'Unknown',
    location: booking.location,
    service_type: booking.service_type,
    preferred_datetime: booking.preferred_datetime,
    unit_count: booking.unit_count ?? 1,
    source_message_id: sourceMessageId,
  }

  // Nothing new — don't churn the row or re-alert the owner.
  if (existing) {
    const unchanged =
      existing.customer_name === values.customer_name &&
      (existing.location ?? null) === values.location &&
      existing.service_type === values.service_type &&
      existing.preferred_datetime === values.preferred_datetime &&
      existing.unit_count === values.unit_count
    if (unchanged) return null
    const { data: updated, error } = await db
      .from('service_bookings')
      .update(values)
      .eq('id', existing.id)
      .select('id')
      .single()
    if (error) {
      console.error('[ai booking] update failed:', error)
      return null
    }
    return updated.id
  }

  const { data: inserted, error } = await db
    .from('service_bookings')
    .insert({
      account_id: accountId,
      conversation_id: conversationId,
      contact_id: contactId,
      customer_phone: contactPhone,
      status: 'pending_confirmation',
      ...values,
    })
    .select('id')
    .single()
  if (error) {
    console.error('[ai booking] insert failed:', error)
    return null
  }
  return inserted.id
}

/**
 * Send the "new lead" WhatsApp alert to the owner's personal number,
 * straight from the account's own WhatsApp credentials. Best-effort —
 * a failed alert is logged, never thrown.
 */
async function alertOwner(
  accountId: string,
  alertPhone: string,
  booking: ExtractedBooking,
  contactPhone: string | null,
): Promise<void> {
  try {
    const db = supabaseAdmin()
    const { data: config, error } = await db
      .from('whatsapp_config')
      .select('access_token, phone_number_id')
      .eq('account_id', accountId)
      .single()
    if (error || !config) {
      console.error('[ai booking] no WhatsApp config for alert:', accountId)
      return
    }

    const target = sanitizePhoneForMeta(alertPhone)
    if (!isValidE164(target)) {
      console.error('[ai booking] booking_alert_phone invalid:', alertPhone)
      return
    }

    const units = booking.unit_count ?? 1
    const text =
      `🚨 *New Service Lead Captured!*\n\n` +
      `👤 *Client:* ${booking.customer_name}\n` +
      (contactPhone ? `📞 *Phone:* +${contactPhone}\n` : '') +
      (booking.location ? `📍 *Location:* ${booking.location}\n` : '') +
      `🛠️ *Job:* ${booking.service_type} (${units} unit${units === 1 ? '' : 's'})\n` +
      `📅 *Preferred Slot:* ${booking.preferred_datetime}\n`

    const accessToken = decrypt(config.access_token)
    // Same phone-variant retry as the engines — numbers registered
    // with/without a trunk 0 need this to reliably land.
    for (const variant of phoneVariants(target)) {
      try {
        await sendTextMessage({
          phoneNumberId: config.phone_number_id,
          accessToken,
          to: variant,
          text: text,
        })
        return
      } catch (err) {
        console.error('[ai booking] alert send failed:', err)
      }
    }
  } catch (err) {
    console.error('[ai booking] alertOwner failed:', err)
  }
}

export interface CaptureBookingArgs {
  accountId: string
  conversationId: string
  contactId: string
  config: AiConfig
  messages: ChatMessage[]
  /** The inbound Meta message id that triggered this turn, for traceability. */
  sourceMessageId?: string | null
}

/**
 * Try to capture a booking from the conversation so far. Called
 * fire-and-forget after a successful auto-reply send — never throws,
 * never adds latency to the customer-facing path.
 */
export async function maybeCaptureBooking(args: CaptureBookingArgs): Promise<void> {
  const { accountId, conversationId, contactId, config, messages, sourceMessageId } = args
  try {
    const db = supabaseAdmin()

    // Need enough substance to bother calling the provider — a single
    // "hi" turn can't contain a booking.
    if (messages.length < 2) return

    const { data: contact } = await db
      .from('contacts')
      .select('name, phone')
      .eq('id', contactId)
      .eq('account_id', accountId)
      .maybeSingle()

    const { booking } = await extractBooking(config, messages)
    if (!booking) return

    const bookingId = await upsertBooking(db, {
      accountId,
      conversationId,
      contactId,
      contactName: contact?.name ?? null,
      contactPhone: contact?.phone ?? null,
      booking,
      sourceMessageId: sourceMessageId ?? null,
    })
    if (!bookingId) return // nothing new, or the write failed

    // Alert the owner only when an alert phone is configured.
    if (config.bookingAlertPhone) {
      await alertOwner(accountId, config.bookingAlertPhone, booking, contact?.phone ?? null)
    }
  } catch (err) {
    console.error('[ai booking] capture failed:', err)
  }
}