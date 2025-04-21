import { EmailValidationService } from '../../src/services/email-validator.js';

// Load configuration
const config = {
  useZeroBounce: process.env.USE_ZERO_BOUNCE === 'true',
  zeroBounceApiKey: process.env.ZERO_BOUNCE_API_KEY || '',
  removeGmailAliases: true,
  checkAustralianTlds: true,
  upstash: {
    url: process.env.UPSTASH_REDIS_URL || '',
    token: process.env.UPSTASH_REDIS_TOKEN || ''
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
    const { email } = req.body;
    
    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }
    
    // Log for debugging
    console.log('Processing email validation for:', email);
    
    // Set a timeout to ensure the function completes before Vercel's 10-second limit
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => {
        reject(new Error('Function timeout to prevent Vercel runtime timeout'));
      }, 8000); // Set to 8 seconds to ensure we return before Vercel's 10-second limit
    });
    
    // Race between validation and timeout
    const result = await Promise.race([
      emailValidator.validateEmail(email),
      timeoutPromise
    ]).catch(error => {
      console.error('Email validation timed out or failed:', error);
      
      // Return a partial result if we hit our safety timeout
      if (error.message.includes('Function timeout')) {
        return {
          originalEmail: email,
          currentEmail: email,
          formatValid: emailValidator.isValidEmailFormat(email),
          status: 'check_incomplete',
          recheckNeeded: true,
          error: 'Validation timed out'
        };
      }
      
      throw error;
    });
    
    return res.status(200).json(result);
    
  } catch (error) {
    console.error('Error validating email:', error);
    return res.status(500).json({
      error: 'Error validating email',
      details: error.message
    });
  }
}