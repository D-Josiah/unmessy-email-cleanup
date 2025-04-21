import { EmailValidationService } from '../../src/services/email-validator.js';
import crypto from 'crypto';

// Load configuration
const config = {
  environment: process.env.NODE_ENV || 'development',
  useZeroBounce: process.env.USE_ZERO_BOUNCE === 'true',
  zeroBounceApiKey: process.env.ZERO_BOUNCE_API_KEY || '',
  removeGmailAliases: true,
  checkAustralianTlds: true,
  upstash: {
    url: process.env.UPSTASH_REDIS_URL || '',
    token: process.env.UPSTASH_REDIS_TOKEN || ''
  },
  hubspot: {
    apiKey: process.env.HUBSPOT_API_KEY || '',
    clientSecret: process.env.HUBSPOT_CLIENT_SECRET || '',
  },
  skipSignatureVerification: process.env.SKIP_SIGNATURE_VERIFICATION === 'true'
};

// Initialize the email validation service
const emailValidator = new EmailValidationService(config);

export default async function handler(req, res) {
  console.log('Environment variables:', {
    NODE_ENV: process.env.NODE_ENV,
    SKIP_SIGNATURE_VERIFICATION: process.env.SKIP_SIGNATURE_VERIFICATION
  });
  
  console.log('Received webhook payload:', JSON.stringify(req.body, null, 2));
  
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  
  try {
    if (!verifyHubspotSignature(req, config)) {
      return res.status(401).json({ error: 'Invalid signature' });
    }

    res.status(200).send('Processing');

    processWebhook(req.body, config)
      .then(result => console.log('Webhook processed:', result))
      .catch(error => console.error('Error processing webhook:', error));
      
  } catch (error) {
    console.error('Error in webhook handler:', error);
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

async function processWebhook(webhookData, config) {
  try {
    console.log('Processing webhook data:', JSON.stringify(webhookData, null, 2));

    if (Array.isArray(webhookData)) {
      console.log('Webhook contains an array of events, processing each one');

      const results = [];
      for (const event of webhookData) {
        const result = await processWebhookEvent(event, config);
        results.push(result);
      }

      return {
        success: true,
        processingResults: results
      };
    } else {
      return await processWebhookEvent(webhookData, config);
    }
  } catch (error) {
    console.error('Error processing webhook:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

// Timeout wrapper for Redis ping
const pingWithTimeout = async (client, ms = 3000) => {
  return Promise.race([
    client.ping(),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Redis ping timeout')), ms)
    )
  ]);
};

async function processWebhookEvent(event, config) {
  try {
    const contactId = event.objectId;
    let email = null;

    if (event.propertyName === 'email' && event.propertyValue) {
      email = event.propertyValue;
    } else if (event.properties?.email) {
      email = event.properties.email.value || event.properties.email;
    } else if (event.email) {
      email = event.email;
    }

    const subscriptionType = event.subscriptionType || 'contact.propertyChange';

    console.log('Extracted from webhook event:', { contactId, email, subscriptionType });

    if (!email) {
      console.log(`No email found for contact ${contactId}, skipping validation`);
      return { success: false, reason: 'no_email', contactId };
    }

    const shouldValidate = shouldValidateForSubscriptionType(subscriptionType);

    if (!shouldValidate) {
      console.log(`Skipping validation for subscription type: ${subscriptionType}`);
      return { success: false, reason: 'subscription_type_skipped', contactId, subscriptionType };
    }

    console.log(`Starting email validation for: ${email}`);
    console.log('Step 1: Initializing validation');

    console.log('Redis configuration:', {
      url: config.upstash.url ? 'CONFIGURED' : 'MISSING',
      token: config.upstash.token ? 'CONFIGURED' : 'MISSING'
    });

    try {
      console.log('Testing Redis connection...');
      await pingWithTimeout(emailValidator.redis);
      console.log('Redis connection successful');
    } catch (redisError) {
      console.error('Redis connection failed or timed out:', redisError);
      throw new Error(`Redis connection error: ${redisError.message}`);
    }

    console.log('Step 2: Checking email format');
    const formatValid = emailValidator.isValidEmailFormat(email);
    console.log('Format check result:', formatValid);

    console.log('Step 3: Correcting typos');
    const typoResult = emailValidator.correctEmailTypos(email);
    console.log('Typo correction result:', typoResult);

    console.log('Step 4: Proceeding with full validation');
    const validationResult = await emailValidator.validateEmail(email);
    console.log('Email validation completed:', validationResult);

    console.log(`Updating HubSpot contact ${contactId} with validation results`);
    console.log('HubSpot configuration:', {
      apiKey: config.hubspot.apiKey ? 'CONFIGURED' : 'MISSING'
    });

    const updateResult = await emailValidator.updateHubSpotContact(contactId, validationResult);
    console.log('HubSpot contact update completed:', updateResult);

    return {
      success: true,
      contactId,
      validationResult,
      updateResult
    };
  } catch (error) {
    console.error('Error processing webhook event:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

function shouldValidateForSubscriptionType(subscriptionType) {
  const validSubscriptionTypes = [
    'contact.creation',
    'contact.propertyChange',
    'contact.merge'
  ];
  return validSubscriptionTypes.includes(subscriptionType);
}
