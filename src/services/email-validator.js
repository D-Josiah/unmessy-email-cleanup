// src/services/email-validator.js
import { createClient } from '@supabase/supabase-js';

export class EmailValidationService {
  constructor(config) {
    this.config = config;
    
    // Status tracking for Supabase connection
    this.supabaseConnectionStatus = 'initializing';
    
    // Detailed logging for initialization
    console.log('EMAIL_VALIDATOR_INIT: Initializing email validation service', {
      useSupabase: config.useSupabase,
      supabaseUrlProvided: !!config.supabase?.url,
      supabaseKeyProvided: !!config.supabase?.key && config.supabase.key.length > 0,
      useZeroBounce: config.useZeroBounce
    });
    
    // Initialize Supabase by checking all required fields
    this.supabase = null;
    this.supabaseEnabled = !!(config.supabase && 
                             config.supabase.url && 
                             config.supabase.url.includes('supabase.co') &&
                             config.supabase.key && 
                             config.supabase.key.length > 0 &&
                             config.useSupabase !== false);
    
    // Log whether Supabase was enabled and why/why not
    if (this.supabaseEnabled) {
      console.log('EMAIL_VALIDATOR_INIT: Supabase storage enabled');
    } else {
      console.log('EMAIL_VALIDATOR_INIT: Supabase storage disabled', {
        reasons: {
          configMissing: !config.supabase,
          urlMissing: !config.supabase?.url,
          urlInvalid: config.supabase?.url && !config.supabase.url.includes('supabase.co'),
          keyMissing: !config.supabase?.key,
          keyInvalid: config.supabase?.key && config.supabase.key.length === 0,
          explicitlyDisabled: config.useSupabase === false
        }
      });
      this.supabaseConnectionStatus = 'disabled';
    }
    
    // Initialize Supabase client if enabled
    if (this.supabaseEnabled) {
      try {
        console.log('EMAIL_VALIDATOR_INIT: Creating Supabase client with provided configuration');
        
        this.supabase = createClient(
          config.supabase.url,
          config.supabase.key,
          {
            auth: { 
              persistSession: false,
              autoRefreshToken: false
            },
            // Add custom fetch with longer timeout
            global: {
              headers: {
                'Content-Type': 'application/json'
              },
              fetch: (...args) => {
                return fetch(...args, {
                  // Increase timeout significantly
                  signal: AbortSignal.timeout(15000) // 15 seconds timeout
                });
              }
            }
          }
        );
        
        console.log('EMAIL_VALIDATOR_INIT: Supabase client created successfully');
        
        // Don't test connection immediately - defer until needed
        this.supabaseConnectionStatus = 'pending';
      } catch (error) {
        console.error('EMAIL_VALIDATOR_INIT_ERROR:', { 
          message: error.message,
          stack: error.stack 
        });
        this.supabaseConnectionStatus = 'error';
      }
    }
    
    // Timeouts configuration with defaults - UPDATED with longer ZeroBounce timeout
    this.timeouts = {
      supabase: config.timeouts?.supabase || 8000,
      zeroBounce: config.timeouts?.zeroBounce || 6000, // Increased from 4000 to 6000ms
      zeroBounceRetry: config.timeouts?.zeroBounceRetry || 8000, // New timeout for retry
      validation: config.timeouts?.validation || 7000, // Increased to accommodate retry
      webhook: config.timeouts?.webhook || 6000
    };

    // Initialize domain correction features
    this.config.removeGmailAliases = config.removeGmailAliases !== false; // Default to true
    
    // Client ID for um_check_id generation
    this.clientId = config.clientId || '00001';
    this.umessyVersion = config.umessyVersion || '100';
    
    // Configure ZeroBounce retry settings
    this.zeroBounceMaxRetries = config.zeroBounceMaxRetries || 1; // Default to 1 retry
  }

