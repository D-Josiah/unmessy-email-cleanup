import { createClient } from '@supabase/supabase-js';

export class EmailValidationService {
  constructor(config) {
    this.config = config;

    // Initialize Supabase
    this.supabase = null;
    this.supabaseEnabled = !!(config.supabase &&
                             config.supabase.url &&
                             config.supabase.key &&
                             config.useSupabase !== false);

    // Timeouts configuration with defaults - shorter timeouts to prevent HubSpot flow hanging
    this.timeouts = {
      supabase: config.timeouts?.supabase || 5000,  // Increased timeout to 5 seconds
      zeroBounce: config.timeouts?.zeroBounce || 3000,
      hubspot: config.timeouts?.hubspot || 5000,
      validation: config.timeouts?.validation || 4000, 
      webhook: config.timeouts?.webhook || 6000
    };

    // Initialize Supabase client
    if (this.supabaseEnabled) {
      try {
        console.log('SUPABASE_INIT: Initializing Supabase client');
        this.supabase = createClient(
          config.supabase.url,
          config.supabase.key
        );
        
        // Test connection in background without blocking
        this._testSupabaseConnectionAsync();
      } catch (error) {
        console.error('SUPABASE_INIT_ERROR:', { message: error.message });
        // Still keep Supabase enabled for future attempts
      }
    }

    // Common email domain typos
    this.domainTypos = {
      'gmial.com': 'gmail.com',
      'gmal.com': 'gmail.com',
      'gmail.cm': 'gmail.com',
      'gmail.co': 'gmail.com',
      'gamil.com': 'gmail.com',
      'hotmial.com': 'hotmail.com',
      'hotmail.cm': 'hotmail.com',
      'yahoo.cm': 'yahoo.com',
      'yaho.com': 'yahoo.com',
      'outlook.cm': 'outlook.com',
      'outlok.com': 'outlook.com'
    };

    this.australianTlds = ['.com.au', '.net.au', '.org.au', '.edu.au', '.gov.au', '.asn.au', '.id.au', '.au'];

    // Extended list of common domains for local validation
    this.commonValidDomains = [
      'gmail.com', 'outlook.com', 'hotmail.com', 'yahoo.com', 'icloud.com', 
      'aol.com', 'protonmail.com', 'fastmail.com', 'mail.com', 'zoho.com',
      'yandex.com', 'gmx.com', 'live.com', 'msn.com', 'me.com', 'mac.com', 
      'googlemail.com', 'pm.me', 'tutanota.com', 'mailbox.org'
    ];

    // Client ID for um_check_id generation
    this.clientId = config.clientId || '00001';
    this.umessyVersion = config.umessyVersion || '100';
  }

  // Asynchronous test without blocking operations
  async _testSupabaseConnectionAsync() {
    if (!this.supabase) return;
    
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeouts.supabase);
      
      // Try a simple query to test the connection
      const { data, error } = await this.supabase
        .from('contacts')
        .select('id')
        .limit(1)
        .abortSignal(controller.signal);
        
      clearTimeout(timeoutId);
      
      if (error) {
        throw error;
      }
      
