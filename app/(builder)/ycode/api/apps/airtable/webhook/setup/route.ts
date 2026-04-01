import { NextRequest } from 'next/server';
import {
  requireConnectionFromBody,
  updateConnection,
  requireAirtableToken,
} from '@/lib/apps/airtable/sync-service';
import { createWebhook } from '@/lib/apps/airtable';
import { noCache } from '@/lib/api-response';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * POST /ycode/api/apps/airtable/webhook/setup
 * Register an Airtable webhook for a connection's base
 */
export async function POST(request: NextRequest) {
  try {
    const connection = await requireConnectionFromBody(request);

    if (connection.webhookId) {
      return noCache({ error: 'Webhook already registered for this connection' }, 400);
    }

    const token = await requireAirtableToken();

    // Build the public webhook URL
    const baseUrl = process.env.NEXT_PUBLIC_SITE_URL || process.env.NEXT_PUBLIC_APP_URL || '';
    const notificationUrl = `${baseUrl}/api/airtable-webhook`;

    const webhook = await createWebhook(token, connection.baseId, connection.tableId, notificationUrl);

    await updateConnection(connection.id, {
      webhookId: webhook.id,
      webhookSecret: webhook.macSecretBase64,
      webhookExpiresAt: webhook.expirationTime,
      webhookCursor: 0,
    });

    return noCache({
      data: {
        webhookId: webhook.id,
        expiresAt: webhook.expirationTime,
      },
    });
  } catch (error) {
    console.error('Error setting up Airtable webhook:', error);
    return noCache(
      { error: error instanceof Error ? error.message : 'Failed to setup webhook' },
      500
    );
  }
}
