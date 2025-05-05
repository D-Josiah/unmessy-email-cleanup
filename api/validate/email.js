import { EmailValidationService } from '../../src/services/email-validator.js';

// Load configuration with Supabase enabled by default
const config = {
  useZeroBounce: process.env.USE_ZERO_BOUNCE === 'true',
  zeroBounceApiKey: process.env.ZERO_BOUNCE_API_KEY || '',
  removeGmailAliases: true,
  checkAustralianTlds: true,
  // Use Supabase for persistence
  useSupabase: process.env.USE_SUPABASE !== 'false', // Enabled by default
  supabase: {
    url: process.env.SUPABASE_URL || 'https://noxlrexfrmakvnfqhxfx.supabase.co',
    key: process.env.SUPABASE_SERVICE_ROLE_KEY || ''
  },
  // Optional: Client ID for um_check_id generation
  clientId: process.env.CLIENT_ID || '00001',
  // Unmessy version number
  umessyVersion: process.env.UMESSY_VERSION || '100'
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
    
    // CRITICAL: Set a strict global timeout to ensure we respond before Vercel's timeout
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => {
        reject(new Error('Function timeout to prevent Vercel runtime timeout'));
      }, 5000); // Set to 5 seconds (half of Vercel's 10-second limit)
    });
    
    // First do a quick format check - if invalid, return immediately
    if (!emailValidator.isValidEmailFormat(email)) {
      console.log('Quick validation: Invalid email format');
      
      // Generate unmessy fields for invalid format
      const now = new Date();
      const umCheckId = emailValidator.generateUmCheckId();
      
      return res.status(200).json({
        originalEmail: email,
        currentEmail: email,
        formatValid: false,
        status: 'invalid',
        subStatus: 'bad_format',
        recheckNeeded: false,
        // Add unmessy specific fields
        date_last_um_check: now.toISOString(),
        date_last_um_check_epoch: Math.floor(now.getTime() / 1000),
        um_check_id: umCheckId,
        um_email: email,
        email: email,
        um_email_status: 'Unable to change',
        um_bounce_status: 'Likely to bounce'
      });
    }
    
    // Try to correct typos first
    const { corrected, email: correctedEmail } = emailValidator.correctEmailTypos(email);
    console.log('Typo correction result:', { corrected, correctedEmail });
    
    // Get quick validation result as a fallback
    const quickResult = emailValidator.quickValidate(email);
    
    try {
      // Race between validation and timeout, with 5 seconds max
      const result = await Promise.race([
        emailValidator.validateEmail(email, { 
          skipZeroBounce: false, 
          timeoutMs: 4000 // Even stricter timeout for the validation itself
        }),
        timeoutPromise
      ]);
      
      return res.status(200).json(result);
    } catch (error) {
      console.error('Email validation timed out or failed:', error);
      
      // Return the quick result if we hit our safety timeout
      console.log('Falling back to quick validation result');
      return res.status(200).json(quickResult);
    }
  } catch (error) {
    console.error('Fatal error validating email:', error);
    return res.status(500).json({
      error: 'Error validating email',
      details: error.message
    });
  }
}