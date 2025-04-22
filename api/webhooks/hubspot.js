import { EmailValidationService } from '../../src/services/email-validator.js';
import crypto from 'crypto';

// Load configuration keeping Redis and ZeroBounce enabled by default
const config = {
  environment: process.env.NODE_ENV || 'development',
  useZeroBounce: process.env.USE_ZERO_BOUNCE !== 'false',
  zeroBounceApiKey: process.env.ZERO_BOUNCE_API_KEY || '',
  removeGmailAliases: true,
  checkAustralianTlds: true,
  useRedis: process.env.USE_REDIS !== 'false',
  upstash: {
    url: process.env.UPSTASH_REDIS_URL || '',
    token: process.env.UPSTASH_REDIS_TOKEN || ''
  },
  hubspot: {
    apiKey: process.env.HUBSPOT_API_KEY || '',
    clientSecret: process.env.HUBSPOT_CLIENT_SECRET || ''
  },
  skipSignatureVerification: process.env.SKIP_SIGNATURE_VERIFICATION === 'true',
  timeouts: {
    redis: 6000,
    zeroBounce: 6000,
    hubspot: 8000,
    validation: 6000,
    webhook: 8000
  }
};

const createEmailValidator = () => new EmailValidationService(config);

export default async function handler(req, res) {
  console.log('Environment variables:', {
    NODE_ENV: process.env.NODE_ENV,
    SKIP_SIGNATURE_VERIFICATION: process.env.SKIP_SIGNATURE_VERIFICATION,
    USE_REDIS: process.env.USE_REDIS,
    USE_ZERO_BOUNCE: process.env.USE_ZERO_BOUNCE
  });

  const truncatedPayload = JSON.stringify(req.body).substring(0, 500);
  console.log(`Received webhook payload (truncated): ${truncatedPayload}${truncatedPayload.length >= 500 ? '...' : ''}`);

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    if (!verifyHubspotSignature(req, config)) {
      return res.status(401).json({ error: 'Invalid signature' });
    }

    // ⬇️ Await the webhook processing synchronously for debugging
    const result = await processWebhookAsync(req.body, config);

    console.log('✅ Webhook processing completed:', result);

    return res.status(200).json({
      message: 'Webhook processed successfully',
      result
    });
  } catch (error) {
    console.error('❌ Error in webhook handler:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

function verifyHubspotSignature(req, config) {
  if (config.skipSignatureVerification) {
    console.log('Skipping signature verification as configured');
    return true;
  }

  try {
    const signature = req.headers['x-hubspot-signature'];
    const requestBody = JSON.stringify(req.body);

    if (!signature) {
      console.error('Missing HubSpot signature');
      return false;
    }

    const hash = crypto
      .createHmac('sha256', config.hubspot.clientSecret)
      .update(requestBody)
      .digest('hex');

    return hash === signature;
  } catch (error) {
    console.error('Error verifying signature:', error);
    return false;
  }
}
