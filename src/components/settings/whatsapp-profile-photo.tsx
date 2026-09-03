'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Loader2, Camera } from 'lucide-react';
import { useAuth } from '@/hooks/use-auth';
import { useTranslations } from 'next-intl';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from '@/components/ui/card';

// ============================================================
// Business profile photo — the avatar WhatsApp users see for the
// connected number. Meta's Cloud API doesn't push the photo with
// webhooks, so we read/write it directly on the
// `whatsapp_business_profile` edge (see /api/whatsapp/profile-photo).
// ============================================================

export function WhatsAppProfilePhoto() {
  const t = useTranslations('Settings.whatsapp');
  const { accountRole, profileLoading } = useAuth();
  const canEdit = accountRole === 'admin' || accountRole === 'owner';

  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [photoUrl, setPhotoUrl] = useState<string | null>(null);
  const [about, setAbout] = useState<string | null>(null);
  const [configured, setConfigured] = useState(true);
  const inputRef = useRef<HTMLInputElement>(null);

  const fetchProfile = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/whatsapp/profile-photo');
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setConfigured(false);
        return;
      }
      setConfigured(data.configured !== false);
      setPhotoUrl(data.photo_url ?? null);
      setAbout(data.about ?? null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchProfile();
  }, [fetchProfile]);

  async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) {
      toast.error(t('profilePhotoTooLarge'));
      return;
    }
    setUploading(true);
    try {
      const body = new FormData();
      body.append('file', file);
      const res = await fetch('/api/whatsapp/profile-photo', {
        method: 'POST',
        body,
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        toast.error(t('profilePhotoFailed', { reason: data?.error || res.status }));
        return;
      }
      toast.success(t('profilePhotoUpdated'));
      await fetchProfile();
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'error';
      toast.error(t('profilePhotoFailed', { reason }));
    }
    setUploading(false);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t('profilePhotoTitle')}</CardTitle>
        <CardDescription>{t('profilePhotoDesc')}</CardDescription>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> {t('profilePhotoLoading')}
          </div>
        ) : !configured ? (
          <p className="text-sm text-muted-foreground">
            {t('profilePhotoNotConfigured')}
          </p>
        ) : (
          <div className="flex items-center gap-4">
            <div className="relative">
              <Avatar className="size-16 bg-muted border border-border">
                {photoUrl ? (
                  <AvatarImage src={photoUrl} alt={about ?? ''} />
                ) : null}
                <AvatarFallback className="bg-primary/10 text-primary text-lg font-medium">
                  {uploading ? (
                    <Loader2 className="size-5 animate-spin" />
                  ) : (
                    'W'
                  )}
                </AvatarFallback>
              </Avatar>
              {canEdit && (
                <>
                  <input
                    ref={inputRef}
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    className="hidden"
                    onChange={handleUpload}
                  />
                  <button
                    type="button"
                    onClick={() => inputRef.current?.click()}
                    disabled={uploading}
                    title={t('profilePhotoUpload')}
                    aria-label={t('profilePhotoUpload')}
                    className="absolute -bottom-1 -right-1 flex items-center justify-center size-7 rounded-full bg-primary text-primary-foreground shadow hover:opacity-90 transition-opacity cursor-pointer disabled:opacity-50"
                  >
                    <Camera className="size-3.5" />
                  </button>
                </>
              )}
            </div>
            <div className="min-w-0 text-sm">
              <p className="font-medium truncate">
                {about || t('profilePhotoNoAbout')}
              </p>
              <p className="text-muted-foreground text-xs mt-0.5">
                {photoUrl ? t('profilePhotoSet') : t('profilePhotoMissing')}
              </p>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
