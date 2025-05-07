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
      supabase: config.timeouts?.supabase || 5000,  // Increased timeout to 5 seconds for Supabase
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
  
  // Generate um_check_id based on specification
  generateUmCheckId() {
    const epochTime = Math.floor(Date.now() / 1000);
    const lastSixDigits = String(epochTime).slice(-6);
    
    // Calculate check digit
    const firstThreeDigits = String(epochTime).slice(0, 3);
    const sum = [...firstThreeDigits].reduce((acc, digit) => acc + parseInt(digit), 0);
    const checkDigit = String(sum * parseInt(this.clientId)).padStart(3, '0');
    
    // Format: lastSixDigits + clientId + checkDigit + version
    return `${lastSixDigits}${this.clientId}${checkDigit}${this.umessyVersion}`;
  }
  
  // Non-blocking Supabase check - doesn't throw, returns false on failure
  async isKnownValidEmail(email) {
    if (!this.supabaseEnabled || !this.supabase) {
      console.log('SUPABASE_CHECK: Supabase not enabled, skipping check');
      return false;
    }

    try {
      // Use AbortController and timeout
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
      
      if (result.found) {
        console.log('SUPABASE_CHECK: Email found in Supabase database', { email });
      } else {
        console.log('SUPABASE_CHECK: Email not found in Supabase database', { email });
      }
      
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
          // Create a check ID for this validation
          const umCheckId = this.generateUmCheckId();
          const now = new Date();
          
          // Map validation status to um_email_status and um_bounce_status
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
          
          // Look for existing contact with this email
          const { data: existingContact, error: contactLookupError } = await this.supabase
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
          
          // Now insert or update the email validation record
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
          
          // Check if record already exists for this email
          const { data: existingValidation, error: validationLookupError } = await this.supabase
            .from('email_validations')
            .select('id')
            .eq('email', originalEmail)
            .abortSignal(signal)
            .single();
            
          let result;
          
          if (existingValidation) {
            // Update existing record
            const { data, error } = await this.supabase
              .from('email_validations')
              .update(validationData)
              .eq('id', existingValidation.id)
              .select()
              .abortSignal(signal)
              .single();
              
            if (error) {
              throw new Error(`Failed to update validation record: ${error.message}`);
            }
            
            result = { success: true, operation: 'update', data };
          } else {
            // Insert new record
            const { data, error } = await this.supabase
              .from('email_validations')
              .insert(validationData)
              .select()
              .abortSignal(signal)
              .single();
              
            if (error) {
              throw new Error(`Failed to insert validation record: ${error.message}`);
            }
            
            result = { success: true, operation: 'insert', data };
          }
          
          console.log('SUPABASE_SAVE: Successfully saved validation result', {
            email: originalEmail,
            operation: result.operation,
            id: result.data.id
          });
          
          return result;
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
  
  // Fast local validation without external services
  quickValidate(email) {
    // Step 1: Format check
    const formatValid = this.isValidEmailFormat(email);
    if (!formatValid) {
      return {
        originalEmail: email,
        currentEmail: email,
        formatValid: false,
        wasCorrected: false,
        status: 'invalid',
        subStatus: 'bad_format',
        recheckNeeded: false,
        validationSteps: [{ step: 'format_check', passed: false }]
      };
    }
    
    // Step 2: Correct typos
    const { corrected, email: correctedEmail } = this.correctEmailTypos(email);
    
    // Step 3: Domain check
    const domainValid = this.isValidDomain(correctedEmail);
    const status = domainValid ? 'valid' : 'unknown';
    
    // Generate um_check_id
    const umCheckId = this.generateUmCheckId();
    const now = new Date();
    
    // Determine Unmessy statuses
    const umEmailStatus = corrected ? 'Changed' : 'Unchanged';
    const umBounceStatus = domainValid ? 'Unlikely to bounce' : 'Unknown';
    
    return {
      originalEmail: email,
      currentEmail: correctedEmail,
      formatValid: true,
      wasCorrected: corrected,
      domainValid,
      status,
      recheckNeeded: !domainValid,
      validationSteps: [
        { step: 'format_check', passed: true },
        { step: 'typo_correction', applied: corrected, original: email, corrected: correctedEmail },
        { step: 'domain_check', passed: domainValid }
      ],
      // Add unmessy specific fields
      date_last_um_check: now.toISOString(),
      date_last_um_check_epoch: Math.floor(now.getTime() / 1000),
      um_check_id: umCheckId,
      um_email: correctedEmail,
      email: email,
      um_email_status: umEmailStatus,
      um_bounce_status: umBounceStatus
    };
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
          
          console.log('ZEROBOUNCE_CHECK: Sending request to ZeroBounce API', { 
            email,
            url: url.toString().replace(this.config.zeroBounceApiKey, '[REDACTED]')
          });
          
          const response = await fetch(url.toString(), { signal });
          
          if (!response.ok) {
            throw new Error(`ZeroBounce API error: ${response.status} ${response.statusText}`);
          }
          
          const result = await response.json();
          
          console.log('ZEROBOUNCE_CHECK: Received response from ZeroBounce API', { 
            email,
            status: result.status,
            subStatus: result.sub_status,
            didYouMean: result.did_you_mean || null
          });
          
          // Map ZeroBounce status to our status
          let status, subStatus, recheckNeeded, suggestedEmail = null;
          
          // Generate unmessy fields
          const umCheckId = this.generateUmCheckId();
          const now = new Date();
          
          // Check for "did_you_mean" suggestions
          if (result.did_you_mean) {
            console.log('ZEROBOUNCE_CHECK: Found email suggestion from ZeroBounce', {
              original: email,
              suggested: result.did_you_mean
            });
            suggestedEmail = result.did_you_mean;
          }
          
          // Map status and determine unmessy statuses
          let umEmailStatus = suggestedEmail ? 'Changed' : 'Unchanged';
          let umBounceStatus = 'Unknown';
          
          switch (result.status) {
            case 'valid':
              status = 'valid';
              recheckNeeded = false;
              umBounceStatus = 'Unlikely to bounce';
              break;
            case 'invalid':
              status = 'invalid';
              subStatus = result.sub_status;
              recheckNeeded = false;
              umBounceStatus = 'Likely to bounce';
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
              umBounceStatus = 'Likely to bounce';
              break;
            case 'abuse':
              status = 'invalid';
              subStatus = 'abuse';
              recheckNeeded = false;
              umBounceStatus = 'Likely to bounce';
              break;
            default:
              status = 'check_failed';
              recheckNeeded = true;
          }
          
          console.log('ZEROBOUNCE_CHECK: Completed successfully', { 
            email, 
            status, 
            subStatus,
            recheckNeeded,
            suggestedEmail
          });
          
          // If valid, try to save to Supabase in background (don't await)
          if (status === 'valid') {
            this.saveValidationResult(email, {
              currentEmail: suggestedEmail || email,
              wasCorrected: !!suggestedEmail,
              status,
              recheckNeeded
            }).catch(() => {});
          }
          
          return {
            email,
            status,
            subStatus,
            recheckNeeded,
            suggestedEmail,
            source: 'zerobounce',
            details: result,
            // Add unmessy specific fields
            date_last_um_check: now.toISOString(),
            date_last_um_check_epoch: Math.floor(now.getTime() / 1000),
            um_check_id: umCheckId,
            um_email: suggestedEmail || email,
            email: email,
            um_email_status: umEmailStatus,
            um_bounce_status: umBounceStatus
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
