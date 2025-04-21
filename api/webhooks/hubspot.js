import { EmailValidationService } from '../../src/services/email-validator.js';

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
  }
};

// Initialize the email validation service
const emailValidator = new EmailValidationService(config);

export default async function handler(req, res) {
  // Only allow POST method
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  
  try {
    // Respond immediately to prevent timeouts
    res.status(200).send('Processing');
    
    // Process the webhook asynchronously
    processWebhook(req.body, config)
      .then(result => console.log('Webhook processed:', result))
      .catch(error => console.error('Error processing webhook:', error));
      
  } catch (error) {
    console.error('Error in webhook handler:', error);
    // Already sent 200 response, so no need to respond again
  }
}

// Process the webhook data
async function processWebhook(webhookData, config) {
  try {
    // Support both original and simplified HubSpot webhook formats
    const contactId = webhookData.objectId || webhookData.contactId;
    const email = webhookData?.properties?.email?.value || webhookData.email;
    const subscriptionType = webhookData.subscriptionType || 'contact.propertyChange';

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
    console.error('Error processing webhook:', error);
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
