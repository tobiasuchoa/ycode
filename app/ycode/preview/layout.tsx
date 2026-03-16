import { getSettingsByKeys } from '@/lib/repositories/settingsRepository';

/** Preview layout — injects global custom body code. */
export default async function PreviewLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const settings = await getSettingsByKeys(['custom_code_body']);
  const globalCustomCodeBody = settings.custom_code_body as string | null;

  return (
    <>
      {children}
      {globalCustomCodeBody && (
        <div dangerouslySetInnerHTML={{ __html: globalCustomCodeBody }} />
      )}
    </>
  );
}