      console.log('SUPABASE_CONNECTION_TEST: Test query successful');
    } catch (error) {
      console.error('SUPABASE_CONNECTION_TEST_FAILED:', { message: error.message });
      // Non-blocking - just log the error
    }
  }

  // Retry logic to handle temporary issues with Supabase connection
  async withRetry(promiseFn, retries = 3, delayMs = 2000) {
    let attempt = 0;
    while (attempt < retries) {
      try {
        return await promiseFn();
      } catch (error) {
        attempt++;
        if (attempt >= retries) {
          throw new Error('Max retries reached: ' + error.message);
        }
        console.warn(`Retrying Supabase operation... Attempt ${attempt}`);
        await this.sleep(delayMs); // Wait before retrying
      }
    }
  }

  // Helper function to sleep for a given duration
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // Non-blocking Supabase check - doesn't throw, returns false on failure
  async isKnownValidEmail(email) {
    if (!this.supabaseEnabled || !this.supabase) {
      console.log('SUPABASE_CHECK: Supabase not enabled, skipping check');
      return false;
    }

    try {
      const result = await this.withRetry(async () => {
        console.log('SUPABASE_CHECK: Attempting to check if email exists in Supabase', { email });

        const { data, error } = await this.supabase
          .from('email_validations')
          .select('email, um_email_status')
          .eq('email', email)
          .single();

        if (error && error.code !== 'PGRST116') { // PGRST116 is "No rows returned" error
          throw error;
        }

        return { found: !!data, data };
      });
      
      console.log('SUPABASE_CHECK: Completed successfully', { email, found: result.found });
      return result;
    } catch (error) {
      console.error('SUPABASE_CHECK_ERROR:', { message: error.message, email });
      return { found: false }; // Continue validation on failure
    }
  }

  // Save validation result to Supabase with retry logic
  async saveValidationResult(originalEmail, validationResult) {
    if (!this.supabaseEnabled || !this.supabase) {
      console.log('SUPABASE_SAVE: Supabase not enabled, skipping save');
      return false;
    }

    try {
      return await this.withRetry(async () => {
        const umCheckId = this.generateUmCheckId();
        const now = new Date();

        let umEmailStatus = validationResult.wasCorrected ? 'Changed' : 'Unchanged';
        let umBounceStatus = validationResult.status === 'valid' ? 'Unlikely to bounce' : 'Likely to bounce';

        // Check if we need to create a contact or update the existing one
        const { data: existingContact, error: contactError } = await this.supabase
          .from('email_validations')
          .select('contact_id')
          .eq('email', originalEmail)
          .single();

        if (existingContact) {
          const { data, error } = await this.supabase
            .from('email_validations')
            .update({ um_email_status: umEmailStatus, um_bounce_status: umBounceStatus })
            .eq('id', existingContact.id)
            .single();

          if (error) throw new Error(`Failed to update validation record: ${error.message}`);
          return { success: true, data };
        }

        // Create new record if not found
        const { data: newContact, error: createError } = await this.supabase
          .from('contacts')
          .insert({})
          .select('id')
          .single();

        if (createError) throw new Error(`Failed to create contact: ${createError.message}`);

        const validationData = {
          contact_id: newContact.id,
          date_last_um_check: now.toISOString(),
          date_last_um_check_epoch: Math.floor(now.getTime() / 1000),
          um_check_id: umCheckId,
          um_email: validationResult.currentEmail,
          email: originalEmail,
          um_email_status: umEmailStatus,
          um_bounce_status: umBounceStatus,
        };

        const { data, error: insertError } = await this.supabase
          .from('email_validations')
          .insert(validationData)
          .select()
          .single();

        if (insertError) throw new Error(`Failed to insert validation record: ${insertError.message}`);
        return { success: true, data };
      });
    } catch (error) {
      console.error('SUPABASE_SAVE_ERROR:', { message: error.message, email: originalEmail });
      return { success: false, error: error.message };
    }
  }

  // Basic format validation - fast and synchronous  
  isValidEmailFormat(email) {
    const emailRegex = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
    return emailRegex.test(email);
  }

  // Typo correction - fast and synchronous
  correctEmailTypos(email) {
    if (!email) {
      return { corrected: false, email };
    }
    
    let corrected = false;
    let cleanedEmail = email.trim().toLowerCase();
    
    // Remove spaces
    const noSpaceEmail = cleanedEmail.replace(/\s/g, '');
    if (noSpaceEmail !== cleanedEmail) {
      cleanedEmail = noSpaceEmail;
      corrected = true;
    }
    
    // Check for domain typos
    const [localPart, domain] = cleanedEmail.split('@');
    
    if (domain && this.domainTypos[domain]) {
      cleanedEmail = `${localPart}@${this.domainTypos[domain]}`;
      corrected = true;
    }
    
    return { corrected, email: cleanedEmail };
  }

  // ZeroBounce email validation
  async checkWithZeroBounce(email) {
    if (!this.config.zeroBounceApiKey || this.config.useZeroBounce === false) {
      console.log('ZEROBOUNCE_CHECK: ZeroBounce not configured or disabled, skipping check');
      return {
        email,
        status: 'check_skipped',
        recheckNeeded: true,
        source: 'configuration'
      };
    }

    try {
      console.log('ZEROBOUNCE_CHECK: Starting validation for email', { email });
      
      const result = await this.withRetry(async () => {
        const url = new URL('https://api.zerobounce.net/v2/validate');
        url.searchParams.append('api_key', this.config.zeroBounceApiKey);
        url.searchParams.append('email', email);
        url.searchParams.append('ip_address', '');

        const response = await fetch(url.toString());

        if (!response.ok) {
          throw new Error(`ZeroBounce API error: ${response.status} ${response.statusText}`);
        }

        const data = await response.json();

        let status, suggestedEmail = null;
        switch (data.status) {
          case 'valid':
            status = 'valid';
            suggestedEmail = data.did_you_mean;
            break;
          case 'invalid':
            status = 'invalid';
            break;
          case 'unknown':
            status = 'unknown';
            break;
          default:
            status = 'check_failed';
        }

        return {
          email,
          status,
          recheckNeeded: false,
          suggestedEmail,
          source: 'zerobounce',
          details: data
        };
      });
      
      return result;
    } catch (error) {
      console.error('ZEROBOUNCE_CHECK_ERROR:', { message: error.message, email });
      return {
        email,
        status: 'check_failed',
        recheckNeeded: true,
        source: 'zerobounce',
        error: error.message
      };
    }
  }
}
