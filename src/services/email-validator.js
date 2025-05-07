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
      supabase: config.timeouts?.supabase || 5000,  // Increased timeout for Supabase queries
      zeroBounce: config.timeouts?.zeroBounce || 3000,
      validation: config.timeouts?.validation || 4000, 
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

    // Extended list of common domains for local validation
    this.commonValidDomains = [
      'gmail.com', 'outlook.com', 'hotmail.com', 'yahoo.com', 'icloud.com', 
      'aol.com', 'protonmail.com', 'fastmail.com', 'mail.com', 'zoho.com',
      'yandex.com', 'gmx.com', 'live.com', 'msn.com', 'me.com', 'mac.com', 
      'googlemail.com', 'pm.me', 'tutanota.com', 'mailbox.org'
    ];
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
    }
  }

  // Generic timeout wrapper with AbortController
  async withTimeout(promiseFn, timeoutMs, errorMessage = 'Operation timeout') {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    
    try {
      // Execute the function with the abort signal
      const result = await promiseFn(controller.signal);
      clearTimeout(timeoutId);
      return result;
    } catch (error) {
      clearTimeout(timeoutId);
      if (error.name === 'AbortError') {
        throw new Error(errorMessage);
      }
      throw error;
    }
  }

  // Non-blocking Supabase check - doesn't throw, returns false on failure
  async isKnownValidEmail(email) {
    if (!this.supabaseEnabled || !this.supabase) {
      console.log('SUPABASE_CHECK: Supabase not enabled, skipping check');
      return false;
    }

    try {
      const result = await this.withTimeout(
        async (signal) => {
          console.log('SUPABASE_CHECK: Attempting to check if email exists in Supabase', { email });

          const { data, error } = await this.supabase
            .from('email_validations')
            .select('email, um_email_status')
            .eq('email', email)
            .abortSignal(signal)
            .single();
          
          if (error && error.code !== 'PGRST116') { // PGRST116 is "No rows returned" error
            throw error;
          }
          
          const found = !!data;
          console.log('SUPABASE_CHECK: Completed successfully', { 
            email, 
            found, 
            status: data?.um_email_status || null
          });
          
          return {
            found,
            data
          };
        },
        this.timeouts.supabase,
        'Supabase check timeout'
      );
      
      return result;
    } catch (error) {
      console.error('SUPABASE_GET_ERROR:', { message: error.message, email });
      return { found: false }; // Continue validation on failure
    }
  }
  
  // Save validation result to Supabase
  async saveValidationResult(originalEmail, validationResult) {
    if (!this.supabaseEnabled || !this.supabase) {
      console.log('SUPABASE_SAVE: Supabase not enabled, skipping save');
      return false;
    }

    try {
      return await this.withTimeout(
        async (signal) => {
          const umCheckId = this.generateUmCheckId();
          const now = new Date();
          
          let umEmailStatus = 'Unable to change';
          let umBounceStatus = 'Unknown';
          
          if (validationResult.wasCorrected) {
            umEmailStatus = 'Changed';
          } else {
            umEmailStatus = 'Unchanged';
          }
          
          if (validationResult.status === 'valid') {
            umBounceStatus = 'Unlikely to bounce';
          } else if (validationResult.status === 'invalid') {
            umBounceStatus = 'Likely to bounce';
          }
          
          // First, check if we need to create a contact
          let contactId;
          
          const { data: existingContact, error: contactError } = await this.supabase
            .from('email_validations')
            .select('contact_id')
            .eq('email', originalEmail)
            .abortSignal(signal)
            .single();
            
          if (existingContact) {
            contactId = existingContact.contact_id;
          } else {
            // Create new contact
            const { data: newContact, error: createContactError } = await this.supabase
              .from('contacts')
              .insert({})
              .select('id')
              .abortSignal(signal)
              .single();
              
            if (createContactError) {
              throw new Error(`Failed to create contact: ${createContactError.message}`);
            }
            
            contactId = newContact.id;
          }
          
          // Insert or update the email validation record
          const validationData = {
            contact_id: contactId,
            date_last_um_check: now.toISOString(),
            date_last_um_check_epoch: Math.floor(now.getTime() / 1000),
            um_check_id: umCheckId,
            um_email: validationResult.currentEmail,
            email: originalEmail,
            um_email_status: umEmailStatus,
            um_bounce_status: umBounceStatus
          };

          const { data, error: insertError } = await this.supabase
            .from('email_validations')
            .insert(validationData)
            .select()
            .abortSignal(signal)
            .single();

          if (insertError) {
            throw new Error(`Failed to insert validation record: ${insertError.message}`);
          }
          
          return { success: true, data };
        },
        this.timeouts.supabase,
        'Supabase save timeout'
      );
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

  // Fast domain check - synchronous
  isValidDomain(email) {
    try {
      const domain = email.split('@')[1];
      if (!domain) return false;
      return this.commonValidDomains.includes(domain);
    } catch (error) {
      return false;
    }
  }

  // ZeroBounce check with proper timeout handling and did_you_mean handling
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
      
      const result = await this.withTimeout(
        async (signal) => {
          const url = new URL('https://api.zerobounce.net/v2/validate');
          url.searchParams.append('api_key', this.config.zeroBounceApiKey);
          url.searchParams.append('email', email);
          url.searchParams.append('ip_address', '');
          
          const response = await fetch(url.toString(), { signal });
          
          if (!response.ok) {
            throw new Error(`ZeroBounce API error: ${response.status} ${response.statusText}`);
          }
          
          const result = await response.json();
          
          let status, subStatus, recheckNeeded, suggestedEmail = null;
          
          // Generate unmessy fields
          const umCheckId = this.generateUmCheckId();
          const now = new Date();
          
          // Check for "did_you_mean" suggestions
          if (result.did_you_mean) {
            suggestedEmail = result.did_you_mean;
          }
          
          // Map status and determine unmessy statuses
          switch (result.status) {
            case 'valid':
              status = 'valid';
              recheckNeeded = false;
              break;
            case 'invalid':
              status = 'invalid';
              subStatus = result.sub_status;
              recheckNeeded = false;
              break;
            case 'catch-all':
            case 'unknown':
              status = 'unknown';
              recheckNeeded = true;
              break;
            case 'spamtrap':
              status = 'invalid';
              subStatus = 'spamtrap';
              recheckNeeded = false;
              break;
            case 'abuse':
              status = 'invalid';
              subStatus = 'abuse';
              recheckNeeded = false;
              break;
            default:
              status = 'check_failed';
              recheckNeeded = true;
          }
          
          return {
            email,
            status,
            subStatus,
            recheckNeeded,
            suggestedEmail,
            source: 'zerobounce',
            details: result
          };
        },
        this.timeouts.zeroBounce,
        'ZeroBounce check timeout'
      );
      
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
