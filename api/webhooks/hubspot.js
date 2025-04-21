import { EmailValidationService } from '../../src/services/email-validator.js';
import crypto from 'crypto';

const config = {
  environment: process.env.NODE_ENV || 'development',
  useZeroBounce: process.env.USE_ZERO_BOUNCE === 'true',
  zeroBounceApiKey: process.env.ZERO_BOUNCE_API_KEY || '',
  removeGmailAliases: true,
  checkAustralianTlds: true,
  useRedis: process.env.USE_REDIS === 'true',
  upstash: {
    url: process.env.UPSTASH_REDIS_URL || '',
    token: process.env.UPSTASH_REDIS_TOKEN || ''
  },
  hubspot: {
    apiKey: process.env.HUBSPOT_API_KEY || '',
    clientSecret: process.env.HUBSPOT_CLIENT_SECRET || ''
  },
  skipSignatureVerification: process.env.SKIP_SIGNATURE_VERIFICATION === 'true'
};

// Create a new instance for each request to prevent state bleeding between requests
const createEmailValidator = () => new EmailValidationService(config);

export default async function handler(req, res) {
  console.log('Environment variables:', {
    NODE_ENV: process.env.NODE_ENV,
    SKIP_SIGNATURE_VERIFICATION: process.env.SKIP_SIGNATURE_VERIFICATION
  });

  // Log truncated payload to avoid excessive logging
  const truncatedPayload = JSON.stringify(req.body).substring(0, 500);
  console.log(`Received webhook payload (truncated): ${truncatedPayload}${truncatedPayload.length >= 500 ? '...' : ''}`);

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    if (!verifyHubspotSignature(req, config)) {
      return res.status(401).json({ error: 'Invalid signature' });
    }

    // Send immediate response to avoid timeouts
    res.status(202).json({ message: 'Processing webhook asynchronously' });

    // Process webhooks asynchronously to avoid Vercel timeout
    processWebhookAsync(req.body, config)
      .then(result => console.log('Webhook processed successfully:', { 
        success: result.success, 
        eventCount: Array.isArray(result.processingResults) ? result.processingResults.length : 0 
      }))
      .catch(error => console.error('Error processing webhook:', error));

  } catch (error) {
    console.error('Error in webhook handler:', error);
    // If response hasn't been sent yet, send an error
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal server error' });
    }
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

async function processWebhookAsync(webhookData, config) {
  try {
    // Log truncated for large payloads
    const truncatedData = JSON.stringify(webhookData).substring(0, 200);
    console.log(`Processing webhook data (truncated): ${truncatedData}${truncatedData.length >= 200 ? '...' : ''}`);

    if (Array.isArray(webhookData)) {
      console.log(`Webhook contains an array of ${webhookData.length} events, processing each one`);

      const results = [];
      for (const event of webhookData) {
        try {
          // Set a timeout for each event to prevent hanging
          const timeoutPromise = new Promise((_, reject) => {
            setTimeout(() => reject(new Error('Event processing timeout')), 8000);
          });

          const result = await Promise.race([
            processWebhookEvent(event, config),
            timeoutPromise
          ]).catch(error => {
            console.error(`Event processing error or timeout: ${error.message}`);
            return { 
              success: false, 
              error: error.message, 
              contactId: event.objectId || 'unknown'
            };
          });
          
          results.push(result);
        } catch (error) {
          console.error(`Error processing event: ${error.message}`);
          results.push({ 
            success: false, 
            error: error.message, 
            contactId: event.objectId || 'unknown'
          });
        }
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

async function processWebhookEvent(event, config) {
  // Create a new validator instance for each event
  const emailValidator = createEmailValidator();
  
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
    
    // Get quick validation result first as a fallback
    const quickResult = emailValidator.quickValidate(email);
    
    let validationResult;
    
    // Try full validation with timeout
    try {
      const validationPromise = emailValidator.validateEmail(email, {
        skipZeroBounce: false,
        timeoutMs: 3000
      });
      
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Validation timeout')), 4000);
      });
      
      validationResult = await Promise.race([validationPromise, timeoutPromise]);
    } catch (error) {
      console.error(`Validation error or timeout: ${error.message}`);
      // Use quick result as fallback
      validationResult = quickResult;
    }
    
    console.log('Email validation completed:', {
      status: validationResult.status,
      wasCorrected: validationResult.wasCorrected,
      correctedEmail: validationResult.currentEmail
    });

    console.log(`Updating HubSpot contact ${contactId} with validation results`);
    
    let updateResult;
    try {
      // Set a timeout for the HubSpot update
      const updatePromise = emailValidator.updateHubSpotContact(contactId, validationResult);
      const updateTimeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('HubSpot update timeout')), 3000);
      });
      
      updateResult = await Promise.race([updatePromise, updateTimeoutPromise]);
    } catch (error) {
      console.error(`HubSpot update error or timeout: ${error.message}`);
      updateResult = {
        success: false,
        contactId,
        error: error.message
      };
    }
    
    console.log('HubSpot contact update completed:', {
      success: updateResult.success,
      contactId
    });

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
      error: error.message,
      contactId: event.objectId || 'unknown'
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