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
  // Debug logging for environment variables
  console.log('Environment variables:', {
    NODE_ENV: process.env.NODE_ENV,
    SKIP_SIGNATURE_VERIFICATION: process.env.SKIP_SIGNATURE_VERIFICATION
  });
  
  console.log('Received webhook payload:', JSON.stringify(req.body, null, 2));
  
  // Only allow POST method
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  
  try {
    // Verify HubSpot signature
    if (!verifyHubspotSignature(req, config)) {
      return res.status(401).json({ error: 'Invalid signature' });
    }
    
    // Respond immediately to prevent timeouts
    res.status(200).send('Processing');
    
    // Process the webhook asynchronously
    processWebhook(req.body, config)
      .then(result => console.log('Webhook processed:', result))
      .catch(error => console.error('Error processing webhook:', error));
      
  } catch (error) {
    console.error('Error in webhook handler:', error);
    // Already sent 200 response or failed verification, so no need to respond again
  }
}

// Verify the HubSpot signature
function verifyHubspotSignature(req, config) {
  // Skip verification if explicitly configured to do so, regardless of environment
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

// Process the webhook data
async function processWebhook(webhookData, config) {
  try {
    console.log('Processing webhook data:', JSON.stringify(webhookData, null, 2));
    
    // Handle array of events - common in HubSpot webhooks
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
      // Process single event
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

// Process a single webhook event
async function processWebhookEvent(event, config) {
  try {    
    // Extract contactId from objectId
    const contactId = event.objectId;
    
    // Extract email based on webhook format
    let email = null;
    
    // For property change webhook format
    if (event.propertyName === 'email' && event.propertyValue) {
      email = event.propertyValue;
    } 
    // For standard webhook format with properties object
    else if (event.properties && event.properties.email) {
      email = event.properties.email.value || event.properties.email;
    } 
    // For simplified format
    else if (event.email) {
      email = event.email;
    }
    
    const subscriptionType = event.subscriptionType || 'contact.propertyChange';

    console.log('Extracted from webhook event:', { contactId, email, subscriptionType });

    // Only proceed if we have an email
    if (!email) {
      console.log(`No email found for contact ${contactId}, skipping validation`);
      return { 
        success: false,
        reason: 'no_email',
        contactId 
      };
    }

    // Check if we should validate based on subscription type
    const shouldValidate = shouldValidateForSubscriptionType(subscriptionType);
    
    if (!shouldValidate) {
      console.log(`Skipping validation for subscription type: ${subscriptionType}`);
      return { 
        success: false,
        reason: 'subscription_type_skipped',
        contactId,
        subscriptionType
      };
    }

    // Validate the email
    const validationResult = await emailValidator.validateEmail(email);

    // Update the contact in HubSpot with the validation results
    const updateResult = await emailValidator.updateHubSpotContact(contactId, validationResult);

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

// Determine if we should validate based on the subscription type
function shouldValidateForSubscriptionType(subscriptionType) {
  // List of subscription types that should trigger validation
  const validSubscriptionTypes = [
    'contact.creation',            // Contact created
    'contact.propertyChange',      // Contact property changed
    'contact.merge'                // Contacts merged
  ];
  
  return validSubscriptionTypes.includes(subscriptionType);
}

// Fetch contact details from HubSpot
async function fetchContactFromHubSpot(contactId, config) {
  try {
    const response = await fetch(
      `https://api.hubapi.com/crm/v3/objects/contacts/${contactId}?properties=email`,
      {
        headers: {
          'Authorization': `Bearer ${config.hubspot.apiKey}`
        }
      }
    );
    
    if (!response.ok) {
      throw new Error(`HubSpot API error: ${response.status} ${response.statusText}`);
    }
    
    return await response.json();
  } catch (error) {
    console.error(`Error fetching contact ${contactId} from HubSpot:`, error);
    throw error;
  }
}