  // Asynchronous test without blocking operations
  async _testSupabaseConnectionAsync() {
    if (!this.supabase) {
      console.log('SUPABASE_CONNECTION_TEST: No Supabase client initialized');
      this.supabaseConnectionStatus = 'disabled';
      return;
    }
    
    try {
      console.log('SUPABASE_CONNECTION_TEST: Attempting to connect to Supabase...');
      
      // Simpler approach without abort controller for more reliable connection
      try {
        // Make a simple query that's fast - just check if the table exists
        const { data, error } = await this.supabase
          .from('contacts')
          .select('id')
          .limit(1);
        
        if (error) {
          console.error('SUPABASE_CONNECTION_FAILED:', { 
            message: error.message,
            code: error.code,
            details: error.details
          });
          this.supabaseConnectionStatus = 'failed';
          return;
        }
        
        // Connection successful
        console.log('SUPABASE_CONNECTION_SUCCESSFUL: Successfully connected to Supabase database', {
          tableName: 'contacts',
          approximateRowCount: data ? data.length : 0
        });
        this.supabaseConnectionStatus = 'connected';
      } catch (innerError) {
        throw innerError;
      }
    } catch (error) {
      console.error('SUPABASE_CONNECTION_TEST_ERROR:', { 
        message: error.message,
        stack: error.stack
      });
      this.supabaseConnectionStatus = 'error';
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
  
  // UPDATED: Format date as spelled out date instead of ISO format
  formatDateString(date) {
    const options = { 
      weekday: 'long',
      year: 'numeric', 
      month: 'long', 
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
      timeZoneName: 'short'
    };
    
    return date.toLocaleDateString('en-US', options);
  }
  
  // UPDATED: Generate um_check_id based on specification using milliseconds for uniqueness
  generateUmCheckId(customClientId = null) {
    // Use milliseconds instead of seconds for greater uniqueness
    const epochTime = Date.now(); // This gives milliseconds
    const lastSixDigits = String(epochTime).slice(-6);
    
    // Use provided client ID or default
    const clientId = customClientId || this.clientId;
    
    // Calculate check digit using the first few digits of the timestamp
    const firstThreeDigits = String(epochTime).slice(0, 3);
    const sum = [...firstThreeDigits].reduce((acc, digit) => acc + parseInt(digit), 0);
    const checkDigit = String(sum * parseInt(clientId)).padStart(3, '0');
    
    // Format: lastSixDigits + clientId + checkDigit + version
    return `${lastSixDigits}${clientId}${checkDigit}${this.umessyVersion}`;
  }
  
  // Check if a domain is in the invalid domains table
  async checkInvalidDomain(domain) {
    if (!this.supabaseEnabled || !this.supabase || !domain) {
      console.log('DB_CHECK_INVALID_DOMAIN: Supabase not enabled or no domain provided');
      return false;
    }
    
    // Ensure connection is established
    if (this.supabaseConnectionStatus === 'pending' || this.supabaseConnectionStatus === 'initializing') {
      try {
        console.log('DB_CHECK_INVALID_DOMAIN: Testing connection before check');
        await this._testSupabaseConnectionAsync();
      } catch (error) {
        console.error('DB_CHECK_INVALID_DOMAIN: Connection test failed', { error: error.message });
        return false;
      }
    }
    
    if (this.supabaseConnectionStatus !== 'connected') {
      console.log('DB_CHECK_INVALID_DOMAIN: Supabase not connected, skipping check', {
        connectionStatus: this.supabaseConnectionStatus
      });
      return false;
    }
    
    try {
      console.log('DB_CHECK_INVALID_DOMAIN: Checking if domain is in invalid_domains table', { domain });
      
      const { data, error } = await this.supabase
        .from('invalid_domains')
        .select('id')
        .eq('domain', domain)
        .maybeSingle();
      
      if (error) {
        console.error('DB_CHECK_INVALID_DOMAIN_ERROR: Query error', {
          error: error.message,
          code: error.code,
          domain
        });
        return false;
      }
      
      const isInvalid = !!data;
      
      console.log('DB_CHECK_INVALID_DOMAIN: Check completed', {
        domain,
        isInvalid,
        found: isInvalid
      });
      
      return isInvalid;
    } catch (error) {
      console.error('DB_CHECK_INVALID_DOMAIN_ERROR: Exception during check', {
        error: error.message,
        stack: error.stack,
        domain
      });
      return false;
    }
  }
  
  // Check if a domain is in the common valid domains table
  async checkCommonValidDomain(domain) {
    if (!this.supabaseEnabled || !this.supabase || !domain) {
      console.log('DB_CHECK_COMMON_VALID_DOMAIN: Supabase not enabled or no domain provided');
      return false;
    }
    
    // Ensure connection is established
    if (this.supabaseConnectionStatus === 'pending' || this.supabaseConnectionStatus === 'initializing') {
      try {
        console.log('DB_CHECK_COMMON_VALID_DOMAIN: Testing connection before check');
        await this._testSupabaseConnectionAsync();
      } catch (error) {
        console.error('DB_CHECK_COMMON_VALID_DOMAIN: Connection test failed', { error: error.message });
        return false;
      }
    }
    
    if (this.supabaseConnectionStatus !== 'connected') {
      console.log('DB_CHECK_COMMON_VALID_DOMAIN: Supabase not connected, skipping check', {
        connectionStatus: this.supabaseConnectionStatus
      });
      return false;
    }
    
    try {
      console.log('DB_CHECK_COMMON_VALID_DOMAIN: Checking if domain is in common_valid_domains table', { domain });
      
      const { data, error } = await this.supabase
        .from('common_valid_domains')
        .select('id')
        .eq('domain', domain)
        .maybeSingle();
      
      if (error) {
        console.error('DB_CHECK_COMMON_VALID_DOMAIN_ERROR: Query error', {
          error: error.message,
          code: error.code,
          domain
        });
        return false;
      }
      
      const isCommonValid = !!data;
      
      console.log('DB_CHECK_COMMON_VALID_DOMAIN: Check completed', {
        domain,
        isCommonValid,
        found: isCommonValid
      });
      
      return isCommonValid;
    } catch (error) {
      console.error('DB_CHECK_COMMON_VALID_DOMAIN_ERROR: Exception during check', {
        error: error.message,
        stack: error.stack,
        domain
      });
      return false;
    }
  }
  
  // Check if a domain has a typo and get the correction
  async checkDomainTypo(domain) {
    if (!this.supabaseEnabled || !this.supabase || !domain) {
      console.log('DB_CHECK_DOMAIN_TYPO: Supabase not enabled or no domain provided');
      return null;
    }
    
    // Ensure connection is established
    if (this.supabaseConnectionStatus === 'pending' || this.supabaseConnectionStatus === 'initializing') {
      try {
        console.log('DB_CHECK_DOMAIN_TYPO: Testing connection before check');
        await this._testSupabaseConnectionAsync();
      } catch (error) {
        console.error('DB_CHECK_DOMAIN_TYPO: Connection test failed', { error: error.message });
        return null;
      }
    }
    
    if (this.supabaseConnectionStatus !== 'connected') {
      console.log('DB_CHECK_DOMAIN_TYPO: Supabase not connected, skipping check', {
        connectionStatus: this.supabaseConnectionStatus
      });
      return null;
    }
    
    try {
      console.log('DB_CHECK_DOMAIN_TYPO: Checking if domain has a typo correction', { domain });
      
      const { data, error } = await this.supabase
        .from('domain_typos')
        .select('correct_domain')
        .eq('typo_domain', domain)
        .maybeSingle();
      
      if (error) {
        console.error('DB_CHECK_DOMAIN_TYPO_ERROR: Query error', {
          error: error.message,
          code: error.code,
          domain
        });
        return null;
      }
      
      const correction = data ? data.correct_domain : null;
      
      console.log('DB_CHECK_DOMAIN_TYPO: Check completed', {
        domain,
        hasCorrection: !!correction,
        correction
      });
      
      return correction;
    } catch (error) {
      console.error('DB_CHECK_DOMAIN_TYPO_ERROR: Exception during check', {
        error: error.message,
        stack: error.stack,
        domain
      });
      return null;
    }
  }
  
  // Check if the domain has a TLD that needs correction
  async checkTldCorrection(domain) {
    if (!this.supabaseEnabled || !this.supabase || !domain) {
      console.log('DB_CHECK_TLD_CORRECTION: Supabase not enabled or no domain provided');
      return null;
    }
    
    // Ensure connection is established
    if (this.supabaseConnectionStatus === 'pending' || this.supabaseConnectionStatus === 'initializing') {
      try {
        console.log('DB_CHECK_TLD_CORRECTION: Testing connection before check');
        await this._testSupabaseConnectionAsync();
      } catch (error) {
        console.error('DB_CHECK_TLD_CORRECTION: Connection test failed', { error: error.message });
        return null;
      }
    }
    
    if (this.supabaseConnectionStatus !== 'connected') {
      console.log('DB_CHECK_TLD_CORRECTION: Supabase not connected, skipping check', {
        connectionStatus: this.supabaseConnectionStatus
      });
      return null;
    }
    
    try {
      console.log('DB_CHECK_TLD_CORRECTION: Checking if domain has TLD issues', { domain });
      
      // Get all TLDs from the database
      const { data: tldData, error: tldError } = await this.supabase
        .from('valid_tlds')
        .select('tld');
      
      if (tldError) {
        console.error('DB_CHECK_TLD_CORRECTION_ERROR: Query error', {
          error: tldError.message,
          code: tldError.code,
          domain
        });
        return null;
      }
      
      if (!tldData || tldData.length === 0) {
        console.log('DB_CHECK_TLD_CORRECTION: No TLDs found in database');
        return null;
      }
      
      // Check each TLD for potential corrections
      for (const row of tldData) {
        const tld = row.tld;
        const tldNoDot = tld.replace(/\./g, '');
        
        if (domain.endsWith(tldNoDot) && !domain.endsWith(tld)) {
          const index = domain.lastIndexOf(tldNoDot);
          const correctedDomain = domain.substring(0, index) + tld;
          
          console.log('DB_CHECK_TLD_CORRECTION: Found TLD correction', {
            domain,
            tld,
            tldNoDot,
            correctedDomain
          });
          
          return correctedDomain;
        }
      }
      
      console.log('DB_CHECK_TLD_CORRECTION: No TLD issues found', { domain });
      return null;
    } catch (error) {
      console.error('DB_CHECK_TLD_CORRECTION_ERROR: Exception during check', {
        error: error.message,
        stack: error.stack,
        domain
      });
      return null;
    }
  }
  
  // Non-blocking Supabase check - doesn't throw, returns false on failure
  async isKnownValidEmail(email) {
    if (!this.supabaseEnabled || !this.supabase) {
      console.log('SUPABASE_CHECK: Supabase not enabled, skipping check');
      return { found: false };
    }

    try {
      // Use AbortController and timeout
      const result = await this.withTimeout(
        async (signal) => {
          console.log('SUPABASE_CHECK: Attempting to check if email exists in Supabase', { email });
          
          const { data, error } = await this.supabase
            .from('email_validations')
            .select('email, um_email_status, um_bounce_status, date_last_um_check, date_last_um_check_epoch, um_check_id')
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
  
  // Save validation result to Supabase with improved reliability
  async saveValidationResult(email, validationResult, clientId = null) {
    // Only proceed if the email is valid
    if (validationResult.status !== 'valid') {
      console.log('SUPABASE_SAVE: Skipping save for invalid email', {
        email: email,
        status: validationResult.status,
        clientId: clientId || 'default'
      });
      return { success: false, reason: 'Email is not valid', status: validationResult.status };
    }
    
    if (!this.supabaseEnabled || !this.supabase) {
      console.log('SUPABASE_SAVE: Supabase not enabled, skipping save', {
        supabaseEnabled: this.supabaseEnabled,
        supabaseClientExists: !!this.supabase,
        connectionStatus: this.supabaseConnectionStatus
      });
      return { success: false, reason: 'Supabase not enabled' };
    }

    // First, check our connection status and test if needed
    if (this.supabaseConnectionStatus === 'pending' || this.supabaseConnectionStatus === 'initializing') {
      try {
        console.log('SUPABASE_SAVE: Testing connection before save attempt');
        await this._testSupabaseConnectionAsync();
        
        // If the test succeeded but we still don't have a connected status, wait briefly
        if (this.supabaseConnectionStatus === 'connected') {
          console.log('SUPABASE_SAVE: Connection test successful, proceeding with save');
        } else {
          console.log('SUPABASE_SAVE: Connection test did not result in connected status', {
            status: this.supabaseConnectionStatus
          });
          return { success: false, reason: 'Connection test failed' };
        }
      } catch (error) {
        console.error('SUPABASE_SAVE: Connection test failed', { error: error.message });
        return { success: false, reason: 'Connection test error: ' + error.message };
      }
    }
    
    // Only proceed if we have a confirmed connection
    if (this.supabaseConnectionStatus !== 'connected') {
      console.log('SUPABASE_SAVE: Skipping save due to connection status', {
        connectionStatus: this.supabaseConnectionStatus
      });
      return { success: false, reason: 'Supabase not connected' };
    }

    try {
      console.log('SUPABASE_SAVE: Starting save operation for valid email', { 
        email: email,
        clientId: clientId || 'default'
      });
      
      // Create a check ID for this validation if not already present
      const umCheckId = validationResult.um_check_id || this.generateUmCheckId(clientId);
      const now = new Date();
      
      // UPDATED: Format date as spelled out date and use milliseconds for epoch
      const formattedDate = this.formatDateString(now);
      const epochTimeMs = now.getTime(); // Use full milliseconds for uniqueness
      
      // Map validation status to um_email_status and um_bounce_status
      let umEmailStatus = validationResult.um_email_status || 'Unable to change';
      let umBounceStatus = validationResult.um_bounce_status || 'Unknown';
      
      if (!validationResult.um_email_status) {
        if (validationResult.wasCorrected) {
          umEmailStatus = 'Changed';
        } else {
          umEmailStatus = 'Unchanged';
        }
      }
      
      if (!validationResult.um_bounce_status) {
        if (validationResult.status === 'valid') {
          umBounceStatus = 'Unlikely to bounce';
        } else if (validationResult.status === 'invalid') {
          umBounceStatus = 'Likely to bounce';
        }
      }
      
      // First, check if the email already exists in the database
      console.log('SUPABASE_SAVE: Checking if email already exists in database', { email: email });
      
      const { data: existingRecord, error: searchError } = await this.supabase
        .from('email_validations')
        .select('id, contact_id')
        .eq('email', email)
        .maybeSingle();
        
      if (searchError && searchError.code !== 'PGRST116') { // PGRST116 is "No rows returned" error
        console.error('SUPABASE_SAVE_ERROR: Error searching for existing record', {
          error: searchError.message,
          code: searchError.code
        });
        throw new Error(`Failed to search for existing record: ${searchError.message}`);
      }
      
      // If email exists, update the existing record
      if (existingRecord) {
        console.log('SUPABASE_SAVE: Email found in database, updating existing record', {
          email: email,
          recordId: existingRecord.id,
          contactId: existingRecord.contact_id
        });
        
        // Prepare update data with new date format and millisecond epoch
        const updateData = {
          date_last_um_check: validationResult.date_last_um_check || formattedDate,
          date_last_um_check_epoch: validationResult.date_last_um_check_epoch || epochTimeMs,
          um_check_id: umCheckId,
          um_email: validationResult.currentEmail || validationResult.um_email || email,
          um_email_status: umEmailStatus,
          um_bounce_status: umBounceStatus
        };
        
        // Update the existing record
        const { data: updatedRecord, error: updateError } = await this.supabase
          .from('email_validations')
          .update(updateData)
          .eq('id', existingRecord.id)
          .select()
          .single();
          
        if (updateError) {
          console.error('SUPABASE_SAVE_ERROR: Failed to update existing record', {
            error: updateError.message,
            code: updateError.code
          });
          throw new Error(`Failed to update existing record: ${updateError.message}`);
        }
        
        console.log('SUPABASE_SAVE: Successfully updated existing record', {
          email: email,
          operation: 'update',
          id: updatedRecord.id,
          clientId: clientId || 'default'
        });
        
        return { success: true, operation: 'update', data: updatedRecord };
      }
      
      // If email doesn't exist, create a new contact and validation record
      console.log('SUPABASE_SAVE: Email not found in database, creating new record');
      
      // First, create a contact - use a simpler approach to avoid transaction issues
      console.log('SUPABASE_SAVE: Creating new contact');
      let contactId;
      
      try {
        // Direct insert without transaction for better reliability
        const { data: newContact, error: createContactError } = await this.supabase
          .from('contacts')
          .insert({})
          .select('id')
          .single();
          
        if (createContactError) {
          console.error('SUPABASE_SAVE_ERROR: Failed to create contact', {
            error: createContactError.message,
            code: createContactError.code
          });
          throw new Error(`Failed to create contact: ${createContactError.message}`);
        }
        
        contactId = newContact.id;
        console.log('SUPABASE_SAVE: Created new contact', { contactId });
      } catch (contactError) {
        console.error('SUPABASE_SAVE_ERROR: Exception creating contact', { error: contactError.message });
        throw contactError;
      }
      
      // Now insert the email validation record with updated date format and millisecond epoch
      const validationData = {
        contact_id: contactId,
        date_last_um_check: validationResult.date_last_um_check || formattedDate,
        date_last_um_check_epoch: validationResult.date_last_um_check_epoch || epochTimeMs,
        um_check_id: umCheckId,
        um_email: validationResult.currentEmail || validationResult.um_email || email,
        email: email,
        um_email_status: umEmailStatus,
        um_bounce_status: umBounceStatus
      };
      
      try {
        console.log('SUPABASE_SAVE: Creating new validation record', {
          contactId,
          email: email,
          umEmail: validationData.um_email,
          clientId: clientId || 'default'
        });
        
        const { data, error } = await this.supabase
          .from('email_validations')
          .insert(validationData)
          .select()
          .single();
          
        if (error) {
          console.error('SUPABASE_SAVE_ERROR: Failed to insert validation record', {
            error: error.message,
            code: error.code
          });
          throw new Error(`Failed to insert validation record: ${error.message}`);
        }
        
        console.log('SUPABASE_SAVE: Successfully saved validation result', {
          email: email,
          operation: 'insert',
          id: data.id,
          clientId: clientId || 'default'
        });
        
        return { success: true, operation: 'insert', data };
      } catch (validationError) {
        console.error('SUPABASE_SAVE_ERROR: Exception creating validation record', { 
          error: validationError.message 
        });
        throw validationError;
      }
    } catch (error) {
      console.error('SUPABASE_SAVE_ERROR:', { 
        message: error.message, 
        stack: error.stack,
        email: email
      });
      return { success: false, error: error.message };
    }
  }
  
  // Basic format validation - fast and synchronous  
  isValidEmailFormat(email) {
    const emailRegex = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
    return emailRegex.test(email);
  }
  
  // Updated email typo correction with database checks
  async correctEmailTypos(email) {
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
    
    // Check for domain typos from database
    const [localPart, domain] = cleanedEmail.split('@');
    
    if (domain) {
      // Check for domain typo correction
      const correctedDomain = await this.checkDomainTypo(domain);
      if (correctedDomain) {
        cleanedEmail = `${localPart}@${correctedDomain}`;
        corrected = true;
      }
      
      // Handle Gmail aliases
      if (this.config.removeGmailAliases && domain === 'gmail.com' && localPart.includes('+')) {
        const baseLocal = localPart.split('+')[0];
        cleanedEmail = `${baseLocal}@gmail.com`;
        corrected = true;
      }
      
      // Check for TLD corrections from database
      const [, domainAfterCorrection] = cleanedEmail.split('@');
      const tldCorrectedDomain = await this.checkTldCorrection(domainAfterCorrection);
      if (tldCorrectedDomain) {
        cleanedEmail = `${localPart}@${tldCorrectedDomain}`;
        corrected = true;
      }
    }
    
    return { corrected, email: cleanedEmail };
  }
  
  // Updated domain validity check with database lookup
  async isValidDomain(email) {
    try {
      const domain = email.split('@')[1];
      if (!domain) return false;
      
      // First check if it's in the invalid domains list
      const isInvalid = await this.checkInvalidDomain(domain);
      if (isInvalid) {
        console.log('DOMAIN_VALIDITY_CHECK: Domain is in invalid domains list', { domain });
        return false;
      }
      
      // Then check if it's in the common valid domains list
      const isCommonValid = await this.checkCommonValidDomain(domain);
      console.log('DOMAIN_VALIDITY_CHECK: Domain validity check completed', { 
        domain, 
        isValid: isCommonValid 
      });
      
      return isCommonValid;
    } catch (error) {
      console.error('DOMAIN_VALIDITY_CHECK_ERROR: Exception during check', {
        error: error.message,
        email
      });
      return false;
    }
  }
  
  // UPDATED: Quick validation with database checks for domain validity and new date formats
  async quickValidate(email, clientId = null) {
    // Step 1: Format check (synchronous)
    const formatValid = this.isValidEmailFormat(email);
    if (!formatValid) {
      // UPDATED: Use new date format and millisecond epoch
      const now = new Date();
      const formattedDate = this.formatDateString(now);
      const epochTimeMs = now.getTime();
      
      return {
        originalEmail: email,
        currentEmail: email,
        formatValid: false,
        wasCorrected: false,
        status: 'invalid',
        subStatus: 'bad_format',
        recheckNeeded: false,
        validationSteps: [{ step: 'format_check', passed: false }],
        // Add unmessy specific fields with updated formats
        date_last_um_check: formattedDate,
        date_last_um_check_epoch: epochTimeMs,
        um_check_id: this.generateUmCheckId(clientId),
        um_email: email,
        email: email,
        um_email_status: 'Unable to change',
        um_bounce_status: 'Likely to bounce'
      };
    }
    
    // Step 2: Correct typos (now async with database checks)
    const { corrected, email: correctedEmail } = await this.correctEmailTypos(email);
    
    // Extract domain for further checks
    const domain = correctedEmail.split('@')[1];
    
    // Step 3: Check if domain is in invalid domains list (async)
    const isInvalidDomain = await this.checkInvalidDomain(domain);
    
    // If domain is in invalid domains list, mark as invalid and skip further checks
    if (isInvalidDomain) {
      console.log('QUICK_VALIDATE: Domain is invalid (in invalid_domains table)', { domain });
      
      // UPDATED: Generate um_check_id and timestamps with new formats
      const umCheckId = this.generateUmCheckId(clientId);
      const now = new Date();
      const formattedDate = this.formatDateString(now);
      const epochTimeMs = now.getTime();
      
      return {
        originalEmail: email,
        currentEmail: correctedEmail,
        formatValid: true,
        wasCorrected: corrected,
        domainValid: false,
        isInvalidDomain: true,
        status: 'invalid',
        subStatus: 'invalid_domain',
        recheckNeeded: false,
        validationSteps: [
          { step: 'format_check', passed: true },
          { step: 'typo_correction', applied: corrected, original: email, corrected: correctedEmail },
          { step: 'invalid_domain_check', passed: false, domain: domain }
        ],
        // Updated unmessy specific fields
        date_last_um_check: formattedDate,
        date_last_um_check_epoch: epochTimeMs,
        um_check_id: umCheckId,
        um_email: correctedEmail,
        email: email,
        um_email_status: corrected ? 'Changed' : 'Unchanged',
        um_bounce_status: 'Likely to bounce'
      };
    }
    
    // Step 4: Check if domain is in common valid domains list (async)
    const domainValid = await this.isValidDomain(correctedEmail);
    const status = domainValid ? 'valid' : 'unknown';
    
    // UPDATED: Generate um_check_id and timestamps with new formats
    const umCheckId = this.generateUmCheckId(clientId);
    const now = new Date();
    const formattedDate = this.formatDateString(now);
    const epochTimeMs = now.getTime();
    
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
      // Updated unmessy specific fields
      date_last_um_check: formattedDate,
      date_last_um_check_epoch: epochTimeMs,
      um_check_id: umCheckId,
      um_email: correctedEmail,
      email: email,
      um_email_status: umEmailStatus,
      um_bounce_status: umBounceStatus
    };
  }
  
  // UPDATED: ZeroBounce check with retry logic, longer timeouts, and updated date formats
  async checkWithZeroBounce(email, clientId = null, retryCount = 0) {
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
      console.log('ZEROBOUNCE_CHECK: Starting validation for email', { 
        email,
        clientId: clientId || 'default',
        retryAttempt: retryCount
      });
      
      // Determine which timeout to use based on retry count
      const timeoutMs = retryCount > 0 
        ? this.timeouts.zeroBounceRetry  // Use longer timeout for retry
        : this.timeouts.zeroBounce;      // Use standard timeout for first attempt
      
      const result = await this.withTimeout(
        async (signal) => {
          const url = new URL('https://api.zerobounce.net/v2/validate');
          url.searchParams.append('api_key', this.config.zeroBounceApiKey);
          url.searchParams.append('email', email);
          url.searchParams.append('ip_address', '');
          
          console.log('ZEROBOUNCE_CHECK: Sending request to ZeroBounce API', { 
            email,
            retryAttempt: retryCount,
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
            didYouMean: result.did_you_mean || null,
            retryAttempt: retryCount
          });
          
          // UPDATED: Generate unmessy fields with new date format and millisecond epoch
          const umCheckId = this.generateUmCheckId(clientId);
          const now = new Date();
          const formattedDate = this.formatDateString(now);
          const epochTimeMs = now.getTime();
          
          // Check for "did_you_mean" suggestions
          let suggestedEmail = null;
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
          let status, subStatus, recheckNeeded;
          
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
            suggestedEmail,
            clientId: clientId || 'default',
            retryAttempt: retryCount
          });
          
          return {
            email,
            status,
            subStatus,
            recheckNeeded,
            suggestedEmail,
            source: 'zerobounce',
            details: result,
            retryCount,
            // Add unmessy specific fields with updated formats
            date_last_um_check: formattedDate,
            date_last_um_check_epoch: epochTimeMs,
            um_check_id: umCheckId,
            um_email: suggestedEmail || email,
            email: email,
            um_email_status: umEmailStatus,
            um_bounce_status: umBounceStatus
          };
        },
        timeoutMs,
        'ZeroBounce check timeout'
      );
      
      return result;
    } catch (error) {
      console.error('ZEROBOUNCE_CHECK_ERROR:', { 
        message: error.message, 
        email,
        clientId: clientId || 'default',
        retryAttempt: retryCount
      });
      
      // UPDATED: Implement retry logic on timeout or failure
      const isTimeout = error.message.includes('timeout');
      const shouldRetry = retryCount < this.zeroBounceMaxRetries; 
      
      if ((isTimeout || error.message.includes('network')) && shouldRetry) {
        console.log('ZEROBOUNCE_CHECK: Retrying after error', {
          email,
          retryCount,
          error: error.message
        });
        
        // Wait briefly before retry (exponential backoff)
        const backoffDelay = Math.min(1000 * Math.pow(2, retryCount), 3000);
        await new Promise(resolve => setTimeout(resolve, backoffDelay));
        
        // Retry the check with incremented retry count
        return this.checkWithZeroBounce(email, clientId, retryCount + 1);
      }
      
      // Return failure response if we can't retry
      return {
        email,
        status: 'check_failed',
        recheckNeeded: true,
        source: 'zerobounce',
        error: error.message,
        retryCount,
        isTimeout
      };
    }
  }
  
  // UPDATED: Save data synchronously during validation with retry logic and new date formats
  async validateEmail(email, options = {}) {
    const { 
      skipZeroBounce = false, 
      timeoutMs = this.timeouts.validation, 
      isRetry = false,
      clientId = null,  // Parameter to track which client made the request
      retryCount = 0    // Track ZeroBounce retry attempts
    } = options;
    
    console.log('VALIDATION_PROCESS: Starting validation for email', { 
      email, 
      skipZeroBounce, 
      timeoutMs,
      isRetry,
      retryCount,
      clientId: clientId || 'default',
      supabaseStatus: this.supabaseConnectionStatus
    });
    
    // Start with quick validation (now async with database checks)
    const quickResult = await this.quickValidate(email, clientId);
    
    // If format is invalid, return immediately
    if (!quickResult.formatValid) {
      console.log('VALIDATION_PROCESS: Invalid format detected, returning quick result');
      return quickResult;
    }
    
    // If domain is invalid (in invalid_domains table), return immediately and skip ZeroBounce
    if (quickResult.isInvalidDomain) {
      console.log('VALIDATION_PROCESS: Domain is in invalid domains list, returning invalid without ZeroBounce check', {
        email: quickResult.currentEmail,
        domain: quickResult.currentEmail.split('@')[1]
      });
      return quickResult;
    }
    
    // Set a global timeout for the entire validation process
    try {
      console.log('VALIDATION_PROCESS: Starting advanced validation checks');
      
      const result = await this.withTimeout(
        async () => {
          // Log the process
          console.log('VALIDATION_PROCESS: Running Supabase and ZeroBounce checks in parallel');
          
          // Run Supabase check and ZeroBounce check in parallel
          const [knownValidResult, zeroBounceResult] = await Promise.allSettled([
            this.isKnownValidEmail(quickResult.currentEmail),
            skipZeroBounce ? null : this.checkWithZeroBounce(quickResult.currentEmail, clientId, retryCount)
          ]);
          
          // Start with the quick result and enhance it
          const result = { ...quickResult };
          
          // Add Supabase result if successful - this is the database fallback
          if (knownValidResult.status === 'fulfilled' && knownValidResult.value.found) {
            console.log('VALIDATION_PROCESS: Email found in Supabase database, marking as valid', { 
              email: quickResult.currentEmail 
            });
            
            const validationData = knownValidResult.value.data;
            
            // Update the result with data from the database
            if (validationData) {
              result.isKnownValid = true;
              result.status = validationData.um_bounce_status === 'Unlikely to bounce' ? 'valid' : 'invalid';
              result.recheckNeeded = false;
              
              // Include the stored Supabase data in the result
              Object.assign(result, {
                um_email_status: validationData.um_email_status,
                um_bounce_status: validationData.um_bounce_status,
                date_last_um_check: validationData.date_last_um_check,
                date_last_um_check_epoch: validationData.date_last_um_check_epoch,
                um_check_id: validationData.um_check_id
              });
            }
            
            result.validationSteps.push({ step: 'known_valid_check', passed: true });
            
            // If we already have a recent validation, we can return early
            // UPDATED: Check if date_last_um_check_epoch is in milliseconds or seconds format
            const lastCheckMs = typeof validationData.date_last_um_check_epoch === 'number' && 
                               validationData.date_last_um_check_epoch > 1000000000000
              ? validationData.date_last_um_check_epoch  // Already in milliseconds
              : (validationData.date_last_um_check_epoch || 0) * 1000;  // Convert seconds to milliseconds

            if (validationData && Date.now() - lastCheckMs < 7 * 24 * 60 * 60 * 1000) {
              return result;
            }
          } else {
            console.log('VALIDATION_PROCESS: Email not found in Supabase or check failed', {
              email: quickResult.currentEmail,
              status: knownValidResult.status
            });
            
            result.isKnownValid = false;
            result.validationSteps.push({ 
              step: 'known_valid_check', 
              passed: false, 
              error: knownValidResult.status === 'rejected' ? knownValidResult.reason.message : null 
            });
          }
          
          // UPDATED: Check ZeroBounce result and handle retry failures
          if (!skipZeroBounce && zeroBounceResult?.status === 'fulfilled' && zeroBounceResult.value) {
            const bounceCheck = zeroBounceResult.value;
            
            console.log('VALIDATION_PROCESS: ZeroBounce check completed', {
              email: quickResult.currentEmail,
              status: bounceCheck.status,
              subStatus: bounceCheck.subStatus,
              suggestedEmail: bounceCheck.suggestedEmail,
              retryCount: bounceCheck.retryCount || 0,
              clientId: clientId || 'default'
            });
            
            // Check for suggested email from ZeroBounce
            if (bounceCheck.suggestedEmail && !isRetry) {
              console.log('VALIDATION_PROCESS: ZeroBounce suggested an email correction, revalidating', {
                originalEmail: email,
                suggestedEmail: bounceCheck.suggestedEmail
              });
              
              // Before revalidating, check if the suggested domain is in the invalid domains list
              const suggestedDomain = bounceCheck.suggestedEmail.split('@')[1];
              const isSuggestedDomainInvalid = await this.checkInvalidDomain(suggestedDomain);
              
              if (isSuggestedDomainInvalid) {
                console.log('VALIDATION_PROCESS: ZeroBounce suggested domain is in invalid domains list, ignoring suggestion', {
                  suggestedEmail: bounceCheck.suggestedEmail,
                  suggestedDomain
                });
                
                // Update the result to indicate invalid domain
                result.status = 'invalid';
                result.subStatus = 'invalid_domain';
                result.recheckNeeded = false;
                result.um_bounce_status = 'Likely to bounce';
                
                result.validationSteps.push({
                  step: 'zerobounce_suggestion',
                  original: email,
                  suggested: bounceCheck.suggestedEmail,
                  suggestedDomainInvalid: true,
                  result: 'invalid'
                });
                
                return result;
              }
              
              // Recursive call with the suggested email, but mark as a retry to prevent infinite loops
              const suggestedEmailResult = await this.validateEmail(bounceCheck.suggestedEmail, {
                skipZeroBounce: false,  // Always check with ZeroBounce for the suggested email
                timeoutMs: timeoutMs * 0.8,  // Reduce timeout for the retry to ensure we don't exceed the original
                isRetry: true,  // Mark this as a retry to prevent infinite loops
                clientId: clientId  // Pass along client ID
              });
              
              // Add information about the suggestion to the result
              suggestedEmailResult.originalEmail = email;
              suggestedEmailResult.wasCorrected = true;
              suggestedEmailResult.validationSteps.push({
                step: 'zerobounce_suggestion',
                original: email,
                suggested: bounceCheck.suggestedEmail,
                result: suggestedEmailResult.status
              });
              
              // Update unmessy fields
              suggestedEmailResult.um_email_status = 'Changed';
              suggestedEmailResult.email = email;
              
              console.log('VALIDATION_PROCESS: Completed validation with ZeroBounce suggestion', {
                originalEmail: email,
                suggestedEmail: bounceCheck.suggestedEmail,
                finalStatus: suggestedEmailResult.status,
                clientId: clientId || 'default'
              });
              
              return suggestedEmailResult;
            }
            
            // Only update if we got a definitive result or no suggested email was available
            if (bounceCheck.status === 'valid' || bounceCheck.status === 'invalid') {
              result.status = bounceCheck.status;
              result.subStatus = bounceCheck.subStatus;
              result.recheckNeeded = bounceCheck.recheckNeeded;
              
              // Update unmessy fields from ZeroBounce results
              result.um_bounce_status = bounceCheck.um_bounce_status;
              result.um_check_id = bounceCheck.um_check_id;
              result.date_last_um_check = bounceCheck.date_last_um_check;
              result.date_last_um_check_epoch = bounceCheck.date_last_um_check_epoch;
            }
            
            result.validationSteps.push({
              step: 'zerobounce_check',
              result: bounceCheck
            });
          } else if (!skipZeroBounce) {
            // UPDATED: Handle ZeroBounce failure (including after retries)
            console.log('VALIDATION_PROCESS: ZeroBounce check failed or was skipped', {
              email: quickResult.currentEmail,
              error: zeroBounceResult?.reason?.message || 'Failed or skipped',
              retryCount: retryCount
            });
            
            // If this was a timeout and we still have domain check results, use those instead
            if (zeroBounceResult?.reason?.message?.includes('timeout') || 
                (zeroBounceResult?.value?.error?.includes('timeout'))) {
              
              console.log('VALIDATION_PROCESS: ZeroBounce timed out, using database check results', {
                email: quickResult.currentEmail,
                domainValid: result.domainValid
              });
              
              // If domain is valid according to database checks, we can consider the email valid
              if (result.domainValid) {
                console.log('VALIDATION_PROCESS: Domain valid in database, marking as valid despite ZeroBounce timeout');
                result.status = 'valid';
                result.recheckNeeded = false;
                result.um_bounce_status = 'Unlikely to bounce';
                
                // Ensure we have updated date formats
                const now = new Date();
                result.date_last_um_check = this.formatDateString(now);
                result.date_last_um_check_epoch = now.getTime();
              }
            }
            
            result.validationSteps.push({
              step: 'zerobounce_check',
              error: zeroBounceResult?.reason?.message || 'Failed or skipped',
              fallbackToDatabase: result.domainValid
            });
          }
          
          console.log('VALIDATION_PROCESS: All validation steps completed successfully', {
            email: quickResult.currentEmail,
            finalStatus: result.status,
            recheckNeeded: result.recheckNeeded,
            clientId: clientId || 'default'
          });
          
          // CRITICAL FIX: Save to Supabase synchronously during validation process
          // This ensures the save completes before the function terminates
          // Only save if the email is valid (saveValidationResult will check this too)
          if (this.supabaseEnabled && result.status === 'valid') {
            try {
              console.log('VALIDATION_PROCESS: Starting synchronous save to Supabase for valid email');
              const saveResult = await this.saveValidationResult(email, result, clientId);
              console.log('VALIDATION_PROCESS: Supabase save completed', { 
                success: saveResult.success,
                operation: saveResult.operation,
                dataId: saveResult.data?.id || 'none',
                clientId: clientId || 'default'
              });
            } catch (saveError) {
              console.error('VALIDATION_PROCESS: Error during synchronous save', {
                error: saveError.message,
                clientId: clientId || 'default'
              });
            }
          } else if (this.supabaseEnabled) {
            console.log('VALIDATION_PROCESS: Skipping save for non-valid email', {
              email: email,
              status: result.status
            });
          }
          
          return result;
        },
        timeoutMs,
        'Validation timeout'
      );
      
      return result;
    } catch (error) {
      console.error('VALIDATION_TIMEOUT:', { 
        message: error.message, 
        email,
        clientId: clientId || 'default'
      });
      console.log('VALIDATION_PROCESS: Using quick validation result as fallback due to timeout');
      
      // Try to save quick result to Supabase synchronously if it's valid
      if (this.supabaseEnabled && quickResult.status === 'valid') {
        try {
          console.log('VALIDATION_PROCESS: Saving fallback result to Supabase');
          await this.saveValidationResult(email, quickResult, clientId);
        } catch (saveError) {
          console.error('VALIDATION_PROCESS: Error saving fallback result', {
            error: saveError.message,
            clientId: clientId || 'default'
          });
        }
      } else if (this.supabaseEnabled) {
        console.log('VALIDATION_PROCESS: Skipping save for fallback non-valid email', {
          email: email,
          status: quickResult.status
        });
      }
      
      // Return quick result on timeout
      return quickResult;
    }
  }
  
  // Batch validation with time budget management - updated to work with async quickValidate
  async validateBatch(emails, options = {}) {
    const { 
      skipZeroBounce = false, 
      timeoutPerEmailMs = 2000,
      clientId = null  // Parameter to track which client made the request
    } = options;
    
    console.log('BATCH_VALIDATION: Starting batch validation', { 
      batchSize: emails.length,
      clientId: clientId || 'default'
    });
    
    const results = [];
    const batchStartTime = Date.now();
    const totalBatchTimeoutMs = Math.min(9000, emails.length * timeoutPerEmailMs);
    
    for (let i = 0; i < emails.length; i++) {
      const email = emails[i];
      
      // Calculate remaining time budget
      const elapsedTime = Date.now() - batchStartTime;
      const remainingTimeMs = totalBatchTimeoutMs - elapsedTime;
      
      // If we're running out of time, use quick validation for remaining emails
      if (remainingTimeMs < timeoutPerEmailMs / 2) {
        console.log('BATCH_VALIDATION: Running out of time, using quick validation for remaining emails', {
          processed: i,
          remaining: emails.length - i,
          remainingTimeMs
        });
        
        // Process remaining emails with quick validation
        for (let j = i; j < emails.length; j++) {
          results.push(await this.quickValidate(emails[j], clientId));
        }
        break;
      }
      
      try {
        // Validate with appropriate timeout
        const result = await this.validateEmail(email, {
          skipZeroBounce,
          timeoutMs: Math.min(remainingTimeMs, timeoutPerEmailMs),
          clientId
        });
        
        results.push(result);
      } catch (error) {
        console.error('BATCH_VALIDATION_ERROR:', {
          email,
          error: error.message,
          clientId: clientId || 'default'
        });
        
        // Fall back to quick validation
        results.push(await this.quickValidate(email, clientId));
      }
    }
    
    console.log('BATCH_VALIDATION: Completed batch validation', {
      batchSize: emails.length,
      resultsCount: results.length,
      clientId: clientId || 'default'
    });
    
    return results;
  }
}